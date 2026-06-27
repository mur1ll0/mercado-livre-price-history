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
          specifications: ann.specifications || [],
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

      const bestOpportunity = scored.find(a => !a.isUnavailable && a.price) || null;
      const productScore = bestOpportunity?.costBenefitScore || 0;
      const productFactors = bestOpportunity?.scoreFactors || [];
      return {
        id: prod._id,
        ...prod,
        rating: avgRating,
        reviewsCount: totalReviews,
        aiSummary: combinedAiSummary,
        announcementsCount: announcements.length,
        announcements: scored,
        bestOpportunity,
        score: productScore,
        scoreFactors: productFactors,
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

  return announcements.map(ann => {
    const annHistory = priceHistoryMap[ann._id] || [];
    if (ann.isUnavailable || !ann.price) {
      return { ...ann, priceHistory: annHistory, costBenefitScore: 0, scoreFactors: [] };
    }

    // Sort history by date ascending (using string comparison on ISO dates YYYY-MM-DD)
    annHistory.sort((a, b) => a.date.localeCompare(b.date));

    // Separate price and installments histories
    const priceHist = ann.type === 'catalog'
      ? annHistory.filter(h => h.offerKey === 'BEST_PRICE')
      : annHistory.filter(h => !h.offerKey);

    const instHist = ann.type === 'catalog'
      ? annHistory.filter(h => h.offerKey === 'BEST_INSTALLMENTS')
      : annHistory.filter(h => !h.offerKey);

    const currentPrice = ann.price;
    const prevPrice = priceHist.length >= 2 ? priceHist[priceHist.length - 2].price : null;

    let priceComponent = 0;
    const priceDetails = [];
    if (prevPrice !== null && currentPrice !== null) {
      if (currentPrice < prevPrice) {
        priceComponent += 20;
        priceDetails.push(`Preço reduziu de R$ ${prevPrice.toLocaleString('pt-BR')} para R$ ${currentPrice.toLocaleString('pt-BR')}`);
      } else if (currentPrice > prevPrice) {
        priceComponent -= 20;
        priceDetails.push(`Preço aumentou de R$ ${prevPrice.toLocaleString('pt-BR')} para R$ ${currentPrice.toLocaleString('pt-BR')}`);
      } else {
        priceDetails.push('Sem alteração recente');
      }
    } else {
      priceDetails.push('Sem histórico recente');
    }
    if (ann.discountPercent && ann.discountPercent > 0) {
      const discountBonus = Math.min(15, ann.discountPercent * 0.6);
      priceComponent += discountBonus;
      priceDetails.push(`${ann.discountPercent}% de desconto (+${discountBonus.toFixed(1)} pts)`);
    }

    const currentInstTotal = ann.installmentsTotal;
    const prevInstTotal = instHist.length >= 2 ? instHist[instHist.length - 2].installmentsTotal : null;

    let installmentComponent = 0;
    const installmentDetails = [];
    if (prevInstTotal !== null && currentInstTotal !== null) {
      if (currentInstTotal < prevInstTotal) {
        installmentComponent += 15;
        installmentDetails.push(`Total parcelado reduziu de R$ ${prevInstTotal.toLocaleString('pt-BR')} para R$ ${currentInstTotal.toLocaleString('pt-BR')}`);
      } else if (currentInstTotal > prevInstTotal) {
        installmentComponent -= 15;
        installmentDetails.push(`Total parcelado aumentou de R$ ${prevInstTotal.toLocaleString('pt-BR')} para R$ ${currentInstTotal.toLocaleString('pt-BR')}`);
      }
    }
    if (ann.interestFree) {
      installmentComponent += 10;
      installmentDetails.push('Parcelamento sem juros (+10 pts)');
    }
    const instMatch = (ann.installmentsText || '').match(/(\d+)x/i);
    let numInstallments = 0;
    if (instMatch) {
      numInstallments = parseInt(instMatch[1], 10);
      if (numInstallments > 1) {
        const instBonus = Math.min(8, numInstallments * 0.4);
        installmentComponent += instBonus;
        installmentDetails.push(`${numInstallments}x no cartão (+${instBonus.toFixed(1)} pts)`);
      }
    }

    // Apply Compensation logic
    let finalPriceComponent = priceComponent;
    let finalInstallmentComponent = installmentComponent;
    let priceCompensated = false;
    let installmentCompensated = false;

    if (priceComponent > 10 && installmentComponent < 0) {
      finalInstallmentComponent = installmentComponent * 0.4;
      installmentCompensated = true;
    }
    if (installmentComponent > 10 && priceComponent < 0) {
      finalPriceComponent = priceComponent * 0.4;
      priceCompensated = true;
    }

    // Build factors list starting with base score 75
    const factors = [
      { label: 'Score Base', value: 75, type: 'neu', text: 'Pontuação inicial padrão' }
    ];

    if (finalPriceComponent !== 0) {
      factors.push({
        label: 'Preço' + (priceCompensated ? ' (Compensado)' : ''),
        value: finalPriceComponent,
        type: finalPriceComponent > 0 ? 'pos' : 'neg',
        text: priceDetails.join(', ')
      });
    }
    if (finalInstallmentComponent !== 0) {
      factors.push({
        label: 'Parcelamento' + (installmentCompensated ? ' (Compensado)' : ''),
        value: finalInstallmentComponent,
        type: finalInstallmentComponent > 0 ? 'pos' : 'neg',
        text: installmentDetails.join(', ')
      });
    }

    // 3. deliveryDate
    let deliveryValue = 0;
    const deliveryDetails = [];
    const scrapedDate = ann.scrapedAt ? new Date(ann.scrapedAt) : new Date();
    const deliveryDate = ann.deliveryDate ? new Date(ann.deliveryDate) : null;
    if (deliveryDate) {
      const diffTime = deliveryDate.getTime() - scrapedDate.getTime();
      const days = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
      if (days <= 2) {
        deliveryValue += 4;
        deliveryDetails.push(`Entrega rápida em ${days} dia(s)`);
      } else if (days === 3) {
        deliveryDetails.push('Entrega em 3 dias');
      } else {
        const delPenalty = Math.min(10, (days - 3) * 1.0);
        deliveryValue -= delPenalty;
        deliveryDetails.push(`Entrega em ${days} dias`);
      }
    } else {
      deliveryValue -= 3;
      deliveryDetails.push('Sem prazo informado');
    }
    if (ann.isFull) {
      deliveryValue += 3;
      deliveryDetails.push('Envio Full (+3 pts)');
    }
    if (deliveryValue !== 0) {
      factors.push({
        label: 'Envio / Prazo',
        value: deliveryValue,
        type: deliveryValue > 0 ? 'pos' : 'neg',
        text: deliveryDetails.join(', ')
      });
    }

    // 4. shippingCost
    let shippingValue = 0;
    const shippingDetails = [];
    if (ann.isFreeShipping) {
      shippingValue += 5;
      shippingDetails.push('Frete Grátis (+5 pts)');
    } else if (ann.shippingCost !== null && ann.shippingCost > 0) {
      shippingValue -= 5;
      shippingDetails.push(`Frete pago de R$ ${ann.shippingCost.toLocaleString('pt-BR')}`);
    }
    if (shippingValue !== 0) {
      factors.push({
        label: 'Custo do Frete',
        value: shippingValue,
        type: shippingValue > 0 ? 'pos' : 'neg',
        text: shippingDetails.join(', ')
      });
    }

    const calculatedScore = 75 + finalPriceComponent + finalInstallmentComponent + deliveryValue + shippingValue;
    const finalScore = Math.max(0, Math.min(100, calculatedScore));

    return {
      ...ann,
      priceHistory: annHistory,
      costBenefitScore: parseFloat(finalScore.toFixed(1)),
      scoreFactors: factors
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

    await updateScrapeStatus(req.user.id, 'running', 'Coletando dados do novo anúncio...');

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
    await updateScrapeStatus(req.user.id, 'running', 'Aguardando extensão para coletar preços...');

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
    await updateScrapeStatus(req.user.id, 'running', 'Aguardando extensão para coletar preços...');

    res.status(202).json({ message: 'Anúncios marcados para coleta. A extensão do navegador irá processá-los.' });
  } catch (err) {
    res.status(500).json({ error: `Erro: ${err.message}` });
  }
});

// Scraping status (polled by frontend to show alerts)
app.get('/api/scrape/status', authenticateToken, async (req, res) => {
  const inMemory = await getScrapeStatus(req.user.id);

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
      await updateScrapeStatus(req.user.id, 'running', `Coletando preços... (${pending} restantes)`);
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
      await updateScrapeStatus(req.user.id, 'done', 'Coleta concluída!');
    } else {
      await updateScrapeStatus(req.user.id, 'running', `Coletando preços... (${remaining} restantes)`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error processing scraped data:', err);
    await updateScrapeStatus(req.user.id, 'error', `Erro: ${err.message}`);
    res.status(500).json({ error: `Erro ao processar dados: ${err.message}` });
  }
});

export { app };
