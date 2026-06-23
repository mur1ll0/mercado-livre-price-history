import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

// Configure Stealth Plugin
puppeteer.use(StealthPlugin());

/**
 * Parses Mercado Livre URL and extracts the unique ID and URL type.
 * @param {string} urlString 
 * @returns {{id: string, type: string}}
 */
export function parseMercadoLivreUrl(urlString) {
  try {
    const url = new URL(urlString);
    
    // 1. Check for catalog path e.g. /p/MLB54106888
    const catalogMatch = url.pathname.match(/\/p\/(MLB\d+)/i);
    if (catalogMatch) {
      return { id: catalogMatch[1].toUpperCase(), type: 'catalog' };
    }

    // 2. Check for seller upgraded path e.g. /up/MLBU3468893823
    const sellerUpgradedMatch = url.pathname.match(/\/up\/(MLBU\d+)/i);
    if (sellerUpgradedMatch) {
      return { id: sellerUpgradedMatch[1].toUpperCase(), type: 'seller-upgraded' };
    }

    // 3. Check for standard seller item page e.g. /MLB-4668926493-... or /MLB4668926493-...
    const itemMatch = url.pathname.match(/\/MLB-?(\d+)/i);
    if (itemMatch) {
      return { id: `MLB${itemMatch[1]}`.toUpperCase(), type: 'item' };
    }

    // Fallback: search for MLB digits in the query parameters or hash
    const anyMlbMatch = urlString.match(/(MLB-?\d+)/i);
    if (anyMlbMatch) {
      return { id: anyMlbMatch[1].replace('-', '').toUpperCase(), type: 'detected' };
    }

    // Generate random fallback to avoid crashes
    const randomId = `MLB${Math.floor(100000000 + Math.random() * 900000000)}`;
    return { id: randomId, type: 'unknown' };
  } catch (err) {
    console.error('[scraper] Error parsing URL:', urlString, err.message);
    const randomId = `MLB${Math.floor(100000000 + Math.random() * 900000000)}`;
    return { id: randomId, type: 'unknown' };
  }
}

/**
 * Scrapes details of a single Mercado Livre announcement.
 * @param {string} url 
 * @returns {Promise<object>}
 */
export async function scrapeMercadoLivre(url) {
  const { id, type } = parseMercadoLivreUrl(url);
  console.log(`[scraper] Starting scrape for Announcement ID: ${id} (${type})`);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Set human-like User-Agent and headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    // Optimize page load by blocking ads and analytics
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const blockedResources = ['font', 'media'];
      const urlString = req.url().toLowerCase();
      
      if (
        blockedResources.includes(resourceType) || 
        urlString.includes('google-analytics') || 
        urlString.includes('doubleclick') || 
        urlString.includes('analytics') || 
        urlString.includes('melidata')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[scraper] Navigating to ${url}...`);
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    const finalUrl = page.url();
    console.log(`[scraper] Navigation complete. Status: ${response ? response.status() : 'No response'}. Final URL: ${finalUrl}`);

    // Wait a brief moment to ensure JS scripts finish setting state (pricing, shipping details)
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Capture HTML
    const html = await page.content();
    const $ = cheerio.load(html);
    
    const bodyText = $('body').text();
    const lowerBodyText = bodyText.toLowerCase();

    // 1. Check if the product or announcement is unavailable/paused/deleted
    let isUnavailable = false;
    if (
      finalUrl.includes('account-verification') || 
      lowerBodyText.includes('acessar sua conta') || 
      lowerBodyText.includes('verificação de segurança')
    ) {
      console.warn('[scraper] WARNING: Blocked by account verification / login wall!');
      throw new Error('Blocked by Mercado Livre bot protection (login wall).');
    }

    if (
      lowerBodyText.includes('anúncio pausado') ||
      lowerBodyText.includes('o vendedor pausou') ||
      lowerBodyText.includes('estoque esgotado') ||
      lowerBodyText.includes('não disponível') ||
      lowerBodyText.includes('não encontramos este produto') ||
      lowerBodyText.includes('página não encontrada') ||
      response?.status() === 404
    ) {
      console.log(`[scraper] Announcement ${id} is marked as unavailable.`);
      isUnavailable = true;
    }

    // 2. Extract Title
    let title = $('.ui-pdp-title').first().text().trim();
    if (!title) {
      title = $('title').text().split('|')[0].trim();
    }
    // Remove clean marketing text from title
    title = title.replace(/\s*\|\s*frete\s*gr\u00e1tis.*/i, '').trim();

    // 3. Extract Categories
    const categories = [];
    $('.ui-pdp-breadcrumb__link, .ui-pdp-breadcrumb__item, .ui-pdp-breadcrumb a').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.toLowerCase() !== 'voltar') {
        categories.push(text);
      }
    });
    // Remove duplicates
    const categoryStr = Array.from(new Set(categories)).join(' > ');

    // 4. Extract Main Image
    let image = '';
    const galleryImg = $('.ui-pdp-gallery__figure img, .ui-pdp-image, .ui-pdp-gallery__figure__container img').first();
    if (galleryImg.length > 0) {
      image = galleryImg.attr('data-zoom') || galleryImg.attr('data-src') || galleryImg.attr('src') || '';
    }

    // 5. Extract Product Rating
    const ratingText = $('.ui-pdp-review__rating').first().text().trim();
    const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

    // 6. Extract Reviews Count
    const reviewsCountText = $('.ui-pdp-review__amount').first().text().trim();
    const reviewsCount = reviewsCountText ? parseInt(reviewsCountText.replace(/\D/g, ''), 10) : 0;

    // 7. Extract AI Summary of Opinions
    const aiSummary = $('.ui-review-capability__summary__plain_text__summary_container, .ui-review-capability__summary__plain_text').first().text().trim();

    // 8. Extract Shipping Info
    // Focus scan on buybox area
    const buyBoxContainer = $('.ui-pdp-container__col.col-1, .ui-pdp-container--column-right, #buybox-form');
    const buyBoxText = buyBoxContainer.length > 0 ? buyBoxContainer.text() : bodyText;
    const lowerBuyBoxText = buyBoxText.toLowerCase();

    const isFreeShipping = lowerBuyBoxText.includes('frete grátis') || lowerBuyBoxText.includes('chegará grátis') || lowerBodyText.includes('frete grátis') || lowerBodyText.includes('chegará grátis');
    
    // Full logistics
    const isFull = html.includes('ui-pdp-icon--full') || html.includes('poly-shipping__promise-icon--full') || html.includes('full-shipping') || lowerBuyBoxText.includes('full');

    const shippingCost = isFreeShipping ? 0 : null; // Can fallback or be enriched later

    // Parse delivery time estimate (e.g. "Chegará grátis amanhã", "Chegará entre amanhã e quinta-feira")
    let deliveryTime = '';
    const deliveryRegex = /(chegará|entrega|chega)\s+(grátis\s+)?(entre\s+[^<\n\.]+|(no\s+)?prazo|amanhã|quinta-feira|sexta-feira|sábado|segunda-feira|terça-feira|quarta-feira|\d+\s+dias|\d+\s+a\s+\d+\s+de\s+\w+|\d+\s+e\s+\d+\s*\/\s*\w+)/i;
    const deliveryMatch = buyBoxText.match(deliveryRegex);
    if (deliveryMatch) {
      deliveryTime = deliveryMatch[0].trim();
      // Clean up excess text
      if (deliveryTime.length > 100) {
        deliveryTime = deliveryTime.substring(0, 100);
      }
    } else {
      // Fallback
      if (lowerBuyBoxText.includes('chegará amanhã')) {
        deliveryTime = 'Chegará amanhã';
      } else if (lowerBuyBoxText.includes('chega amanhã')) {
        deliveryTime = 'Chega amanhã';
      } else {
        deliveryTime = 'Consulte prazos no link';
      }
    }

    // 9. Extract Price
    let price = null;
    let originalPrice = null;

    // Scoped Price Box
    const priceBox = $('.ui-pdp-container__col.col-1 .ui-pdp-price, .ui-pdp-container--column-right .ui-pdp-price, .ui-pdp-price, .ui-pdp-price__part').first();
    
    if (priceBox.length > 0) {
      const fraction = priceBox.find('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '');
      const cents = priceBox.find('.andes-money-amount__cents').first().text().trim();
      if (fraction) {
        price = parseFloat(fraction + (cents ? '.' + cents : ''));
      }
    }

    // Fallback if price is still missing (try matching first price in body)
    if (!price) {
      const fraction = $('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '');
      const cents = $('.andes-money-amount__cents').first().text().trim();
      if (fraction) {
        price = parseFloat(fraction + (cents ? '.' + cents : ''));
      }
    }

    // Scoped Original Price
    const prevPriceBox = $('.ui-pdp-price .andes-money-amount--previous, .ui-pdp-price__part .andes-money-amount--previous').first();
    if (prevPriceBox.length > 0) {
      const fraction = prevPriceBox.find('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '');
      const cents = prevPriceBox.find('.andes-money-amount__cents').first().text().trim();
      if (fraction) {
        originalPrice = parseFloat(fraction + (cents ? '.' + cents : ''));
      }
    }

    // If originalPrice is not found, default to current price
    if (!originalPrice) {
      originalPrice = price;
    }

    // 10. Extract Installments
    let installmentsText = '';
    let interestFree = false;

    // Find installment options in the buy box lines
    const buyBoxLines = buyBoxText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of buyBoxLines) {
      const lowerLine = line.toLowerCase();
      if ((lowerLine.includes('sem juros') || lowerLine.includes('x r$')) && line.length < 150) {
        installmentsText = line;
        break;
      }
    }

    // Fallback: search anywhere on the page
    if (!installmentsText) {
      $('*').each((i, el) => {
        const t = $(el).text().trim();
        const lowerT = t.toLowerCase();
        if ((lowerT.includes('sem juros') || lowerT.includes('x r$')) && t.length < 150 && $(el).children().length === 0) {
          installmentsText = t;
          return false; // Break loop
        }
      });
    }

    interestFree = installmentsText.toLowerCase().includes('sem juros');

    return {
      id,
      url,
      title,
      categoryStr: categoryStr || 'Geral',
      image,
      rating,
      reviewsCount,
      aiSummary: aiSummary || '',
      price,
      originalPrice,
      installmentsText: installmentsText || 'Não informado',
      interestFree,
      isFreeShipping,
      isFull,
      deliveryTime: deliveryTime || 'Prazo não informado',
      shippingCost,
      isUnavailable,
      scrapedAt: new Date().toISOString()
    };

  } catch (err) {
    console.error(`[scraper] Error scraping page ${url}:`, err.message);
    throw err;
  } finally {
    await browser.close();
    console.log('[scraper] Browser closed.');
  }
}
