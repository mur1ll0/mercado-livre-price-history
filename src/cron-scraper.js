import dotenv from 'dotenv';
import mongoose from 'mongoose';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './db.js';
import Announcement from './models/Announcement.js';
import UnifiedProduct from './models/UnifiedProduct.js';
import PriceRecord from './models/PriceRecord.js';
import UserProduct from './models/UserProduct.js';
import Category from './models/Category.js';
import { scrapeMercadoLivre, parseMercadoLivreUrl } from './scraper.js';
import { findMatchingProduct } from './services/ai-matcher.js';
import { updateScrapeStatus } from './services/scrape-status.js';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

dotenv.config();

/**
 * Saves category tree from an array of category path strings.
 * Also ensures parent categories exist.
 */
async function saveCategories(categoryPaths) {
  if (!categoryPaths || !categoryPaths.length) return [];
  const saved = [];
  for (const fullPath of categoryPaths) {
    const parts = fullPath.split(' > ');
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join(' > ');
      try {
        await Category.findOneAndUpdate(
          { _id: subPath },
          { _id: subPath, name: parts[i], parent: i > 0 ? parts.slice(0, i).join(' > ') : null, level: i },
          { upsert: true, new: true }
        );
      } catch (e) { /* ignore duplicate key */ }
    }
    saved.push(fullPath);
  }
  return saved;
}

/**
 * Syncs categories from an announcement to its UnifiedProduct.
 * Adds any new categories not yet referenced by the product.
 */
async function syncProductCategories(productId, announcementCategories) {
  if (!announcementCategories || !announcementCategories.length) return;
  const product = await UnifiedProduct.findById(productId);
  if (!product) return;
  const existing = new Set(product.categories || []);
  let changed = false;
  for (const cat of announcementCategories) {
    if (!existing.has(cat)) { existing.add(cat); changed = true; }
  }
  if (changed) {
    await UnifiedProduct.findByIdAndUpdate(productId, { categories: [...existing] });
  }
}

/**
 * Runs scraping for announcements belonging to a specific user.
 * Called when the user clicks "Atualizar Preços".
 *
 * @param {string} userId - The user's ObjectId
 * @param {string} [specificAnnouncementId] - Optional single announcement ID
 */
export async function runCronScrape(userId, specificAnnouncementId) {
  if (!userId) throw new Error('userId is required for scraping.');
  console.log(`[scraper] Starting scrape for user ${userId}...`);
  await connectDB();

  const todayStr = new Date().toISOString().split('T')[0];
  let announcementsToScrape;

  if (specificAnnouncementId) {
    announcementsToScrape = await Announcement.find({ _id: specificAnnouncementId, userId });
    if (announcementsToScrape.length === 0) {
      // Check if we need to create a skeleton from a URL
      console.warn(`[scraper] Announcement ${specificAnnouncementId} not found for user.`);
      return { success: false, successes: [], failures: [{ id: specificAnnouncementId, error: 'Not found' }] };
    }
  } else {
    announcementsToScrape = await Announcement.find({ userId, isUnavailable: { $ne: true } });
  }

  console.log(`[scraper] Found ${announcementsToScrape.length} active announcements.`);

  // Launch Chromium ONCE for all announcements (persistent profile)
  updateScrapeStatus(userId, 'running', 'Iniciando navegador...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: BROWSER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const successes = [];
  const failures = [];
  // Check login state — try to load the ML homepage
  const loginPage = await browser.newPage();
  await loginPage.setViewport({ width: 1280, height: 800 });
  await loginPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await loginPage.goto('https://www.mercadolivre.com.br', { waitUntil: 'networkidle2', timeout: 30000 });

  // Retry login check a few times — session may take a moment to load
  let isLoggedIn = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    isLoggedIn = await loginPage.evaluate(() => {
      const path = new URL(window.location.href).pathname;
      if (path !== '/' && path !== '') return false;
      const entrarBtn = document.querySelector('a[href*="login" i], a[href*="Entrar" i], [class*="nav-login"]');
      const criarConta = document.querySelector('a[href*="registration" i], a[href*="criar" i]');
      return (!entrarBtn && !criarConta);
    });
    if (isLoggedIn) break;
  }

  if (isLoggedIn) {
    console.log('[scraper] Already logged into Mercado Livre.');
    updateScrapeStatus(userId, 'running', 'Logado no Mercado Livre. Coletando preços...');
  } else {
    updateScrapeStatus(userId, 'needs_login',
      'Faça login na sua conta do Mercado Livre no navegador que abriu. Aguardando...');
    console.log('[scraper] Not logged in. Waiting for login (max 5 min)...');

    // Wait until user is back on ML main page WITHOUT login buttons.
    // While on any auth/login/verification page, just keep waiting silently.
    await loginPage.waitForFunction(() => {
      const path = new URL(window.location.href).pathname;
      // Any subpath = still in login flow → keep waiting
      if (path !== '/' && path !== '') return false;
      // Back on root → logged in only if buttons are gone
      const entrarBtn = document.querySelector('a[href*="login" i], a[href*="Entrar" i], [class*="nav-login"]');
      const criarConta = document.querySelector('a[href*="registration" i], a[href*="criar" i]');
      return !entrarBtn && !criarConta;
    }, { timeout: 300000, polling: 2000 }).catch(() => {
      throw new Error('Login timeout');
    });

    updateScrapeStatus(userId, 'running', 'Login detectado! Coletando preços...');
    console.log('[scraper] Login detected!');
  }

  await loginPage.close().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 2000)); // Let session settle

  console.log('[scraper] Starting scraping...');

  try {
    for (const ann of announcementsToScrape) {
      try {
        console.log(`[scraper] Processing ${ann._id} | ${ann.url}`);
        const scraped = await scrapeMercadoLivre(ann.url, browser);

      if (scraped.isUnavailable) {
        ann.isUnavailable = true;
        ann.title = scraped.title || ann.title;
        ann.scrapedAt = new Date();
        await ann.save();
        continue;
      }

      // Resolve temp product ID if needed
      let targetProductId = ann.productId;
      if (ann.productId.startsWith('temp-')) {
        const match = await findMatchingProduct({
          title: scraped.title,
          categoryStr: scraped.categories?.[scraped.categories.length - 1] || 'Geral',
          specifications: scraped.specifications || []
        });
        if (match.productId) {
          targetProductId = match.productId;
          await UserProduct.deleteOne({ userId: ann.userId, productId: ann.productId }).catch(() => {});
          try {
            await new UserProduct({ userId: ann.userId, productId: targetProductId }).save();
          } catch (e) {
            if (e.code !== 11000) throw e;
          }
          await UnifiedProduct.deleteOne({ _id: ann.productId });
          if (match.unifiedName) {
            await UnifiedProduct.findByIdAndUpdate(targetProductId, { name: match.unifiedName });
          }
        } else {
          const newProduct = new UnifiedProduct({
            name: scraped.title,
            categories: [],
            image: scraped.image || ''
          });
          await newProduct.save();
          targetProductId = newProduct._id;
          await UserProduct.deleteOne({ userId: ann.userId, productId: ann.productId }).catch(() => {});
          try {
            await new UserProduct({ userId: ann.userId, productId: targetProductId }).save();
          } catch (e) {
            if (e.code !== 11000) throw e;
          }
          await UnifiedProduct.deleteOne({ _id: ann.productId });
        }
      } else {
        // Update existing product name if changed
        await UnifiedProduct.findByIdAndUpdate(targetProductId, {
          name: scraped.title,
          image: scraped.image
        });
      }

      // Save categories and sync to product
      await saveCategories(scraped.categories || []);
      await syncProductCategories(targetProductId, scraped.categories || []);

      // Update announcement
      ann.productId = targetProductId;
      ann.title = scraped.title;
      ann.type = scraped.type;
      ann.rating = scraped.rating;
      ann.reviewsCount = scraped.reviewsCount || 0;
      ann.aiSummary = scraped.aiSummary || '';
      ann.categories = scraped.categories || [];
      ann.isUnavailable = false;
      ann.scrapedAt = new Date();

      if (scraped.type === 'catalog') {
        ann.offers = scraped.offers || { BEST_PRICE: null, BEST_INSTALLMENTS: null };
      } else {
        ann.price = scraped.price;
        ann.originalPrice = scraped.originalPrice;
        ann.discountPercent = scraped.discountPercent || 0;
        ann.installmentsText = scraped.installmentsText;
        ann.installmentsTotal = scraped.installmentsTotal;
        ann.interestFree = scraped.interestFree;
        ann.shippingCost = scraped.shippingCost;
        ann.deliveryDate = scraped.deliveryDate;
        ann.isFull = scraped.isFull;
        ann.isFreeShipping = scraped.isFreeShipping;
        ann.seller = scraped.seller;
        ann.offers = { BEST_PRICE: null, BEST_INSTALLMENTS: null };
      }

      await ann.save();

      // Create/update PriceRecord
      if (scraped.type === 'normal' && scraped.price !== null) {
        await PriceRecord.findOneAndUpdate(
          { announcementId: ann._id, date: todayStr },
          {
            productId: targetProductId,
            announcementId: ann._id,
            date: todayStr,
            price: scraped.price,
            installmentsTotal: scraped.installmentsTotal,
            offers: { BEST_PRICE: null, BEST_INSTALLMENTS: null }
          },
          { upsert: true }
        );
        console.log(`[scraper] PriceRecord: ${ann._id} = R$ ${scraped.price}`);
      } else if (scraped.type === 'catalog' && scraped.offers) {
        const offersData = { BEST_PRICE: null, BEST_INSTALLMENTS: null };
        if (scraped.offers.BEST_PRICE?.price) {
          offersData.BEST_PRICE = {
            price: scraped.offers.BEST_PRICE.price,
            installmentsTotal: scraped.offers.BEST_PRICE.installmentsTotal
          };
        }
        if (scraped.offers.BEST_INSTALLMENTS?.price) {
          offersData.BEST_INSTALLMENTS = {
            price: scraped.offers.BEST_INSTALLMENTS.price,
            installmentsTotal: scraped.offers.BEST_INSTALLMENTS.installmentsTotal
          };
        }
        await PriceRecord.findOneAndUpdate(
          { announcementId: ann._id, date: todayStr },
          {
            productId: targetProductId,
            announcementId: ann._id,
            date: todayStr,
            price: scraped.offers.BEST_PRICE?.price || scraped.offers.BEST_INSTALLMENTS?.price || null,
            installmentsTotal: null,
            offers: offersData
          },
          { upsert: true }
        );
        console.log(`[scraper] PriceRecord: ${ann._id} catalog with offers`);
      }

      successes.push({ id: ann._id, status: 'success' });
      await new Promise(resolve => setTimeout(resolve, 4000));

    } catch (err) {
      console.error(`[scraper] Failed ${ann._id}:`, err.message);
      failures.push({ id: ann._id, error: err.message });
      if (ann.title === 'Carregando dados...' || (ann.title && ann.title.includes('Carregando'))) {
        ann.title = 'Falha ao coletar dados (Verifique o Link)';
        await ann.save();
        await UnifiedProduct.findByIdAndUpdate(ann.productId, { name: 'Falha ao coletar dados do Mercado Livre' });
      }
    }
  }

  } finally {
    await browser.close();
    console.log('[scraper] Browser closed.');
    updateScrapeStatus(userId, 'done', 'Coleta concluída!');
  }

  console.log(`[scraper] Done. Successes: ${successes.length}, Failures: ${failures.length}`);
  return { success: true, successes, failures };
}

// Standalone execution (for testing)
const isMain = process.argv[1] && process.argv[1].endsWith('cron-scraper.js');
if (isMain) {
  const userId = process.argv[2];
  const annId = process.argv[3];
  if (!userId) {
    console.error('Usage: node src/cron-scraper.js <userId> [announcementId]');
    process.exit(1);
  }
  runCronScrape(userId, annId || undefined)
    .then(r => { console.log(JSON.stringify(r)); mongoose.disconnect(); process.exit(0); })
    .catch(e => { console.error(e); mongoose.disconnect(); process.exit(1); });
}
