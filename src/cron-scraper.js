import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './db.js';
import Announcement from './models/Announcement.js';
import UnifiedProduct from './models/UnifiedProduct.js';
import PriceRecord from './models/PriceRecord.js';
import UserProduct from './models/UserProduct.js';
import { scrapeMercadoLivre } from './scraper.js';
import { findMatchingProduct } from './services/ai-matcher.js';

// Load environment variables for standalone execution
dotenv.config();

/**
 * Main cron scrape process.
 * Queries all actively tracked announcements, scrapes their latest data, and records history.
 * @param {string} [specificLinkId] optional specific announcement ID to scrape
 */
export async function runCronScrape(specificLinkId) {
  console.log('[cron-scraper] Starting Mercado Livre price update job...');
  
  // Establish connection to database
  await connectDB();

  const todayStr = new Date().toISOString().split('T')[0];
  
  // If specificLinkId is passed via function argument, prioritize it. Otherwise check process argv.
  const targetId = specificLinkId || process.argv[2];
  let announcementsToScrape = [];

  if (targetId) {
    console.log(`[cron-scraper] Standalone mode: Scraping ONLY Announcement ID ${targetId}`);
    announcementsToScrape = await Announcement.find({ _id: targetId });
    if (announcementsToScrape.length === 0) {
      console.warn(`[cron-scraper] Announcement ID ${targetId} not found in database!`);
      
      // Fallback: check if we have a url parameter passed as argv[3]
      const fallbackUrl = process.argv[3];
      if (fallbackUrl) {
        console.log(`[cron-scraper] Creating new skeleton for URL ${fallbackUrl}`);
        announcementsToScrape = [new Announcement({ _id: targetId, url: fallbackUrl, productId: `temp-${Date.now()}` })];
      }
    }
  } else {
    // 1. Get all active announcements (we scrape all listings in the DB that are NOT unavailable)
    // The user requested: "Apenas nao fara a raspagem se o anuncio estiver pausado ou excluido"
    // (Only won't scrape if the announcement is paused or deleted).
    // So we query announcements where isUnavailable is not true.
    announcementsToScrape = await Announcement.find({
      isUnavailable: { $ne: true }
    });
  }

  console.log(`[cron-scraper] Found ${announcementsToScrape.length} active announcements to update.`);

  const successes = [];
  const failures = [];

  for (const ann of announcementsToScrape) {
    try {
      console.log(`[cron-scraper] Processing ${ann._id} | URL: ${ann.url}`);
      
      const scraped = await scrapeMercadoLivre(ann.url);
      
      if (scraped.isUnavailable) {
        console.log(`[cron-scraper] Announcement ${ann._id} has become paused, out of stock, or deleted. Setting isUnavailable = true.`);
        ann.isUnavailable = true;
        ann.title = scraped.title || ann.title;
        ann.scrapedAt = new Date();
        await ann.save();
        successes.push({ id: ann._id, status: 'unavailable' });
        continue;
      }

      // If this announcement is still linked to a temporary product (e.g. from a pending addition),
      // we try to resolve its proper product ID and merge it.
      let targetProductId = ann.productId;
      if (ann.productId.startsWith('temp-')) {
        console.log(`[cron-scraper] Resolving temporary product ID ${ann.productId} for ${ann._id}`);
        const matchedProductId = await findMatchingProduct(scraped);
        
        if (matchedProductId) {
          targetProductId = matchedProductId;
          
          // Re-associate any users tracking the temp product to the matched product
          const userProducts = await UserProduct.find({ productId: ann.productId });
          for (const up of userProducts) {
            try {
              const newUp = new UserProduct({ userId: up.userId, productId: targetProductId });
              await newUp.save();
            } catch (upErr) {
              // Ignore unique collision
            }
          }
          
          // Cleanup temp product and mappings
          await UserProduct.deleteMany({ productId: ann.productId });
          await UnifiedProduct.deleteOne({ _id: ann.productId });
        } else {
          // Promote temp product to a permanent one
          const newProduct = new UnifiedProduct({
            name: scraped.title,
            category: scraped.categoryStr,
            rating: scraped.rating,
            reviewsCount: scraped.reviewsCount,
            aiSummary: scraped.aiSummary,
            image: scraped.image
          });
          await newProduct.save();
          targetProductId = newProduct._id;

          // Update user mapping in DB
          await UserProduct.updateMany({ productId: ann.productId }, { productId: targetProductId });
          await UnifiedProduct.deleteOne({ _id: ann.productId });
        }
      } else {
        // Update the existing UnifiedProduct with fresh scraped data (ratings, reviews count, image, AI summary)
        await UnifiedProduct.findByIdAndUpdate(ann.productId, {
          rating: scraped.rating || undefined,
          reviewsCount: scraped.reviewsCount || undefined,
          aiSummary: scraped.aiSummary || undefined,
          image: scraped.image || undefined
        });
      }

      // Update Announcement details
      ann.productId = targetProductId;
      ann.title = scraped.title;
      ann.price = scraped.price;
      ann.originalPrice = scraped.originalPrice;
      ann.installmentsText = scraped.installmentsText;
      ann.interestFree = scraped.interestFree;
      ann.shippingCost = scraped.shippingCost;
      ann.deliveryTime = scraped.deliveryTime;
      ann.isFull = scraped.isFull;
      ann.isFreeShipping = scraped.isFreeShipping;
      ann.isUnavailable = false;
      ann.scrapedAt = new Date();
      await ann.save();

      // Save daily price record
      if (scraped.price !== null) {
        await PriceRecord.findOneAndUpdate(
          { announcementId: ann._id, date: todayStr },
          { price: scraped.price, originalPrice: scraped.originalPrice },
          { upsert: true }
        );
        console.log(`[cron-scraper] Updated price for ${ann._id}: R$ ${scraped.price}`);
      }

      successes.push({ id: ann._id, status: 'success' });
      
      // Delay to respect site rate limits
      await new Promise(resolve => setTimeout(resolve, 4000));
    } catch (err) {
      console.error(`[cron-scraper] Failed to update announcement ${ann._id}:`, err.message);
      failures.push({ id: ann._id, error: err.message });
      
      // If it's a temp loading announcement that failed, set error text
      if (ann.title === 'Carregando dados...' || ann.title.includes('Carregando dados')) {
        ann.title = 'Falha ao coletar dados (Verifique o Link)';
        await ann.save();
        await UnifiedProduct.updateOne({ _id: ann.productId }, { name: 'Falha ao coletar dados do Mercado Livre' });
      }
    }
  }

  console.log(`[cron-scraper] Job execution complete. Successes: ${successes.length}, Failures: ${failures.length}`);
  return { success: true, successes, failures };
}

// Self-execution hook if run directly (e.g. node src/cron-scraper.js)
const isMain = process.argv[1] && (process.argv[1].endsWith('cron-scraper.js') || process.argv[1].endsWith('cron-scraper'));
if (isMain) {
  runCronScrape()
    .then(async () => {
      console.log('[cron-scraper] Finished job execution.');
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        console.log('[cron-scraper] Database disconnected.');
      }
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[cron-scraper] Standalone script execution failed:', err);
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
      process.exit(1);
    });
}
