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
import { parseMercadoLivreUrl } from './scraper.js';
import { findMatchingProduct } from './services/ai-matcher.js';
import Category from './models/Category.js';
import { saveCategoryTree } from './services/category-helper.js';

const app = express();

app.use(cors());
app.use(express.json());

// Serve static frontend files (Vercel uses public/**/* static rule, but this is fallback for local dev)
app.use(express.static(path.join(process.cwd(), 'public')));

// Middleware: Authenticate JWT Token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token de autenticação ausente. Por favor, faça login novamente.' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'fallback-jwt-secret-key-local', (err, decodedUser) => {
    if (err) {
      return res.status(403).json({ error: 'Sessão expirada ou inválida. Por favor, faça login novamente.' });
    }
    req.user = decodedUser;
    next();
  });
}

// 0. Public config endpoint for frontend configuration
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || ''
  });
});

// 1. Google OAuth Token Verification & Authentication
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'idToken é obrigatório.' });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID não está configurado no servidor.' });
  }

  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId,
    });
    
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;

    // Find or create User
    let user = await User.findOne({ googleId });
    if (!user) {
      user = new User({ googleId, email, name, picture });
      await user.save();
      console.log(`New user created: ${name} (${email})`);
    } else {
      user.name = name;
      user.picture = picture;
      user.email = email;
      await user.save();
    }

    // Generate session JWT token (valid for 7 days)
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET || 'fallback-jwt-secret-key-local',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        picture: user.picture
      }
    });

  } catch (err) {
    console.error('Error during Google authentication:', err);
    res.status(401).json({ error: 'Token do Google inválido ou expirado.' });
  }
});

// 2. Fetch authenticated profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      picture: user.picture
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

// Helper: Calculate Cost-Benefit Scores
function scoreAnnouncements(announcements, histories) {
  // Build a map of announcementId -> priceHistory array
  const priceHistoryMap = {};
  histories.forEach(h => {
    if (!priceHistoryMap[h.announcementId]) {
      priceHistoryMap[h.announcementId] = [];
    }
    priceHistoryMap[h.announcementId].push(h);
  });

  // Find the absolute minimum price across all history and active announcements
  let minPrice = Infinity;
  announcements.forEach(ann => {
    if (ann.price !== null && ann.price < minPrice && !ann.isUnavailable) {
      minPrice = ann.price;
    }
    const history = priceHistoryMap[ann._id] || [];
    history.forEach(h => {
      if (h.price < minPrice) {
        minPrice = h.price;
      }
    });
  });

  if (minPrice === Infinity) minPrice = 0;

  return announcements.map(ann => {
    const history = priceHistoryMap[ann._id] || [];
    
    if (ann.isUnavailable || ann.price === null) {
      return {
        ...ann,
        priceHistory: history.map(h => ({ date: h.date, price: h.price, originalPrice: h.originalPrice, installmentsTotal: h.installmentsTotal })),
        costBenefitScore: 0,
        breakdown: { priceScore: 0, discountScore: 0, shippingScore: 0, installmentScore: 0, ratingScore: 0 }
      };
    }

    // A. Price Score (40% weight)
    let priceScore = 50;
    if (ann.price > 0 && minPrice > 0) {
      priceScore = 100 * (minPrice / ann.price);
    }

    // B. Discount Score (10% weight)
    let discountScore = ann.discountPercent || 0; // 0 to 100

    // C. Shipping Score (20% weight)
    let shippingScore = 0;
    if (ann.isFreeShipping) shippingScore += 50;
    if (ann.isFull) shippingScore += 20;

    const time = (ann.deliveryTime || '').toLowerCase();
    if (time.includes('amanhã') || time.includes('hoje') || time.includes('1 dia') || time.includes('entre amanhã')) {
      shippingScore += 30;
    } else if (time.includes('2 dias') || time.includes('quinta') || time.includes('sexta') || time.includes('23') || time.includes('24')) {
      shippingScore += 20;
    } else if (time.includes('3 dias') || time.includes('4 dias') || time.includes('5 dias') || time.includes('prazo') || time.includes('jul') || time.includes('agosto')) {
      shippingScore += 10;
    }
    if (shippingScore > 100) shippingScore = 100;

    // D. Installment Score (15% weight)
    let installmentScore = ann.interestFree ? 100 : 0;

    // E. Rating Score (15% weight)
    // Rating comes from parent product
    const ratingVal = ann.rating !== undefined && ann.rating !== null ? ann.rating : 4.0;
    let ratingScore = ratingVal * 20;

    // Calculate final weighted score
    const finalScore = (priceScore * 0.40) + (discountScore * 0.10) + (shippingScore * 0.20) + (installmentScore * 0.15) + (ratingScore * 0.15);

    return {
      ...ann,
      priceHistory: history.map(h => ({ date: h.date, price: h.price, originalPrice: h.originalPrice, installmentsTotal: h.installmentsTotal })),
      costBenefitScore: parseFloat(finalScore.toFixed(1)),
      breakdown: {
        priceScore: parseFloat(priceScore.toFixed(1)),
        discountScore: parseFloat(discountScore.toFixed(1)),
        shippingScore: parseFloat(shippingScore.toFixed(1)),
        installmentScore: parseFloat(installmentScore.toFixed(1)),
        ratingScore: parseFloat(ratingScore.toFixed(1))
      }
    };
  }).sort((a, b) => b.costBenefitScore - a.costBenefitScore);
}

// 3. Get user's tracked products with scored announcements (with category filtering)
app.get('/api/products/ranked', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;

    // A. Fetch tracked product IDs for this user
    const userProducts = await UserProduct.find({ userId: req.user.id }).lean();
    const productIds = userProducts.map(up => up.productId);

    // B. Fetch the unified products (filtered by category hierarchy if requested)
    let productQuery = { _id: { $in: productIds } };
    if (category) {
      // Escape regex special chars
      const escapedCategory = category.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      // Match the category path prefix (matches direct category or subcategories)
      productQuery.category = { $regex: new RegExp(`^${escapedCategory}($|\\s*>\\s*)`) };
    }

    const products = await UnifiedProduct.find(productQuery).lean();

    // C. For each product, gather its announcements and price histories
    const rankedProducts = await Promise.all(
      products.map(async (prod) => {
        const announcements = await Announcement.find({ productId: prod._id }).lean();
        const annIds = announcements.map(ann => ann._id);

        const histories = await PriceRecord.find({ announcementId: { $in: annIds } }).sort({ date: 1 }).lean();
        
        // Enrich announcements with ratings from the parent product
        const enrichedAnnouncements = announcements.map(ann => ({
          ...ann,
          rating: prod.rating // Ensure rating is available for CB formula
        }));

        const scoredAnnouncements = scoreAnnouncements(enrichedAnnouncements, histories);

        // Find the best opportunity (highest cost-benefit score announcement)
        const bestDeal = scoredAnnouncements.find(ann => !ann.isUnavailable);
        
        // Calculate average discount percent
        let totalDiscount = 0;
        let activeCount = 0;
        scoredAnnouncements.forEach(ann => {
          if (!ann.isUnavailable && ann.price && ann.originalPrice && ann.originalPrice > ann.price) {
            totalDiscount += ((ann.originalPrice - ann.price) / ann.originalPrice) * 100;
            activeCount++;
          }
        });
        const avgDiscount = activeCount > 0 ? parseFloat((totalDiscount / activeCount).toFixed(1)) : 0;

        return {
          id: prod._id,
          ...prod,
          announcements: scoredAnnouncements,
          bestOpportunity: bestDeal ? { title: bestDeal.title, price: bestDeal.price, score: bestDeal.costBenefitScore } : null,
          avgDiscount
        };
      })
    );

    res.json(rankedProducts);
  } catch (err) {
    console.error('Error fetching ranked products:', err);
    res.status(500).json({ error: 'Erro ao carregar os dados ranqueados.' });
  }
});

// 3.5. Get list of all saved category nodes for UI dropdown
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await Category.find({}).sort({ _id: 1 }).lean();
    res.json(categories);
  } catch (err) {
    console.error('Error fetching category tree:', err);
    res.status(500).json({ error: 'Erro ao carregar categorias.' });
  }
});

// Helper: Trigger GitHub Actions scraper for background processing
async function triggerGitHubScraper(payload) {
  // If running locally (not on Vercel), do not trigger GitHub Actions; use local scraping instead
  if (!process.env.VERCEL) {
    console.log('[github-trigger] Running locally (non-Vercel environment). Skipping GitHub action to run scraper locally.');
    return false;
  }

  if (process.env.GITHUB_PAT && process.env.GITHUB_REPO) {
    try {
      const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_type: payload.type || 'scrape-all',
          client_payload: payload.payload || {}
        })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        console.error('[github-trigger] Dispatch failed:', errText);
        return false;
      }
      console.log(`[github-trigger] Successfully triggered GitHub action: ${payload.type}`);
      return true;
    } catch (err) {
      console.error('[github-trigger] Error calling GitHub API:', err.message);
      return false;
    }
  }
  return false;
}

// 4. Track a new Mercado Livre URL
app.post('/api/products/track', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'A URL do anúncio é obrigatória.' });
  }

  // Basic Mercado Livre URL validation
  if (!url.includes('mercadolivre.com.br') && !url.includes('produto.mercadolivre.com.br')) {
    return res.status(400).json({ 
      error: 'Link inválido! Certifique-se de inserir um link de anúncio do Mercado Livre Brasil.' 
    });
  }

  try {
    const { id: announcementId, type: urlType } = parseMercadoLivreUrl(url);

    // Check if this specific announcement is already in DB
    let announcement = await Announcement.findById(announcementId);

    if (announcement) {
      // Announcement already exists. Ensure user tracks the corresponding UnifiedProduct.
      const existingProductId = announcement.productId;
      
      try {
        const userProduct = new UserProduct({
          userId: req.user.id,
          productId: existingProductId
        });
        await userProduct.save();
      } catch (upErr) {
        if (upErr.code !== 11000) throw upErr; // Ignore duplicate index key error
      }

      const product = await UnifiedProduct.findById(existingProductId);
      return res.status(200).json({
        message: 'Você já está rastreando este produto!',
        product
      });
    }

    // It's a new announcement. Create a pending announcement record first.
    const tempProductId = `temp-${Date.now()}-${Math.random().toString(36).substring(5)}`;
    announcement = new Announcement({
      _id: announcementId,
      productId: tempProductId,
      url,
      title: 'Carregando dados do anúncio...',
      isUnavailable: false
    });
    await announcement.save();

    // Trigger Scraper
    // We check if GitHub token is present. If so, trigger GitHub action. Otherwise, run locally (local dev fallback)
    const githubTriggered = await triggerGitHubScraper({
      type: 'scrape-listing',
      payload: { linkId: announcementId, fallbackUrl: url }
    });

    if (githubTriggered) {
      // Scrape queued on GitHub. Return temporary product structure.
      // We also create a user product relationship
      const userProduct = new UserProduct({
        userId: req.user.id,
        productId: tempProductId
      });
      await userProduct.save();

      // Create a temporary UnifiedProduct so dashboard shows it loading
      const tempProduct = new UnifiedProduct({
        _id: tempProductId,
        name: 'Coletando dados do Mercado Livre...',
        category: 'Geral',
        image: ''
      });
      await tempProduct.save();

      return res.status(202).json({
        message: 'Anúncio adicionado com sucesso! A raspagem foi agendada via GitHub Actions e os dados estarão prontos em instantes.',
        product: tempProduct
      });
    } else {
      // Local dev mode: run scraping asynchronously in the background
      console.log('[api] Running local async scraping for:', announcementId);
      
      // We run it as non-blocking promise
      import('./scraper.js').then(async ({ scrapeMercadoLivre }) => {
        try {
          const scrapedResult = await scrapeMercadoLivre(url);
          const results = Array.isArray(scrapedResult) ? scrapedResult : [scrapedResult];
          
          let mainTargetProductId = null;

          for (let i = 0; i < results.length; i++) {
            const scraped = results[i];
            const currentAnnId = scraped.id;

            if (scraped.isUnavailable) {
              await Announcement.findByIdAndUpdate(currentAnnId, {
                title: scraped.title,
                isUnavailable: true,
                scrapedAt: new Date()
              });
              if (i === 0) {
                await UnifiedProduct.findByIdAndUpdate(tempProductId, {
                  name: `${scraped.title} (Anúncio Indisponível)`
                });
              }
              continue;
            }

            let targetProductId = mainTargetProductId;
            if (!targetProductId) {
              targetProductId = await findMatchingProduct(scraped);
              if (!targetProductId) {
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
              } else {
                await UnifiedProduct.findByIdAndUpdate(targetProductId, {
                  rating: scraped.rating || undefined,
                  reviewsCount: scraped.reviewsCount || undefined,
                  aiSummary: scraped.aiSummary || undefined,
                  image: scraped.image || undefined
                });
              }
              mainTargetProductId = targetProductId;
            }

            await Announcement.findByIdAndUpdate(
              currentAnnId,
              {
                productId: targetProductId,
                url: scraped.url,
                title: scraped.title,
                price: scraped.price,
                originalPrice: scraped.originalPrice,
                discountPercent: scraped.discountPercent || 0,
                installmentsText: scraped.installmentsText,
                installmentsTotal: scraped.installmentsTotal,
                interestFree: scraped.interestFree,
                shippingCost: scraped.shippingCost,
                deliveryTime: scraped.deliveryTime,
                deliveryDate: scraped.deliveryDate,
                isFull: scraped.isFull,
                isFreeShipping: scraped.isFreeShipping,
                seller: scraped.seller || null,
                isUnavailable: false,
                scrapedAt: new Date()
              },
              { upsert: true }
            );

            if (scraped.price !== null) {
              const todayStr = new Date().toISOString().split('T')[0];
              await PriceRecord.findOneAndUpdate(
                { announcementId: currentAnnId, date: todayStr },
                { price: scraped.price, originalPrice: scraped.originalPrice, installmentsTotal: scraped.installmentsTotal },
                { upsert: true }
              );
            }

            try {
              const userProduct = new UserProduct({
                userId: req.user.id,
                productId: targetProductId
              });
              await userProduct.save();
            } catch (upErr) {
              if (upErr.code !== 11000) throw upErr;
            }
          }

          if (mainTargetProductId && tempProductId !== mainTargetProductId) {
            await UserProduct.deleteOne({ userId: req.user.id, productId: tempProductId });
            await UnifiedProduct.deleteOne({ _id: tempProductId });
          }

          console.log(`[api] Local background scraping completed for announcement ${announcementId}`);
        } catch (scrapeErr) {
          console.error(`[api] Local background scraping failed for announcement ${announcementId}:`, scrapeErr.message);
          await Announcement.findByIdAndUpdate(announcementId, { title: 'Falha ao raspar o anúncio (Verifique o Link)' });
          await UnifiedProduct.findByIdAndUpdate(tempProductId, { name: 'Falha ao coletar dados do Mercado Livre' });
        }
      });

      // Link User to the temp product for immediate UI presence
      const userProduct = new UserProduct({
        userId: req.user.id,
        productId: tempProductId
      });
      await userProduct.save();

      // Create a temporary UnifiedProduct
      const tempProduct = new UnifiedProduct({
        _id: tempProductId,
        name: 'Coletando dados do Mercado Livre (Local)...',
        category: 'Geral',
        image: ''
      });
      await tempProduct.save();

      res.status(202).json({
        message: 'Anúncio adicionado localmente! A raspagem está executando em segundo plano.',
        product: tempProduct
      });
    }
  } catch (err) {
    console.error('Error tracking url:', err);
    res.status(500).json({ error: `Erro ao rastrear link: ${err.message}` });
  }
});

// 5. Untrack a product for user
app.delete('/api/products/track/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await UserProduct.findOneAndDelete({ userId: req.user.id, productId: id });
    if (deleted) {
      res.json({ message: 'Produto removido do seu painel com sucesso.' });
    } else {
      res.status(404).json({ error: 'Associação de produto não encontrada.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover produto.' });
  }
});

// 6. Trigger manual update of a specific product's announcements
app.post('/api/products/scrape/:productId', authenticateToken, async (req, res) => {
  const { productId } = req.params;
  try {
    // Verify user tracks this product
    const tracked = await UserProduct.findOne({ userId: req.user.id, productId });
    if (!tracked) {
      return res.status(403).json({ error: 'Acesso negado. Você não acompanha este produto.' });
    }

    const announcements = await Announcement.find({ productId });
    if (announcements.length === 0) {
      return res.status(404).json({ error: 'Nenhum anúncio vinculado a este produto foi encontrado.' });
    }

    const githubTriggered = await triggerGitHubScraper({
      type: 'scrape-all', // Scrapes all actively tracked listings
      payload: {}
    });

    if (githubTriggered) {
      res.json({ message: 'Atualização solicitada! O worker do GitHub Actions foi acionado em segundo plano.' });
    } else {
      // Local dev mode: run scraper for these announcements
      console.log('[api] Triggering local updates for product:', productId);
      import('./cron-scraper.js').then(async ({ runCronScrape }) => {
        for (const ann of announcements) {
          // Skip if unavailable
          if (ann.isUnavailable) continue;
          
          try {
            await runCronScrape(ann._id);
          } catch (err) {
            console.error(`[api] Local update failed for ${ann._id}:`, err.message);
          }
        }
      });
      res.json({ message: 'Atualização local iniciada em segundo plano.' });
    }
  } catch (err) {
    res.status(500).json({ error: `Erro ao acionar atualização: ${err.message}` });
  }
});

// 7. Trigger manual update of ALL active announcements
app.post('/api/products/scrape', authenticateToken, async (req, res) => {
  try {
    const githubTriggered = await triggerGitHubScraper({
      type: 'scrape-all',
      payload: {}
    });

    if (githubTriggered) {
      res.json({ message: 'Sincronização global solicitada no GitHub Actions!' });
    } else {
      console.log('[api] Triggering local global update in background...');
      import('./cron-scraper.js').then(({ runCronScrape }) => {
        runCronScrape().catch(err => console.error('Local background global scrape failed:', err));
      });
      res.json({ message: 'Sincronização global iniciada localmente em segundo plano.' });
    }
  } catch (err) {
    res.status(500).json({ error: `Erro ao iniciar sincronização: ${err.message}` });
  }
});

export { app };
