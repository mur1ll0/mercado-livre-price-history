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
      const baseId = catalogMatch[1].toUpperCase();
      const offerType = url.searchParams.get('offer_type');
      if (offerType && offerType.toUpperCase() === 'BEST_INSTALLMENTS') {
        return { id: `${baseId}_BEST_INSTALLMENTS`, type: 'catalog' };
      }
      return { id: baseId, type: 'catalog' };
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

const monthMap = {
  jan: 0, janeiro: 0,
  fev: 1, fevereiro: 1,
  mar: 2, março: 2, marco: 2,
  abr: 3, abril: 3,
  mai: 4, maio: 4,
  jun: 5, junho: 5,
  jul: 6, julho: 6,
  ago: 7, agosto: 7,
  set: 8, setembro: 8,
  out: 9, outubro: 9,
  nov: 10, novembro: 10,
  dez: 11, dezembro: 11
};

function cleanInstallments(text) {
  if (!text || text === 'Não informado') return 'Não informado';
  
  const match = text.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
  if (match) {
    let clean = match[1].trim();
    clean = clean.replace(/\s+/g, ' ');
    if (text.toLowerCase().includes('sem juros') && !clean.toLowerCase().includes('sem juros')) {
      clean += ' sem juros';
    } else if (text.toLowerCase().includes('com juros') && !clean.toLowerCase().includes('sem juros')) {
      clean += ' com juros';
    }
    return clean;
  }
  return text;
}

function calculateInstallmentsTotal(installmentsText, fallbackPrice) {
  if (!installmentsText) return fallbackPrice;
  const match = installmentsText.match(/(\d+)\s*x\s*(?:R\$\s*)?(\d+(?:[.,]\d+)?)/i);
  if (match) {
    const qty = parseInt(match[1], 10);
    const val = parseFloat(match[2].replace(',', '.'));
    if (!isNaN(qty) && !isNaN(val)) {
      return parseFloat((qty * val).toFixed(2));
    }
  }
  return fallbackPrice;
}

const dayOfWeekMap = {
  domingo: 0,
  'segunda-feira': 1, segunda: 1,
  'terça-feira': 2, terça: 2, terca: 2,
  'quarta-feira': 3, quarta: 3,
  'quinta-feira': 4, quinta: 4,
  'sexta-feira': 5, sexta: 5,
  sábado: 6, sabado: 6
};

function parseDeliveryDate(text) {
  if (!text) return null;
  
  // Clean up any retire/retirar options on the lines, and split by newline
  const cleanLines = text
    .replace(/(?:retire|retirar)[^\n\.]*/gi, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  const today = new Date();
  const currentYear = today.getFullYear();
  let maxDate = null;

  for (const line of cleanLines) {
    const cleanText = line.toLowerCase();
    
    // Ensure the line is actually talking about delivery/shipping
    if (!/(chegará|chega|entrega|receba|envio|chegar)/i.test(cleanText)) {
      continue;
    }

    let datesFound = [];

    // 1. Check for 'hoje'
    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?hoje/i.test(cleanText)) {
      const date = new Date(today);
      datesFound.push(date);
    }

    // 2. Check for 'amanhã'
    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?amanhã/i.test(cleanText)) {
      const date = new Date(today);
      date.setDate(today.getDate() + 1);
      datesFound.push(date);
    }

    // 3. Check for specific days of the week
    const dayRegex = /(domingo|segunda-feira|segunda|terça-feira|terça|terca|quarta-feira|quarta|quinta-feira|quinta|sexta-feira|sexta|sábado|sabado)/gi;
    let match;
    while ((match = dayRegex.exec(cleanText)) !== null) {
      const targetDayOfWeek = dayOfWeekMap[match[1].toLowerCase()];
      const todayDayOfWeek = today.getDay();
      let diff = targetDayOfWeek - todayDayOfWeek;
      if (diff <= 0) diff += 7;
      const date = new Date(today);
      date.setDate(today.getDate() + diff);
      datesFound.push(date);
    }

    // 4. Check for range date (e.g. 30/jun e 2/jul or 23 e 24/jul)
    const rangeMatch = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s*(?:de\s*)?\/?[a-z]*\s+(?:e|a)\s+(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
    if (rangeMatch) {
      const day = parseInt(rangeMatch[2], 10);
      const monthIndex = monthMap[rangeMatch[3].substring(0, 3)] ?? today.getMonth();
      let year = currentYear;
      if (monthIndex < today.getMonth()) year += 1;
      const date = new Date(year, monthIndex, day);
      datesFound.push(date);
    } else {
      const rangeMatchSame = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s+(?:e|a)\s+(\d+)\s*\/([a-zçãõ]+)/i);
      if (rangeMatchSame) {
        const day = parseInt(rangeMatchSame[2], 10);
        const monthIndex = monthMap[rangeMatchSame[3].substring(0, 3)] ?? today.getMonth();
        let year = currentYear;
        if (monthIndex < today.getMonth()) year += 1;
        const date = new Date(year, monthIndex, day);
        datesFound.push(date);
      } else {
        const singleMatch = cleanText.match(/(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
        if (singleMatch) {
          const day = parseInt(singleMatch[1], 10);
          const monthIndex = monthMap[singleMatch[2].substring(0, 3)] ?? today.getMonth();
          let year = currentYear;
          if (monthIndex < today.getMonth()) year += 1;
          const date = new Date(year, monthIndex, day);
          datesFound.push(date);
        } else {
          const genericMatch = cleanText.match(/(\d+)\/(\d+)/);
          if (genericMatch) {
            const day = parseInt(genericMatch[1], 10);
            const monthIndex = parseInt(genericMatch[2], 10) - 1;
            let year = currentYear;
            if (monthIndex < today.getMonth()) year += 1;
            const date = new Date(year, monthIndex, day);
            datesFound.push(date);
          }
        }
      }
    }

    for (const date of datesFound) {
      date.setHours(0,0,0,0);
      if (!maxDate || date > maxDate) {
        maxDate = date;
      }
    }
  }

  return maxDate;
}

/**
 * Extracts numerical price from a Cheerio element representing a price.
 * @param {object} $ 
 * @param {object} element 
 * @returns {number|null}
 */
function parseMoneyAmount($, element) {
  if (!element || element.length === 0) return null;
  const fraction = element.find('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '');
  const cents = element.find('.andes-money-amount__cents').first().text().trim();
  if (fraction) {
    return parseFloat(fraction + (cents ? '.' + cents : ''));
  }
  return null;
}

/**
 * Scrapes details of a single Mercado Livre announcement.
 * @param {string} url 
 * @returns {Promise<object>}
 */
async function scrapePage(page, url) {
  const { id, type } = parseMercadoLivreUrl(url);
  console.log(`[scraper] Scraping page: ${url} (ID: ${id})`);
  
  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const finalUrl = page.url();
  await new Promise(resolve => setTimeout(resolve, 4000));
  
  const html = await page.content();
  const $ = cheerio.load(html);
  
  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();

  let isUnavailable = false;
  if (
    finalUrl.includes('account-verification') || 
    finalUrl.includes('suspicious_traffic') ||
    lowerBodyText.includes('acessar sua conta') || 
    lowerBodyText.includes('acesse sua conta') || 
    lowerBodyText.includes('acessesua conta') || 
    lowerBodyText.includes('verificação de segurança') ||
    lowerBodyText.includes('verificacao de seguranca') ||
    lowerBodyText.includes('não sou um robô') ||
    lowerBodyText.includes('não sou um robo') ||
    lowerBodyText.includes('trace-id') ||
    $('title').text().trim().toLowerCase() === 'mercado livre' ||
    $('title').text().trim().toLowerCase() === 'mercado libre'
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

  let title = $('.ui-pdp-title').first().text().trim();
  if (!title) {
    title = $('title').text().split('|')[0].trim();
  }
  title = title.replace(/\s*\|\s*frete\s*gr\u00e1tis.*/i, '').trim();

  const categories = [];
  $('.ui-pdp-breadcrumb__link, .ui-pdp-breadcrumb__item, .ui-pdp-breadcrumb a').each((i, el) => {
    const text = $(el).text().trim();
    if (text && text.toLowerCase() !== 'voltar') {
      categories.push(text);
    }
  });
  const categoryStr = Array.from(new Set(categories)).join(' > ');

  let image = '';
  const galleryImg = $('.ui-pdp-gallery__figure img, .ui-pdp-image, .ui-pdp-gallery__figure__container img').first();
  if (galleryImg.length > 0) {
    image = galleryImg.attr('data-zoom') || galleryImg.attr('data-src') || galleryImg.attr('src') || '';
  }

  const ratingText = $('.ui-pdp-review__rating').first().text().trim();
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

  const reviewsCountText = $('.ui-pdp-review__amount').first().text().trim();
  const reviewsCount = reviewsCountText ? parseInt(reviewsCountText.replace(/\D/g, ''), 10) : 0;

  const aiSummary = $('.ui-review-capability__summary__plain_text__summary_container, .ui-review-capability__summary__plain_text').first().text().trim();

  const buyBoxContainer = $('.ui-pdp-container__col.col-1, .ui-pdp-container--column-right, #buybox-form');
  const buyBoxText = buyBoxContainer.length > 0 ? buyBoxContainer.text() : bodyText;
  const lowerBuyBoxText = buyBoxText.toLowerCase();

  const isFreeShipping = lowerBuyBoxText.includes('frete grátis') || lowerBuyBoxText.includes('chegará grátis') || lowerBodyText.includes('frete grátis') || lowerBodyText.includes('chegará grátis');
  const isFull = html.includes('ui-pdp-icon--full') || html.includes('poly-shipping__promise-icon--full') || html.includes('full-shipping') || lowerBuyBoxText.includes('full');
  const shippingCost = isFreeShipping ? 0 : null;

  let deliveryTime = '';
  const deliveryRegex = /(chegará|entrega|chega)\s+(grátis\s+)?(entre\s+[^<\n\.]+|(no\s+)?prazo|amanhã|quinta-feira|sexta-feira|sábado|segunda-feira|terça-feira|quarta-feira|\d+\s+dias|\d+\s+a\s+\d+\s+de\s+\w+|\d+\s+e\s+\d+\s*\/\s*\w+)/i;
  const deliveryMatch = buyBoxText.match(deliveryRegex);
  if (deliveryMatch) {
    deliveryTime = deliveryMatch[0].trim();
    if (deliveryTime.length > 100) {
      deliveryTime = deliveryTime.substring(0, 100);
    }
  } else {
    if (lowerBuyBoxText.includes('chegará amanhã')) {
      deliveryTime = 'Chegará amanhã';
    } else if (lowerBuyBoxText.includes('chega amanhã')) {
      deliveryTime = 'Chega amanhã';
    } else {
      deliveryTime = 'Consulte prazos no link';
    }
  }

  // Price Parsing
  let price = null;
  let originalPrice = null;

  const mainPriceContainer = $('.ui-pdp-container__col.col-1 .ui-pdp-price, .ui-pdp-container--column-right .ui-pdp-price, .ui-pdp-price, .ui-pdp-price__part').first();
  if (mainPriceContainer.length > 0) {
    const originalPriceEl = mainPriceContainer.find('.ui-pdp-price__original-value .andes-money-amount, .andes-money-amount--previous, del .andes-money-amount, s .andes-money-amount').first();
    if (originalPriceEl.length > 0) {
      originalPrice = parseMoneyAmount($, originalPriceEl);
    }

    const secondLineEl = mainPriceContainer.find('.ui-pdp-price__second-line').first();
    if (secondLineEl.length > 0) {
      const currentPriceEl = secondLineEl.find('.andes-money-amount').not('.andes-money-amount--previous').first();
      if (currentPriceEl.length > 0) {
        price = parseMoneyAmount($, currentPriceEl);
      }
    }

    if (price === null) {
      mainPriceContainer.find('.andes-money-amount').each((i, el) => {
        const isPrev = $(el).hasClass('andes-money-amount--previous') || $(el).closest('s, del, .ui-pdp-price__original-value').length > 0;
        const isSubtitle = $(el).closest('.ui-pdp-price__subtitles, .ui-pdp-price__installments, .ui-pdp-price__hint').length > 0;
        
        if (!isSubtitle) {
          const amt = parseMoneyAmount($, $(el));
          if (amt !== null) {
            if (isPrev) {
              if (originalPrice === null) originalPrice = amt;
            } else {
              if (price === null) {
                price = amt;
              }
            }
          }
        }
      });
    }
  }

  if (price === null) {
    $('.andes-money-amount').each((i, el) => {
      let isPoly = false;
      let current = $(el);
      while (current.length > 0) {
        const className = current.attr('class') || '';
        if (className.includes('poly-') || className.includes('recommendation') || className.includes('carousel')) {
          isPoly = true;
          break;
        }
        current = current.parent();
      }

      if (!isPoly) {
        const amt = parseMoneyAmount($, $(el));
        const isPrev = $(el).hasClass('andes-money-amount--previous') || $(el).closest('s, del').length > 0;
        const isSubtitle = $(el).closest('.ui-pdp-price__subtitles, .ui-pdp-price__installments, .ui-pdp-price__hint').length > 0;
        if (amt !== null && !isSubtitle) {
          if (isPrev) {
            if (originalPrice === null) originalPrice = amt;
          } else {
            price = amt;
            return false;
          }
        }
      }
    });
  }

  if (originalPrice === null) {
    originalPrice = price;
  }
  if (originalPrice && price && originalPrice < price) {
    originalPrice = price;
  }

  let parsedDiscount = 0;
  if (mainPriceContainer.length > 0) {
    const discountEl = mainPriceContainer.find('.ui-pdp-price__discount, .ui-pdp-discount, .ui-pdp-price__second-line__label').first();
    if (discountEl.length > 0) {
      const discountText = discountEl.text().trim();
      const match = discountText.match(/(\d+)\s*%\s*OFF/i);
      if (match) {
        parsedDiscount = parseInt(match[1], 10);
      }
    }
  }
  if (!parsedDiscount && originalPrice && price && originalPrice > price) {
    parsedDiscount = Math.round(((originalPrice - price) / originalPrice) * 100);
  }
  const discountPercent = parsedDiscount || 0;

  // Installments
  let installmentsText = '';
  let interestFree = false;

  if (mainPriceContainer.length > 0) {
    const subtitleEl = mainPriceContainer.find('.ui-pdp-price__subtitles').first();
    if (subtitleEl.length > 0) {
      const text = subtitleEl.text().replace(/\s+/g, ' ').trim();
      if (/\d+\s*x\s*/i.test(text)) {
        installmentsText = text;
      }
    }
  }

  if (!installmentsText) {
    const installmentSelectors = [
      '.ui-pdp-price__installments',
      '.ui-pdp-payment__title',
      '.ui-pdp-payment__method'
    ];
    for (const selector of installmentSelectors) {
      $(selector).each((i, el) => {
        let isPoly = false;
        let current = $(el);
        while (current.length > 0) {
          const className = current.attr('class') || '';
          if (className.includes('poly-') || className.includes('recommendation') || className.includes('carousel') || className.includes('sponsored')) {
            isPoly = true;
            break;
          }
          current = current.parent();
        }
        if (!isPoly) {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (/\d+\s*x\s*R\$\s*\d+/i.test(text) && text.length < 120) {
            installmentsText = text;
            return false;
          }
        }
      });
      if (installmentsText) break;
    }
  }

  if (!installmentsText) {
    // Try Outras opções de compra box
    const otherOptionsSelectors = [
      '.ui-pdp-other-buying-options',
      '.ui-pdp-buybox__other-buying-options',
      '.ui-pdp-other-options',
      '.ui-pdp-other-buying-options-list-item'
    ];
    for (const selector of otherOptionsSelectors) {
      const otherBox = $(selector);
      if (otherBox.length > 0) {
        const text = otherBox.text().replace(/\s+/g, ' ').trim();
        const match = text.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?)/i);
        if (match) {
          installmentsText = match[1].trim() + ' com juros';
          break;
        }
      }
    }
  }

  if (!installmentsText) {
    $('*').each((i, el) => {
      if ($(el).children().length === 0) {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (/\d+\s*x\s*R\$\s*\d+/i.test(text) && text.length < 120) {
          let isPoly = false;
          let current = $(el);
          while (current.length > 0) {
            const className = current.attr('class') || '';
            if (className.includes('poly-') || className.includes('recommendation') || className.includes('carousel') || className.includes('sponsored')) {
              isPoly = true;
              break;
            }
            current = current.parent();
          }
          if (!isPoly) {
            installmentsText = text;
            return false;
          }
        }
      }
    });
  }

  installmentsText = cleanInstallments(installmentsText);

  if (installmentsText && installmentsText !== 'Não informado') {
    interestFree = installmentsText.toLowerCase().includes('sem juros');
  } else {
    let hasInterestFreeBanner = false;
    $('.ui-pdp-media__title, .ui-pdp-payment__method').each((i, el) => {
      const text = $(el).text().toLowerCase();
      if (text.includes('sem juros') && !text.includes('poly')) {
        hasInterestFreeBanner = true;
      }
    });
    interestFree = hasInterestFreeBanner;
  }

  const installmentsTotal = calculateInstallmentsTotal(installmentsText, price);
  const deliveryDate = parseDeliveryDate(deliveryTime);

  if (!isUnavailable && (!title || title.trim() === '' || price === null)) {
    console.warn(`[scraper] WARNING: Scraping returned empty title or null price for active announcement ID ${id}. Title: "${title}", Price: ${price}.`);
    throw new Error('Failed to parse valid product data (possible block or failed load).');
  }

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
    discountPercent,
    installmentsText: installmentsText || 'Não informado',
    installmentsTotal,
    interestFree,
    isFreeShipping,
    isFull,
    deliveryTime: deliveryTime || 'Prazo não informado',
    deliveryDate,
    shippingCost,
    isUnavailable,
    scrapedAt: new Date().toISOString()
  };
}

export async function scrapeMercadoLivre(url) {
  const parsed = parseMercadoLivreUrl(url);
  console.log(`[scraper] Starting browser for URL: ${url} (ID: ${parsed.id}, Type: ${parsed.type})`);
  
  const browser = await puppeteer.launch({
    headless: 'shell',
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

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

    // 1. Scrape the primary URL
    const mainResult = await scrapePage(page, url);

    // 2. If it is a catalog page and URL does not have offer_type=BEST_INSTALLMENTS,
    // scrape the BEST_INSTALLMENTS variation as well
    if (parsed.type === 'catalog' && !url.includes('offer_type=BEST_INSTALLMENTS')) {
      console.log('[scraper] Catalog page detected. Attempting to scrape BEST_INSTALLMENTS offer type...');
      try {
        const installmentsUrlObj = new URL(url);
        installmentsUrlObj.searchParams.set('offer_type', 'BEST_INSTALLMENTS');
        const installmentsUrl = installmentsUrlObj.toString();

        const installmentsResult = await scrapePage(page, installmentsUrl);
        
        // Return both scraped variations
        return [mainResult, installmentsResult];
      } catch (err) {
        console.error('[scraper] Failed to scrape BEST_INSTALLMENTS variation:', err.message);
        // Fallback to just the main result
        return mainResult;
      }
    }

    return mainResult;

  } catch (err) {
    console.error(`[scraper] Error scraping page ${url}:`, err.message);
    throw err;
  } finally {
    await browser.close();
    console.log('[scraper] Browser closed.');
  }
}
