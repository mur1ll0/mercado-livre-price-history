import express from 'express';
import cors from 'cors';
import path from 'path';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { connectDB } from './db.js';
import User from './models/User.js';
import UnifiedProduct from './models/UnifiedProduct.js';
import Announcement from './models/Announcement.js';
import PriceRecord from './models/PriceRecord.js';
import UserProduct from './models/UserProduct.js';
import Category from './models/Category.js';
import { parseMercadoLivreUrl } from './scraper.js';
import { getScrapeStatus, updateScrapeStatus } from './services/scrape-status.js';
import { findMatchingProduct } from './services/ai-matcher.js';

const app = express();

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${res.statusCode} ${req.method} ${req.originalUrl} - ${ms}ms`);
  });
  next();
});

app.use(express.static(path.join(process.cwd(), 'public')));

// Middleware: Authenticate JWT Token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token de autenticação ausente. Por favor, faça login novamente.' });
  jwt.verify(token, process.env.JWT_SECRET || 'fallback-jwt-secret-key-local', (err, decodedUser) => {
    if (err) return res.status(403).json({ error: 'Sessão expirada ou inválida. Por favor, faça login novamente.' });
    req.user = decodedUser;
    next();
  });
}

// Public config
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// Google OAuth
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken é obrigatório.' });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID não configurado.' });

  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    let user = await User.findOne({ googleId });
    if (!user) {
      user = new User({ googleId, email, name, picture });
      await user.save();
    } else {
      user.name = name; user.picture = picture; user.email = email;
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET || 'fallback-jwt-secret-key-local',
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, name, email, picture } });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Token do Google inválido ou expirado.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ id: user._id, name: user.name, email: user.email, picture: user.picture });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

// Helper: filter productIds in categories list
async function filterProductIdsByCategory(productIds, category) {
  if (!category) return productIds;
  const escaped = category.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const catDocs = await Category.find({ _id: { $regex: new RegExp(`^${escaped}($|\\s*>\\s*)`) } }).lean();
  const catIds = new Set(catDocs.map(c => c._id));

  // Find products that have at least one category matching
  const products = await UnifiedProduct.find({
    _id: { $in: productIds },
    categories: { $in: [...catIds] }
  }).lean();
  return products.map(p => p._id);
}

// Get user's tracked products with announcements and price history
app.get('/api/products/ranked', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const userProducts = await UserProduct.find({ userId: req.user.id }).lean();
    const productIds = userProducts.map(up => up.productId);

    let filteredIds = await filterProductIdsByCategory(productIds, category);
    const products = await UnifiedProduct.find({ _id: { $in: filteredIds } }).lean();

    const rankedProducts = await Promise.all(products.map(async (prod) => {
      const announcements = await Announcement.find({ productId: prod._id, userId: req.user.id }).lean();

      // PriceRecords now use the real announcementId (no composite suffixes)
      // For catalog types, a single record contains offers.BEST_PRICE and offers.BEST_INSTALLMENTS
      const annIds = announcements.map(a => a._id);
      const allRecords = await PriceRecord.find({ announcementId: { $in: annIds } }).sort({ date: 1 }).lean();

      // Build history map: for catalogs, split offers into virtual announcement histories
      const histories = [];
      allRecords.forEach(rec => {
        if (rec.offers?.BEST_PRICE && rec.offers.BEST_PRICE.price) {
          histories.push({
            announcementId: rec.announcementId,
            offerKey: 'BEST_PRICE',
            date: rec.date, price: rec.offers.BEST_PRICE.price,
            installmentsTotal: rec.offers.BEST_PRICE.installmentsTotal
          });
        }
        if (rec.offers?.BEST_INSTALLMENTS && rec.offers.BEST_INSTALLMENTS.price) {
          histories.push({
            announcementId: rec.announcementId,
            offerKey: 'BEST_INSTALLMENTS',
            date: rec.date, price: rec.offers.BEST_INSTALLMENTS.price,
            installmentsTotal: rec.offers.BEST_INSTALLMENTS.installmentsTotal
          });
        }
        if (!rec.offers || (!rec.offers.BEST_PRICE?.price && !rec.offers.BEST_INSTALLMENTS?.price)) {
          histories.push({
            announcementId: rec.announcementId,
            date: rec.date, price: rec.price,
            installmentsTotal: rec.installmentsTotal
          });
        }
      });

      // Keep catalog announcements as single entries with offers intact
      const flatAnnouncements = announcements.map(ann => {
        const base = {
          _id: ann._id,
          productId: ann.productId,
          url: ann.url || '',
          title: ann.title,
          type: ann.type,
          rating: ann.rating,
          reviewsCount: ann.reviewsCount,
          aiSummary: ann.aiSummary,
          categories: ann.categories,
          isUnavailable: ann.isUnavailable,
          scrapedAt: ann.scrapedAt,
          offers: ann.offers || null,
        };

        if (ann.type === 'catalog' && ann.offers) {
          const bestPrice = ann.offers.BEST_PRICE?.price || null;
          const bestInstallments = ann.offers.BEST_INSTALLMENTS || null;
          return {
            ...base,
            price: bestPrice,
            originalPrice: ann.offers.BEST_PRICE?.originalPrice || null,
            discountPercent: ann.offers.BEST_PRICE?.discountPercent || 0,
            installmentsText: bestInstallments?.installmentsText || '',
            installmentsTotal: bestInstallments?.installmentsTotal || null,
            interestFree: bestInstallments?.interestFree || false,
            shippingCost: ann.offers.BEST_PRICE?.shippingCost || null,
            deliveryDate: ann.offers.BEST_PRICE?.deliveryDate || null,
            isFull: ann.offers.BEST_PRICE?.isFull || false,
            isFreeShipping: ann.offers.BEST_PRICE?.isFreeShipping || false,
            seller: ann.offers.BEST_PRICE?.seller || null,
          };
        }
        return { ...base, ...ann, offers: null };
      });

      // Score announcements
      const scored = scoreAnnouncements(flatAnnouncements, histories);

      // Average rating from all announcements that have one
      const ratedAnns = announcements.filter(a => a.rating != null);
      const avgRating = ratedAnns.length > 0
        ? parseFloat((ratedAnns.reduce((sum, a) => sum + a.rating, 0) / ratedAnns.length).toFixed(1))
        : null;
      const totalReviews = ratedAnns.reduce((sum, a) => sum + (a.reviewsCount || 0), 0);
      const combinedAiSummary = ratedAnns.find(a => a.aiSummary)?.aiSummary || '';

      return {
        id: prod._id,
        ...prod,
        rating: avgRating,
        reviewsCount: totalReviews,
        aiSummary: combinedAiSummary,
        announcementsCount: announcements.length,
        announcements: scored,
        bestOpportunity: scored.find(a => !a.isUnavailable && a.price) || null,
      };
    }));

    res.json(rankedProducts);
  } catch (err) {
    console.error('Error fetching ranked products:', err);
    res.status(500).json({ error: 'Erro ao carregar os dados.' });
  }
});

function scoreAnnouncements(announcements, histories) {
  const priceHistoryMap = {};
  histories.forEach(h => {
    if (!priceHistoryMap[h.announcementId]) priceHistoryMap[h.announcementId] = [];
    priceHistoryMap[h.announcementId].push(h);
  });

  let minPrice = Infinity;
  announcements.forEach(ann => {
    if (ann.price && ann.price < minPrice && !ann.isUnavailable) minPrice = ann.price;
    (priceHistoryMap[ann._id] || []).forEach(h => { if (h.price < minPrice) minPrice = h.price; });
  });
  if (minPrice === Infinity) minPrice = 0;

  return announcements.map(ann => {
    const history = priceHistoryMap[ann._id] || [];
    if (ann.isUnavailable || !ann.price) {
      return { ...ann, priceHistory: history, costBenefitScore: 0 };
    }
    const priceScore = minPrice > 0 ? Math.min(100, 100 * (minPrice / ann.price)) : 50;
    const discountScore = ann.discountPercent || 0;
    let shippingScore = (ann.isFreeShipping ? 50 : 0) + (ann.isFull ? 20 : 0);
    const time = (ann.deliveryDate || '').toString().toLowerCase();
    if (time.includes('amanhã') || time.includes('hoje')) shippingScore += 30;
    else if (time.includes('2 dias') || time.includes('sexta') || time.includes('sábado')) shippingScore += 20;
    shippingScore = Math.min(100, shippingScore);
    const installmentScore = ann.interestFree ? 100 : 0;
    const ratingScore = (ann.rating || 4.0) * 20;
    const final = priceScore * 0.40 + discountScore * 0.10 + shippingScore * 0.20 + installmentScore * 0.15 + ratingScore * 0.15;

    return {
      ...ann,
      priceHistory: history,
      costBenefitScore: parseFloat(final.toFixed(1))
    };
  }).sort((a, b) => b.costBenefitScore - a.costBenefitScore);
}

app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await Category.find({}).sort({ _id: 1 }).lean();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar categorias.' });
  }
});

// Track a new Mercado Livre URL
app.post('/api/products/track', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL do anúncio é obrigatória.' });
  if (!url.includes('mercadolivre.com.br') && !url.includes('produto.mercadolivre.com.br')) {
    return res.status(400).json({ error: 'Link inválido! Insira um link do Mercado Livre Brasil.' });
  }

  try {
    const { id: announcementId, type } = parseMercadoLivreUrl(url);

    // Clean URL: remove offer_type param and hash (scraper manages these)
    let cleanUrl = url;
    try {
      const u = new URL(url);
      u.searchParams.delete('offer_type');
      u.hash = '';
      cleanUrl = u.toString();
    } catch (e) { /* keep original */ }

    let announcement = await Announcement.findById(announcementId);
    if (announcement) {
      // Already exists - ensure user is tracking it
      try {
        await new UserProduct({ userId: req.user.id, productId: announcement.productId }).save();
      } catch (upErr) {
        if (upErr.code !== 11000) throw upErr;
      }
      const product = await UnifiedProduct.findById(announcement.productId);
      return res.status(200).json({ message: 'Você já está rastreando este produto!', product });
    }

    // Create skeleton announcement
    const tempProductId = `temp-${Date.now()}-${Math.random().toString(36).substring(5)}`;
    announcement = new Announcement({
      _id: announcementId,
      userId: req.user.id,
      productId: tempProductId,
      url: cleanUrl,
      title: 'Carregando dados...',
      type,
      isUnavailable: false,
      scrapeStatus: 'pending'
    });
    await announcement.save();

    await new UserProduct({ userId: req.user.id, productId: tempProductId }).save();

    const tempProduct = new UnifiedProduct({
      _id: tempProductId,
      name: 'Coletando dados do Mercado Livre...',
      categories: [],
      image: ''
    });
    await tempProduct.save();

    updateScrapeStatus(req.user.id, 'running', 'Coletando dados do novo anúncio...');

    res.status(202).json({
      message: 'Anúncio adicionado! A coleta de dados será iniciada automaticamente.',
      product: tempProduct
    });
  } catch (err) {
    console.error('Error tracking url:', err);
    res.status(500).json({ error: `Erro ao rastrear link: ${err.message}` });
  }
});

// Untrack a product
app.delete('/api/products/track/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await UserProduct.findOneAndDelete({ userId: req.user.id, productId: id });
    if (deleted) res.json({ message: 'Produto removido com sucesso.' });
    else res.status(404).json({ error: 'Produto não encontrado.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover produto.' });
  }
});

// Detects if running on Vercel (serverless) or local
const isVercel = !!process.env.VERCEL;

// Shared helper: saves categories and syncs them to the product
async function saveAndSyncCategories(announcementCategories, productId) {
  if (!announcementCategories || !announcementCategories.length) return;
  for (const fullPath of announcementCategories) {
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
  }
  const product = await UnifiedProduct.findById(productId);
  if (product) {
    const existing = new Set(product.categories || []);
    let changed = false;
    for (const cat of announcementCategories) {
      if (!existing.has(cat)) { existing.add(cat); changed = true; }
    }
    if (changed) {
      await UnifiedProduct.findByIdAndUpdate(productId, { categories: [...existing] });
    }
  }
}

// Shared: process scraped data and save to DB (used by both extension API and cron-scraper)
async function processScrapedAnnouncement(ann, scraped, userId) {
  const todayStr = new Date().toISOString().split('T')[0];

  if (scraped.isUnavailable) {
    ann.isUnavailable = true;
    ann.title = scraped.title || ann.title;
    ann.scrapeStatus = 'done';
    ann.scrapedAt = new Date();
    await ann.save();
    return;
  }

  let targetProductId = ann.productId;
  if (ann.productId.startsWith('temp-')) {
    const match = await findMatchingProduct({
      title: scraped.title,
      categoryStr: scraped.categories?.[scraped.categories.length - 1] || 'Geral',
      specifications: scraped.specifications || []
    });
    if (match.productId) {
      targetProductId = match.productId;
      // User already tracks this product via another UserProduct — just delete the temp
      await UserProduct.deleteOne({ userId: ann.userId, productId: ann.productId }).catch(() => {});
      try {
        await new UserProduct({ userId: ann.userId, productId: targetProductId }).save();
      } catch (e) {
        if (e.code !== 11000) throw e;
        // Already tracking — fine
      }
      await UnifiedProduct.deleteOne({ _id: ann.productId });
      // Update unified product name if LLM suggested one
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
    await UnifiedProduct.findByIdAndUpdate(targetProductId, {
      name: scraped.title,
      image: scraped.image
    });
  }

  await saveAndSyncCategories(scraped.categories || [], targetProductId);

  ann.productId = targetProductId;
  ann.title = scraped.title;
  ann.type = scraped.type;
  ann.rating = scraped.rating;
  ann.reviewsCount = scraped.reviewsCount || 0;
  ann.aiSummary = scraped.aiSummary || '';
  ann.categories = scraped.categories || [];
  ann.specifications = scraped.specifications || [];
  ann.isUnavailable = false;
  ann.scrapeStatus = 'done';
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
  }
}

// Trigger scraping for a specific product's announcements
app.post('/api/products/scrape/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  try {
    const tracked = await UserProduct.findOne({ userId: req.user.id, productId });
    if (!tracked) return res.status(403).json({ error: 'Acesso negado.' });

    const announcements = await Announcement.find({ productId, userId: req.user.id });
    if (announcements.length === 0) return res.status(404).json({ error: 'Nenhum anúncio encontrado.' });

    await Announcement.updateMany(
      { productId, userId: req.user.id, isUnavailable: { $ne: true } },
      { scrapeStatus: 'pending' }
    );
    updateScrapeStatus(req.user.id, 'running', 'Aguardando extensão para coletar preços...');

    res.status(202).json({ message: 'Anúncios marcados para coleta. A extensão do navegador irá processá-los.' });
  } catch (err) {
    res.status(500).json({ error: `Erro: ${err.message}` });
  }
});

// Trigger scraping for ALL user's announcements
app.post('/api/products/scrape', authenticateToken, async (req, res) => {
  try {
    await Announcement.updateMany(
      { userId: req.user.id, isUnavailable: { $ne: true } },
      { scrapeStatus: 'pending' }
    );
    updateScrapeStatus(req.user.id, 'running', 'Aguardando extensão para coletar preços...');

    res.status(202).json({ message: 'Anúncios marcados para coleta. A extensão do navegador irá processá-los.' });
  } catch (err) {
    res.status(500).json({ error: `Erro: ${err.message}` });
  }
});

// Scraping status (polled by frontend to show alerts)
app.get('/api/scrape/status', authenticateToken, async (req, res) => {
  const inMemory = getScrapeStatus(req.user.id);

  // If done, keep showing done (don't auto-convert to idle - frontend needs to see it)
  if (inMemory.state === 'done') {
    return res.json(inMemory);
  }

  if (inMemory.state === 'error') {
    const pending = await Announcement.countDocuments({ userId: req.user.id, scrapeStatus: 'pending' });
    if (pending > 0) return res.json({ state: 'running', message: `Coletando preços... (${pending} restantes)`, updatedAt: new Date() });
    return res.json(inMemory);
  }

  if (inMemory.state === 'idle') {
    const pending = await Announcement.countDocuments({ userId: req.user.id, scrapeStatus: 'pending' });
    if (pending > 0) {
      updateScrapeStatus(req.user.id, 'running', `Coletando preços... (${pending} restantes)`);
      return res.json({ state: 'running', message: `Coletando preços... (${pending} restantes)`, updatedAt: new Date() });
    }
  }

  res.json(inMemory);
});

// Extension API: list pending scrape jobs for the authenticated user
app.get('/api/scrape/jobs', authenticateToken, async (req, res) => {
  try {
    const announcements = await Announcement.find({
      userId: req.user.id,
      scrapeStatus: 'pending',
      isUnavailable: { $ne: true }
    }).lean();

    const jobs = announcements.map(ann => ({
      announcementId: ann._id,
      url: ann.url,
      type: ann.type
    }));

    res.json({ jobs });
  } catch (err) {
    console.error('Error fetching scrape jobs:', err);
    res.status(500).json({ error: 'Erro ao buscar jobs de scraping.' });
  }
});

// Extension API: receive scraped data from the browser extension
app.post('/api/scrape/data', authenticateToken, async (req, res) => {
  const { announcementId, data } = req.body;
  if (!announcementId || !data) {
    return res.status(400).json({ error: 'announcementId e data são obrigatórios.' });
  }

  try {
    const ann = await Announcement.findOne({ _id: announcementId, userId: req.user.id });
    if (!ann) return res.status(404).json({ error: 'Anúncio não encontrado.' });

    await processScrapedAnnouncement(ann, data, req.user.id);

    const remaining = await Announcement.countDocuments({ userId: req.user.id, scrapeStatus: 'pending' });
    if (remaining === 0) {
      updateScrapeStatus(req.user.id, 'done', 'Coleta concluída!');
    } else {
      updateScrapeStatus(req.user.id, 'running', `Coletando preços... (${remaining} restantes)`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error processing scraped data:', err);
    updateScrapeStatus(req.user.id, 'error', `Erro: ${err.message}`);
    res.status(500).json({ error: `Erro ao processar dados: ${err.message}` });
  }
});

export { app };
