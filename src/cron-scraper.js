import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './db.js';
import Announcement from './models/Announcement.js';
import UnifiedProduct from './models/UnifiedProduct.js';
import PriceRecord from './models/PriceRecord.js';
import UserProduct from './models/UserProduct.js';
import { scrapeMercadoLivre } from './scraper.js';
import { findMatchingProduct } from './services/ai-matcher.js';
import { saveCategoryTree } from './services/category-helper.js';

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
      
      const scrapedResult = await scrapeMercadoLivre(ann.url);
      const results = Array.isArray(scrapedResult) ? scrapedResult : [scrapedResult];
      
      for (const scraped of results) {
        const currentAnnId = scraped.id;
        
        let currentAnn = await Announcement.findById(currentAnnId);
        if (!currentAnn) {
          currentAnn = new Announcement({
            _id: currentAnnId,
            productId: ann.productId,
            url: scraped.url
          });
        }

        if (scraped.isUnavailable) {
          console.log(`[cron-scraper] Announcement ${currentAnnId} has become paused, out of stock, or deleted. Setting isUnavailable = true.`);
          currentAnn.isUnavailable = true;
          currentAnn.title = scraped.title || currentAnn.title;
          currentAnn.scrapedAt = new Date();
          await currentAnn.save();
          continue;
        }

        let targetProductId = currentAnn.productId;
        if (currentAnn.productId.startsWith('temp-')) {
          console.log(`[cron-scraper] Resolving temporary product ID ${currentAnn.productId} for ${currentAnnId}`);
          const matchedProductId = await findMatchingProduct(scraped);
          
          if (matchedProductId) {
            targetProductId = matchedProductId;
            
            const userProducts = await UserProduct.find({ productId: currentAnn.productId });
            for (const up of userProducts) {
              try {
                const newUp = new UserProduct({ userId: up.userId, productId: targetProductId });
                await newUp.save();
              } catch (upErr) {
                // Ignore unique collision
              }
            }
            
            await UserProduct.deleteMany({ productId: currentAnn.productId });
            await UnifiedProduct.deleteOne({ _id: currentAnn.productId });
          } else {
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

            await UserProduct.updateMany({ productId: currentAnn.productId }, { productId: targetProductId });
            await UnifiedProduct.deleteOne({ _id: currentAnn.productId });
          }
        } else {
          await UnifiedProduct.findByIdAndUpdate(currentAnn.productId, {
            rating: scraped.rating || undefined,
            reviewsCount: scraped.reviewsCount || undefined,
            aiSummary: scraped.aiSummary || undefined,
            image: scraped.image || undefined
          });
        }

        currentAnn.productId = targetProductId;
        currentAnn.title = scraped.title;
        currentAnn.price = scraped.price;
        currentAnn.originalPrice = scraped.originalPrice;
        currentAnn.discountPercent = scraped.discountPercent || 0;
        currentAnn.installmentsText = scraped.installmentsText;
        currentAnn.installmentsTotal = scraped.installmentsTotal;
        currentAnn.interestFree = scraped.interestFree;
        currentAnn.shippingCost = scraped.shippingCost;
        currentAnn.deliveryTime = scraped.deliveryTime;
        currentAnn.deliveryDate = scraped.deliveryDate;
        currentAnn.isFull = scraped.isFull;
        currentAnn.isFreeShipping = scraped.isFreeShipping;
        currentAnn.seller = scraped.seller || null;
        currentAnn.isUnavailable = false;
        currentAnn.scrapedAt = new Date();
        await currentAnn.save();

        if (scraped.categoryStr) {
          await saveCategoryTree(scraped.categoryStr);
        }

        if (scraped.price !== null) {
          await PriceRecord.findOneAndUpdate(
            { announcementId: currentAnnId, date: todayStr },
            { price: scraped.price, originalPrice: scraped.originalPrice, installmentsTotal: scraped.installmentsTotal },
            { upsert: true }
          );
          console.log(`[cron-scraper] Updated price for ${currentAnnId}: R$ ${scraped.price}`);
        }
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
