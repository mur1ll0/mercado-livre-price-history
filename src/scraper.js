import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

puppeteer.use(StealthPlugin());

// ============================================================
// LISTING TYPES SUPPORTED
// ============================================================
//
// 1. CATALOG / OFFER-TYPE  (e.g. /p/MLB54106888)
//    - Product catalog page with multiple seller offers
//    - Has #buybox-form containing a <ul> with offer <li> items
//    - Requires scraping with offer_type filters:
//      ?offer_type=BEST_PRICE        -> extracts best-price offer
//      ?offer_type=BEST_INSTALLMENTS -> extracts best-installment offer
//    - The selected <li> (has "SELECTED" indicator) contains:
//      price, installments, shipping cost, delivery, seller
//    - Fallback: if no installment info, navigate to /s? URL
//      to find the seller's installment terms in the listing table
//
// 2. NORMAL LISTING  (e.g. /MLB... or /up/MLBU...)
//    - Standard single-seller product page
//    - #buybox-form contains shipping cost, delivery, seller
//    - div#price has meta[itemprop="price"] for current price
//    - data-andes-money-amount-discount attribute for discount
//    - p#pricing_price_subtitle for installment info
//    - "Vendido por" text for seller name
//    - "Full"/"armazenado e enviado pelo Full" for shipping type
//
// ============================================================

// ============================================================
// SECTION 1: URL PARSER
// ============================================================

/**
 * Parses a Mercado Livre URL and extracts the unique ID and URL type.
 *
 * Supported URL patterns:
 *   Catalog:    /p/MLB54106888[?offer_type=BEST_PRICE|BEST_INSTALLMENTS]
 *   Normal:     /MLB-4668926493-... or /up/MLBU3468893823
 *
 * @param {string} urlString
 * @returns {{id: string, type: 'catalog'|'seller-upgraded'|'item'|'detected'|'unknown'}}
 */
export function parseMercadoLivreUrl(urlString) {
  try {
    const url = new URL(urlString);

    // Catalog path: /p/MLB54106888
    const catalogMatch = url.pathname.match(/\/p\/(MLB\d+)/i);
    if (catalogMatch) {
      const baseId = catalogMatch[1].toUpperCase();
      const offerType = url.searchParams.get('offer_type');
      if (offerType) {
        const upper = offerType.toUpperCase();
        if (upper === 'BEST_INSTALLMENTS') {
          return { id: `${baseId}_BEST_INSTALLMENTS`, type: 'catalog' };
        }
        if (upper === 'BEST_PRICE') {
          return { id: `${baseId}_BEST_PRICE`, type: 'catalog' };
        }
      }
      return { id: baseId, type: 'catalog' };
    }

    // Seller upgraded path: /up/MLBU3468893823
    const sellerUpgradedMatch = url.pathname.match(/\/up\/(MLBU\d+)/i);
    if (sellerUpgradedMatch) {
      return { id: sellerUpgradedMatch[1].toUpperCase(), type: 'seller-upgraded' };
    }

    // Standard item page: /MLB-4668926493-... or /MLB4668926493-...
    const itemMatch = url.pathname.match(/\/MLB-?(\d+)/i);
    if (itemMatch) {
      return { id: `MLB${itemMatch[1]}`.toUpperCase(), type: 'item' };
    }

    // Fallback: search for MLB digits anywhere in the URL string
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
 * Builds the "see more listings" URL for a catalog page.
 * Inserts /s into the path before the query string.
 *
 * E.g.:
 *   /apple-airpods-pro-3/p/MLB54106888?pdp_filters=...&sid=...
 *   -> /apple-airpods-pro-3/p/MLB54106888/s?pdp_filters=...&sid=...
 */
function buildCatalogSearchUrl(originalUrl) {
  try {
    const url = new URL(originalUrl);
    // Remove offer_type from search params (s? page shows all offers)
    url.searchParams.delete('offer_type');
    url.pathname = url.pathname + '/s';
    url.hash = '';
    return url.toString();
  } catch {
    return originalUrl;
  }
}

// ============================================================
// SECTION 2: MONEY & DATE HELPERS
// ============================================================

/**
 * Cleans delivery text by truncating at natural boundaries.
 */
function cleanDeliveryText(text) {
  if (!text) return '';
  // Remove concatenated words (missing spaces between sentences)
  text = text.replace(/([a-zà-ú])([A-ZÀ-Ú])/g, '$1 $2');
  // Truncate at common endpoints
  const truncateAt = [
    'Mais detalhes', 'Formas de entrega', 'Retirar', 'Ver mais',
    'por ser sua primeira compra', 'Saiba mais', 'Ver detalhes',
  ];
  for (const marker of truncateAt) {
    const idx = text.indexOf(marker);
    if (idx > 0) {
      text = text.substring(0, idx).trim();
      break;
    }
  }
  if (text.length > 100) {
    text = text.substring(0, 100);
  }
  return text;
}

const monthMap = {
  jan: 0, janeiro: 0,
  fev: 1, fevereiro: 1,
  mar: 2, 'março': 2, marco: 2,
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

const dayOfWeekMap = {
  domingo: 0,
  'segunda-feira': 1, segunda: 1,
  'terça-feira': 2, 'terça': 2, terca: 2,
  'quarta-feira': 3, quarta: 3,
  'quinta-feira': 4, quinta: 4,
  'sexta-feira': 5, sexta: 5,
  'sábado': 6, sabado: 6
};

/**
 * Extracts numerical price from a Cheerio element representing an Andes money-amount.
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
 * Parses a raw text price string like "R$ 1.234,56" into a number.
 */
function parsePriceFromText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

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

function parseDeliveryDate(text) {
  if (!text) return null;

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

    if (!/(chegará|chega|entrega|receba|envio|chegar)/i.test(cleanText)) {
      continue;
    }

    let datesFound = [];

    // 'hoje'
    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?hoje/i.test(cleanText)) {
      const date = new Date(today);
      datesFound.push(date);
    }

    // 'amanhã'
    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?amanhã/i.test(cleanText)) {
      const date = new Date(today);
      date.setDate(today.getDate() + 1);
      datesFound.push(date);
    }

    // Day of week
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

    // Range: "30/jun e 2/jul" or "23 e 24/jul"
    const rangeMatch = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s*(?:de\s*)?\/?[a-z]*\s+(?:e|a)\s+(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
    if (rangeMatch) {
      const day = parseInt(rangeMatch[2], 10);
      const monthIndex = monthMap[rangeMatch[3].substring(0, 3)] ?? today.getMonth();
      let year = currentYear;
      if (monthIndex < today.getMonth()) year += 1;
      datesFound.push(new Date(year, monthIndex, day));
    } else {
      const rangeMatchSame = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s+(?:e|a)\s+(\d+)\s*\/([a-zçãõ]+)/i);
      if (rangeMatchSame) {
        const day = parseInt(rangeMatchSame[2], 10);
        const monthIndex = monthMap[rangeMatchSame[3].substring(0, 3)] ?? today.getMonth();
        let year = currentYear;
        if (monthIndex < today.getMonth()) year += 1;
        datesFound.push(new Date(year, monthIndex, day));
      } else {
        const singleMatch = cleanText.match(/(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
        if (singleMatch) {
          const day = parseInt(singleMatch[1], 10);
          const monthIndex = monthMap[singleMatch[2].substring(0, 3)] ?? today.getMonth();
          let year = currentYear;
          if (monthIndex < today.getMonth()) year += 1;
          datesFound.push(new Date(year, monthIndex, day));
        } else {
          const genericMatch = cleanText.match(/(\d+)\/(\d+)/);
          if (genericMatch) {
            const day = parseInt(genericMatch[1], 10);
            const monthIndex = parseInt(genericMatch[2], 10) - 1;
            let year = currentYear;
            if (monthIndex < today.getMonth()) year += 1;
            datesFound.push(new Date(year, monthIndex, day));
          }
        }
      }
    }

    for (const date of datesFound) {
      date.setHours(0, 0, 0, 0);
      if (!maxDate || date > maxDate) {
        maxDate = date;
      }
    }
  }

  return maxDate;
}

// ============================================================
// SECTION 3: COMMON FIELD EXTRACTION
// ============================================================
// These fields are present on BOTH listing types

/**
 * Extracts fields common to all Mercado Livre listing types.
 */
function extractCommonFields($, html) {
  // ---- Title ----
  let title = $('.ui-pdp-title').first().text().trim();
  if (!title) {
    title = $('title').text().split('|')[0].trim();
  }
  title = title.replace(/\s*\|\s*frete\s*grátis.*/i, '').trim();

  // ---- Category breadcrumbs ----
  const categories = [];
  $('.ui-pdp-breadcrumb__link, .ui-pdp-breadcrumb__item, .ui-pdp-breadcrumb a').each((i, el) => {
    const text = $(el).text().trim();
    if (text && text.toLowerCase() !== 'voltar') {
      categories.push(text);
    }
  });
  const categoryStr = Array.from(new Set(categories)).join(' > ');

  // ---- Image ----
  let image = '';
  const galleryImg = $('.ui-pdp-gallery__figure img, .ui-pdp-image, .ui-pdp-gallery__figure__container img').first();
  if (galleryImg.length > 0) {
    image = galleryImg.attr('data-zoom') || galleryImg.attr('data-src') || galleryImg.attr('src') || '';
  }

  // ---- Rating (score) ----
  const ratingText = $('.ui-pdp-review__rating').first().text().trim();
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

  // ---- Reviews count ----
  const reviewsCountText = $('.ui-pdp-review__amount').first().text().trim();
  const reviewsCount = reviewsCountText ? parseInt(reviewsCountText.replace(/\D/g, ''), 10) : 0;

  // ---- AI review summary ----
  const aiSummary = $('.ui-review-capability__summary__plain_text__summary_container, .ui-review-capability__summary__plain_text').first().text().trim();

  return { title, categoryStr: categoryStr || 'Geral', image, rating, reviewsCount, aiSummary: aiSummary || '' };
}

// ============================================================
// SECTION 4: NORMAL LISTING SCRAPER
// ============================================================
// Handles /MLB... and /up/MLBU... standard product pages.
//
// Data sources:
//   - Price:       meta[itemprop="price"] inside div#price
//   - Discount:    data-andes-money-amount-discount attribute near price
//   - Installments: p#pricing_price_subtitle
//   - Shipping:    #buybox-form (cost, delivery time, Full indicator)
//   - Seller:      "Vendido por" text in #buybox-form

function scrapeNormalListing($, html) {
  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();

  const buyBoxContainer = $('.ui-pdp-container__col.col-1, .ui-pdp-container--column-right, #buybox-form');
  const buyBoxText = buyBoxContainer.length > 0 ? buyBoxContainer.text() : bodyText;
  const lowerBuyBoxText = buyBoxText.toLowerCase();

  // ---- Price ----
  // Strategy 1: meta[itemprop="price"] inside #price div (new approach)
  let price = null;
  const priceDiv = $('#price');
  if (priceDiv.length > 0) {
    const priceMeta = priceDiv.find('meta[itemprop="price"]');
    if (priceMeta.length > 0) {
      const contentVal = parseFloat(priceMeta.attr('content'));
      if (!isNaN(contentVal) && contentVal > 0) {
        price = contentVal;
      }
    }
  }

  // ---- Discount ----
  // Strategy 1: data-andes-money-amount-discount attribute (new approach)
  let originalPrice = null;
  let discountPercent = 0;

  if (price !== null && priceDiv.length > 0) {
    // Look for discount badge near price
    const discountEl = priceDiv.find('[data-andes-money-amount-discount]');
    if (discountEl.length > 0) {
      const discountText = discountEl.attr('data-andes-money-amount-discount') || discountEl.text().trim();
      const match = discountText.match(/(\d+)%/);
      if (match) {
        discountPercent = parseInt(match[1], 10);
        if (discountPercent > 0 && price > 0) {
          originalPrice = parseFloat((price / (1 - discountPercent / 100)).toFixed(2));
        }
      }
    } else {
      // Fallback: check for standard discount selectors
      const discountSpan = priceDiv.find('.ui-pdp-price__discount, .ui-pdp-discount, .ui-pdp-price__second-line__label');
      if (discountSpan.length > 0) {
        const text = discountSpan.text().trim();
        const match = text.match(/(\d+)\s*%\s*OFF/i);
        if (match) {
          discountPercent = parseInt(match[1], 10);
          if (discountPercent > 0 && price > 0) {
            originalPrice = parseFloat((price / (1 - discountPercent / 100)).toFixed(2));
          }
        }
      }
    }
  }

  // ---- Price fallback: existing strategies (when #price meta not found) ----
  if (price === null) {
    const mainPriceContainer = $('.ui-pdp-container__col.col-1 .ui-pdp-price, .ui-pdp-container--column-right .ui-pdp-price, .ui-pdp-price, .ui-pdp-price__part').first();
    if (mainPriceContainer.length > 0) {
      // Try original price
      const originalPriceEl = mainPriceContainer.find('.ui-pdp-price__original-value .andes-money-amount, .andes-money-amount--previous, del .andes-money-amount, s .andes-money-amount').first();
      if (originalPriceEl.length > 0) {
        originalPrice = parseMoneyAmount($, originalPriceEl);
      }

      // Try current price from second line
      const secondLineEl = mainPriceContainer.find('.ui-pdp-price__second-line').first();
      if (secondLineEl.length > 0) {
        const currentPriceEl = secondLineEl.find('.andes-money-amount').not('.andes-money-amount--previous').first();
        if (currentPriceEl.length > 0) {
          price = parseMoneyAmount($, currentPriceEl);
        }
      }

      // Fallback: iterate all money amounts in main container
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
                if (price === null) price = amt;
              }
            }
          }
        });
      }
    }

    // Global fallback
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
  }

  // ---- Price normalization ----
  if (originalPrice === null && price !== null) {
    originalPrice = price;
  }
  if (originalPrice && price && originalPrice < price) {
    originalPrice = price;
  }

  // ---- Discount fallback (calculate from price difference) ----
  if (discountPercent === 0 && originalPrice && price && originalPrice > price) {
    discountPercent = Math.round(((originalPrice - price) / originalPrice) * 100);
  }

  // ---- Installments ----
  // Strategy 1: p#pricing_price_subtitle (new approach)
  let installmentsText = '';
  const pricingSubtitle = $('#pricing_price_subtitle');
  if (pricingSubtitle.length > 0) {
    const text = pricingSubtitle.text().replace(/\s+/g, ' ').trim();
    if (/\d+\s*x\s*/i.test(text)) {
      installmentsText = text;
    }
  }

  // Strategy 2: .ui-pdp-price__subtitles (existing)
  if (!installmentsText) {
    const mainPriceContainer = $('.ui-pdp-container__col.col-1 .ui-pdp-price, .ui-pdp-container--column-right .ui-pdp-price, .ui-pdp-price, .ui-pdp-price__part').first();
    if (mainPriceContainer.length > 0) {
      const subtitleEl = mainPriceContainer.find('.ui-pdp-price__subtitles').first();
      if (subtitleEl.length > 0) {
        const text = subtitleEl.text().replace(/\s+/g, ' ').trim();
        if (/\d+\s*x\s*/i.test(text)) {
          installmentsText = text;
        }
      }
    }
  }

  // Strategy 3: explicit installment selectors
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

  // Strategy 4: other buying options box
  if (!installmentsText) {
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

  // Strategy 5: scan all text nodes
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

  // ---- Interest-free detection ----
  let interestFree = false;
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

  // ---- Shipping type ----
  // Only mark as Full if there's a specific Full shipping indicator.
  // Avoid false positives from generic "full" in other text.
  let isFreeShipping = lowerBuyBoxText.includes('frete grátis') || lowerBuyBoxText.includes('chegará grátis') || lowerBodyText.includes('frete grátis') || lowerBodyText.includes('chegará grátis');
  let isFull =
    html.includes('ui-pdp-icon--full') ||
    html.includes('poly-shipping__promise-icon--full') ||
    html.includes('full-shipping') ||
    lowerBuyBoxText.includes('armazenado e enviado pelo full') ||
    lowerBuyBoxText.includes('enviado pelo full') ||
    lowerBuyBoxText.includes('pelo full') ||
    lowerBuyBoxText.includes('por full');

  // Extract actual shipping cost
  let shippingCost = isFreeShipping ? 0 : null;
  if (!isFreeShipping && buyBoxContainer.length > 0) {
    // Look for shipping cost in buybox text: "Frete R$ 12,34" or similar
    const shipCostMatch = buyBoxText.match(/(?:frete|envio)[^R$]*?(R\$\s*[\d.,]+)/i);
    if (shipCostMatch) {
      shippingCost = parsePriceFromText(shipCostMatch[1]);
    } else {
      // Check for shipping cost in Andes money-amount inside shipping section
      const shipContainer = buyBoxContainer.find('.ui-pdp-shipping, .ui-pdp-buybox__shipping, .andes-shipping-calculator');
      if (shipContainer.length > 0) {
        const shipMoneyEl = shipContainer.find('.andes-money-amount').first();
        if (shipMoneyEl.length > 0) {
          shippingCost = parseMoneyAmount($, shipMoneyEl);
        }
      }
    }
  }

  // ---- Delivery time ----
  let deliveryTime = '';
  const deliveryRegex = /(?:chegará|entrega|chega)\s+(?:grátis\s+)?(?:entre\s+[^<\n\.]+|(?:no\s+)?prazo|amanhã|quinta-feira|sexta-feira|sábado|segunda-feira|terça-feira|quarta-feira|\d+\s+dias|\d+\s+a\s+\d+\s+de\s+\w+|\d+\s+e\s+\d+\s*\/\s*\w+|até\s+(?:dia\s+)?\d+\s*\/?\s*\w*)/i;
  const deliveryMatch = buyBoxText.match(deliveryRegex);
  if (deliveryMatch) {
    deliveryTime = cleanDeliveryText(deliveryMatch[0].trim());
  } else {
    if (lowerBuyBoxText.includes('chegará amanhã')) {
      deliveryTime = 'Chegará amanhã';
    } else if (lowerBuyBoxText.includes('chega amanhã')) {
      deliveryTime = 'Chega amanhã';
    } else {
      deliveryTime = 'Consulte prazos no link';
    }
  }

  // ---- Seller ----
  let seller = null;
  // Look for "Vendido por" or "Por" followed by seller name in buybox
  const soldByMatch = buyBoxText.match(/(?:vendido|compra)\s+por\s+([A-ZÀ-Ú][^\n|\.]+?)(?:\s*\||\s*$)/i);
  if (soldByMatch) {
    seller = soldByMatch[1].trim();
  }
  // Try specific seller selectors
  if (!seller) {
    const sellerEl = $('.ui-pdp-seller__title, .ui-pdp-seller__link-trigger, .ui-seller-info__title, .ui-seller-data__title').first();
    if (sellerEl.length > 0) {
      seller = sellerEl.text().trim();
    }
  }
  // Try seller name from seller info section
  if (!seller) {
    const sellerSection = $('.ui-seller-info, .ui-pdp-seller, .ui-seller-data');
    if (sellerSection.length > 0) {
      const nameEl = sellerSection.find('.ui-pdp-seller__link-trigger, .ui-seller-info__title, a');
      if (nameEl.length > 0) {
        seller = nameEl.first().text().trim();
      }
    }
  }
  // Try finding seller link by class pattern
  if (!seller) {
    $('a[href*="mercadolivre.com.br/perfil/"], a[href*="vendedor"], .ui-pdp-seller__link-trigger').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2 && !text.includes('Denunciar')) {
        seller = text;
        return false;
      }
    });
  }

  const installmentsTotal = calculateInstallmentsTotal(installmentsText, price);
  const deliveryDate = parseDeliveryDate(deliveryTime);

  return {
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
    seller
  };
}

// ============================================================
// SECTION 5: CATALOG / OFFER-TYPE LISTING SCRAPER
// ============================================================
// Handles /p/MLB... pages with offer_type filters.
//
// The #buybox-form contains a <ul> with offer <li> items.
// The selected <li> has class or attribute indicating SELECTED.
// From the selected <li> we extract: price, installments, shipping, seller.
//
// Returns scraped data plus flags for installment fallback.

function scrapeCatalogListing($, html, url) {
  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();

  const buyBoxForm = $('#buybox-form');
  if (!buyBoxForm.length) {
    console.warn('[scraper] Catalog page has no #buybox-form. Falling back to normal extraction.');
    return { ...scrapeNormalListing($, html), needsInstallmentFallback: false };
  }

  const buyBoxText = buyBoxForm.text();
  const lowerBuyBoxText = buyBoxText.toLowerCase();

  // Find the offer list
  const offerList = buyBoxForm.find('ul');
  let selectedLi = null;

  if (offerList.length > 0) {
    // Look for the selected offer.
    // Mercado Livre uses various patterns to indicate selection:
    // radio input checked, aria attributes, CSS classes, or data attributes.
    selectedLi = offerList.find(
      'li.selected, ' +
      'li[aria-selected="true"], ' +
      'li[aria-checked="true"], ' +
      'li[selected], ' +
      'li[data-selected="true"], ' +
      'li[data-checked="true"]'
    ).first();

    // Fallback: find the checked radio input and get its parent li
    if (!selectedLi.length) {
      const checkedRadio = offerList.find('input[type="radio"]:checked, input[checked]');
      if (checkedRadio.length > 0) {
        selectedLi = checkedRadio.closest('li');
      }
    }

    // Fallback: find li that looks visually selected by class patterns
    if (!selectedLi || !selectedLi.length) {
      offerList.find('li').each((i, el) => {
        const $el = $(el);
        const classes = ($el.attr('class') || '').toLowerCase();
        const html = ($el.html() || '').toLowerCase();
        // Common ML patterns for selected/highlighted offer
        if (
          classes.includes('--selected') ||
          classes.includes('--active') ||
          classes.includes('--highlighted') ||
          classes.includes('--checked') ||
          html.includes('checked') ||
          html.includes('data-checked="true"') ||
          html.includes('aria-checked="true"') ||
          $el.attr('aria-pressed') === 'true' ||
          $el.attr('aria-current') === 'true'
        ) {
          selectedLi = $el;
          return false;
        }
      });
    }

    // Fallback: find li whose inner radio input has 'checked' attribute
    if (!selectedLi || !selectedLi.length) {
      offerList.find('li').each((i, el) => {
        const $el = $(el);
        const radio = $el.find('input[type="radio"]');
        if (radio.length > 0 && radio.attr('checked') !== undefined) {
          selectedLi = $el;
          return false;
        }
        // Check if radio has 'checked' property via data attribute
        if (radio.length > 0) {
          const dataChecked = radio.attr('data-checked') || radio.attr('aria-checked');
          if (dataChecked === 'true') {
            selectedLi = $el;
            return false;
          }
        }
      });
    }

    // If still not found, take the first li
    if (!selectedLi || !selectedLi.length) {
      selectedLi = offerList.find('li').first();
    }
  }

  // Container used for extraction: prefer selected li, fallback to entire buybox
  const extractionContainer = (selectedLi && selectedLi.length > 0) ? selectedLi : buyBoxForm;
  const extractionText = extractionContainer.text();
  const lowerExtractionText = extractionText.toLowerCase();

  // ---- Price from selected offer ----
  let price = null;
  let originalPrice = null;
  let discountPercent = 0;

  // Find Andes money amounts within the extraction container
  const moneyAmounts = extractionContainer.find('.andes-money-amount');
  const pricesFound = [];

  moneyAmounts.each((i, el) => {
    const amt = parseMoneyAmount($, $(el));
    const classes = $(el).attr('class') || '';
    const isPrev = classes.includes('--previous') || $(el).closest('s, del').length > 0;
    if (amt !== null) {
      pricesFound.push({ amt, isPrev });
    }
  });

  // First non-previous is current price, previous is original
  for (const p of pricesFound) {
    if (p.isPrev && originalPrice === null) {
      originalPrice = p.amt;
    } else if (!p.isPrev && price === null) {
      price = p.amt;
    }
  }

  // If only one price found, it's the current price
  if (price === null && pricesFound.length > 0) {
    price = pricesFound[0].amt;
  }

  // Fallback: scan extraction text for price patterns like "R$ 1.234,56"
  if (price === null) {
    const priceMatches = [...extractionText.matchAll(/R\$\s*([\d.]+,\d{2})/g)];
    if (priceMatches.length >= 2) {
      // Two prices: higher is original, lower is current
      const values = priceMatches.map(m => parsePriceFromText(m[0]));
      values.sort((a, b) => a - b);
      price = values[0];
      originalPrice = values[1];
    } else if (priceMatches.length === 1) {
      price = parsePriceFromText(priceMatches[0][0]);
    }
  }

  // ---- Discount from selected offer ----
  const discountEl = extractionContainer.find('.ui-pdp-price__discount, .ui-pdp-discount, [data-andes-money-amount-discount]');
  if (discountEl.length > 0) {
    const discountText = discountEl.attr('data-andes-money-amount-discount') || discountEl.text().trim();
    const match = discountText.match(/(\d+)%/);
    if (match) {
      discountPercent = parseInt(match[1], 10);
    }
  }
  if (!discountPercent && originalPrice && price && originalPrice > price) {
    discountPercent = Math.round(((originalPrice - price) / originalPrice) * 100);
  }

  // ---- Installments from selected offer ----
  // Only extract from the SELECTED offer, NOT from other offers in the list.
  // Different offers have different sellers and installment terms.
  let installmentsText = '';

  const installmentSelectors = [
    '.ui-pdp-price__installments',
    '.ui-pdp-price__subtitles',
    '.ui-pdp-payment__title',
    '.ui-pdp-payment__method',
    '.ui-pdp-buybox__installments',
    '[data-testid="installments"]',
  ];

  // Check only the selected offer container
  for (const sel of installmentSelectors) {
    const els = extractionContainer.find(sel);
    for (let i = 0; i < els.length; i++) {
      const text = $(els[i]).text().replace(/\s+/g, ' ').trim();
      if (/\d+\s*x\s*(?:R\$\s*)?\d+/i.test(text) && text.length < 150) {
        installmentsText = text;
        break;
      }
    }
    if (installmentsText) break;
  }

  // Fallback: scan extraction text for patterns (selected offer only)
  if (!installmentsText) {
    const instMatch = extractionText.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
    if (instMatch) {
      installmentsText = instMatch[1].trim();
    }
  }

  // Flag for installment fallback (only if we have a seller to search for)
  const needsInstallmentFallback = !installmentsText;

  installmentsText = cleanInstallments(installmentsText);

  // ---- Interest-free ----
  let interestFree = false;
  if (installmentsText && installmentsText !== 'Não informado') {
    interestFree = installmentsText.toLowerCase().includes('sem juros');
  } else {
    interestFree = lowerExtractionText.includes('sem juros') || lowerBuyBoxText.includes('sem juros');
  }

  // ---- Seller from selected offer ----
  let seller = null;

  // Strategy 1: Find seller name from links inside the selected offer first
  const extractSellerFromLinks = (container) => {
    const links = container.find('a[href]');
    for (let i = 0; i < links.length; i++) {
      const href = ($(links[i]).attr('href') || '').toLowerCase();
      const text = $(links[i]).text().trim();
      if ((href.includes('/perfil/') || href.includes('vendedor')) && text && text.length > 1 && text.length < 60) {
        return text;
      }
      // Some seller links have no text - extract from href
      if (href.includes('/perfil/') && (!text || text.length < 2)) {
        const urlParts = href.split('/');
        const lastPart = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
        if (lastPart && lastPart.length > 2 && !lastPart.includes('perfil')) {
          return lastPart.replace(/[+#]/g, ' ').trim();
        }
      }
    }
    return null;
  };

  // Try extraction container (selected li) first
  seller = extractSellerFromLinks(extractionContainer);

  // Try full page
  if (!seller) {
    seller = extractSellerFromLinks($('body'));
  }

  // Strategy 2: Find seller name from buybox seller-specific elements
  if (!seller) {
    const sellerLinkSelectors = [
      '.ui-pdp-seller__link-trigger',
      '.ui-pdp-seller__title',
      '.ui-seller-info__title',
      '.ui-seller-data__title',
      'a[href*="vendedor"]',
    ];
    for (const sel of sellerLinkSelectors) {
      const el = $(sel).first();
      if (el.length > 0) {
        const text = el.text().trim();
        if (text && text.length > 2 && text.length < 80) {
          seller = text;
          break;
        }
      }
    }
  }

  // Strategy 3: Text-based extraction from the selected offer text
  if (!seller) {
    // Try "por PRIMETECH20" pattern (single word seller after "por")
    const porSingleMatch = extractionText.match(/\bpor\s+([A-ZÀ-Ú][A-ZÀ-Ú0-9]{2,30}?)(?:\s*(?:\||\+|\d|$))/i);
    if (porSingleMatch) {
      seller = porSingleMatch[1].trim();
    }
  }

  // Strategy 4: Text-based extraction from SELECTED offer first,
  // fallback to full buybox only if not found.
  if (!seller) {
    // Try selected offer text: capture from "Vendido por" to "+N vendas"
    const soldByMatch = extractionText.match(
      /(?:vendido|compra)\s*por\s*([A-ZÀ-Ú][\s\S]+?)\+\d+\s*vendas/i
    );
    if (soldByMatch) {
      seller = soldByMatch[1].trim();
      seller = seller.replace(/\s*MercadoLíder\s*\|?\s*$/, '').trim();
    } else {
      // Fallback to full buybox text
      const fullBuyBoxText = buyBoxForm.text();
      const soldByFull = fullBuyBoxText.match(
        /(?:vendido|compra)\s*por\s*([A-ZÀ-Ú][\s\S]+?)\+\d+\s*vendas/i
      );
      if (soldByFull) {
        seller = soldByFull[1].trim();
        seller = seller.replace(/\s*MercadoLíder\s*\|?\s*$/, '').trim();
      }
    }
  }

  // Strategy 5: Look in extraction text for "por NOME" with broader pattern
  if (!seller) {
    const porMatch = extractionText.match(/\bpor\s*([A-ZÀ-Ú][A-ZÀ-Ú0-9&.\-\s]{2,80}?)(?:\s*(?:\||\+\d+\s*vendas|$))/i);
    if (porMatch) {
      seller = porMatch[1].trim();
    }
  }

  // Clean up common suffixes
  if (seller) {
    seller = seller.replace(/\s*\+\d+\s*vendas?$/i, '').trim();
    seller = seller.replace(/\s*\|\s*$/, '').trim();
    seller = seller.replace(/\s*\(\d+\)\s*$/, '').trim();
  }

  // ---- Shipping from selected offer ----
  let isFreeShipping = lowerExtractionText.includes('frete grátis') || lowerExtractionText.includes('chegará grátis') || lowerBuyBoxText.includes('frete grátis');
  // Check Full only within the selected offer, not the entire page
  const extractionHtml = extractionContainer.html() || '';
  let isFull =
    extractionHtml.includes('ui-pdp-icon--full') ||
    extractionHtml.includes('poly-shipping__promise-icon--full') ||
    extractionHtml.includes('full-shipping') ||
    lowerExtractionText.includes('armazenado e enviado pelo full') ||
    lowerExtractionText.includes('enviado pelo full') ||
    lowerExtractionText.includes('pelo full') ||
    lowerExtractionText.includes('por full');
  // Fallback: check buybox HTML if extraction container didn't match
  if (!isFull) {
    const buyBoxHtml = buyBoxForm.html() || '';
    isFull =
      buyBoxHtml.includes('ui-pdp-icon--full') ||
      buyBoxHtml.includes('poly-shipping__promise-icon--full') ||
      buyBoxHtml.includes('full-shipping') ||
      lowerBuyBoxText.includes('armazenado e enviado pelo full') ||
      lowerBuyBoxText.includes('enviado pelo full') ||
      lowerBuyBoxText.includes('pelo full') ||
      lowerBuyBoxText.includes('por full');
  }

  let shippingCost = isFreeShipping ? 0 : null;
  if (!isFreeShipping) {
    const shipCostMatch = extractionText.match(/(?:frete|envio)[^R$]*?(R\$\s*[\d.,]+)/i);
    if (shipCostMatch) {
      shippingCost = parsePriceFromText(shipCostMatch[1]);
    }
  }

  // ---- Delivery time from selected offer ----
  let deliveryTime = '';
  // Expanded regex: catches "entre X e Y", "até dia/mês", "a partir de dia/mês", etc.
  const deliveryRegex = /(?:chegará|entrega|chega)\s+(?:grátis\s+)?(?:entre\s+[^<\n\.]+|(?:no\s+)?prazo|amanhã|quinta-feira|sexta-feira|sábado|segunda-feira|terça-feira|quarta-feira|\d+\s+dias|\d+\s+a\s+\d+\s+de\s+\w+|\d+\s+e\s+\d+\s*\/\s*\w+|até\s+(?:dia\s+)?\d+\s*\/?\s*\w*|a\s+partir\s+de\s+[^<\n\.]+)/i;
  let deliveryMatch = extractionText.match(deliveryRegex) || buyBoxText.match(deliveryRegex);
  // Simpler pattern fallback: just "Chegará grátis" or "Chega amanhã"
  if (!deliveryMatch) {
    deliveryMatch = extractionText.match(/(chegará\s+grátis|chega\s+amanhã|chegará\s+amanhã|chega\s+hoje|entrega\s+full)/i)
      || buyBoxText.match(/(chegará\s+grátis|chega\s+amanhã|chegará\s+amanhã|chega\s+hoje|entrega\s+full)/i);
  }
  if (deliveryMatch) {
    deliveryTime = cleanDeliveryText(deliveryMatch[0].trim());
  }

  if (!deliveryTime) {
    if (lowerExtractionText.includes('chegará amanhã')) {
      deliveryTime = 'Chegará amanhã';
    } else if (lowerExtractionText.includes('chega amanhã')) {
      deliveryTime = 'Chega amanhã';
    } else if (lowerBuyBoxText.includes('chegará amanhã')) {
      deliveryTime = 'Chegará amanhã';
    } else {
      deliveryTime = 'Consulte prazos no link';
    }
  }

  const installmentsTotal = calculateInstallmentsTotal(installmentsText, price);
  const deliveryDate = parseDeliveryDate(deliveryTime);

  return {
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
    seller,
    needsInstallmentFallback
  };
}

// ============================================================
// SECTION 6: CATALOG INSTALLMENT FALLBACK (s? URL)
// ============================================================
// When a catalog page offers no installment info in the selected
// offer, we navigate to the /s? ("ver mais anúncios") URL and
// find the seller's row in the listing table to extract
// installment terms.
//
// The s? page is a SPA that loads results via JavaScript.
// We wait for the listing grid to render, then search for the
// seller across paginated pages (up to MAX_PAGES).

const MAX_SEARCH_PAGES = 5;

/**
 * Waits for the listing results to render on the s? page.
 * Uses multiple selector strategies and a fallback timeout.
 */
async function waitForSearchResults(page) {
  const selectors = [
    'ol.ui-search-layout > li',
    '.ui-search-layout__item',
    '.ui-search-result',
    '[data-testid="search-results"] > div',
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      console.log(`[scraper] Search results found via selector: ${sel}`);
      return;
    } catch {
      // Try next selector
    }
  }

  // Fallback: wait for any Andes card or product container
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="/MLB"]').length > 0,
      { timeout: 8000 }
    );
  } catch {
    console.warn('[scraper] Warning: search results may not have rendered fully.');
  }

  // Extra wait for dynamic content
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Extracts listing rows from the current s? page using Cheerio.
 */
function extractListingRows($) {
  const rowSelectors = [
    'ol.ui-search-layout > li',
    '.ui-search-layout__item',
    '.ui-search-result',
    '[data-testid="search-results"] > div',
    '.ui-search-results > li',
    'article.andes-card',
    '.ui-search-item__group',
  ];

  for (const sel of rowSelectors) {
    const rows = $(sel);
    if (rows.length > 0) return rows;
  }

  // Last resort: any container with both a price and meaningful content
  return $('div, li, article, section').filter((i, el) => {
    const text = $(el).text();
    return /R\$\s*[\d.,]+/.test(text) && text.length > 100 && text.length < 4000;
  });
}

/**
 * Tries to find seller in listing rows with fuzzy matching.
 * Returns the matched row element or null.
 */
function findSellerRow($, listingRows, sellerName) {
  const sellerLower = sellerName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sellerWords = sellerName.toLowerCase().split(/[\s+|]+/).filter(w => w.length > 2);

  let bestRow = null;

  listingRows.each((i, row) => {
    const rowText = $(row).text().replace(/\s+/g, ' ').toLowerCase();

    // Exact match
    if (sellerLower && rowText.includes(sellerLower)) {
      bestRow = $(row);
      return false;
    }

    // Fuzzy: at least 2 seller words appear in the row
    if (sellerWords.length >= 2) {
      const matches = sellerWords.filter(w => rowText.includes(w));
      if (matches.length >= 2) {
        bestRow = $(row);
        return false;
      }
    }
  });

  return bestRow;
}

/**
 * Extracts installment text from a listing row element.
 */
function extractInstallmentsFromRow($, row) {
  const rowText = $(row).text();
  const instMatch = rowText.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
  if (!instMatch) return null;

  const installmentsText = cleanInstallments(instMatch[1].trim());
  const interestFree = installmentsText.toLowerCase().includes('sem juros');
  return { installmentsText, interestFree };
}

/**
 * Clicks the "next page" button on the s? search results.
 * Returns true if navigation happened, false if no next page.
 */
async function goToNextPage(page) {
  const nextButtonSelectors = [
    'a[title="Seguinte"]',
    'a[title="Próxima"]',
    'li.andes-pagination__button--next a',
    '.andes-pagination__button--next',
    'a.andes-pagination__link[title="Seguinte"]',
    '.ui-search-pagination a[title="Seguinte"]',
    '[data-testid="pagination-next"]',
    '.ui-search-pagination__next a',
  ];

  for (const sel of nextButtonSelectors) {
    try {
      const nextBtn = await page.$(sel);
      if (nextBtn) {
        const isDisabled = await nextBtn.evaluate(el =>
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('andes-pagination__button--disabled') ||
          el.parentElement?.classList.contains('andes-pagination__button--disabled')
        );
        if (!isDisabled) {
          console.log(`[scraper] Navigating to next page via: ${sel}`);
          await nextBtn.click();
          await new Promise(resolve => setTimeout(resolve, 3000));
          await waitForSearchResults(page);
          return true;
        }
      }
    } catch {
      // Try next selector
    }
  }

  return false;
}

async function fetchCatalogInstallments(page, originalUrl, sellerName) {
  if (!sellerName && !originalUrl) return null;

  const searchUrl = buildCatalogSearchUrl(originalUrl);
  console.log(`[scraper] Installment fallback: navigating to ${searchUrl} to find seller "${sellerName}"`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight || totalHeight > 5000) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Use page.evaluate to inspect the actual rendered DOM
    const domInfo = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/MLB"]');
      const results = document.querySelectorAll(
        'ol.ui-search-layout > li, .ui-search-layout__item, .ui-search-result, ' +
        '[data-testid="search-results"] > div, article.andes-card, .ui-search-item__group'
      );
      return {
        mlbLinkCount: links.length,
        resultCount: results.length,
        bodyTextStart: document.body ? document.body.innerText.substring(0, 400) : '(no body)',
        url: window.location.href,
      };
    });

    console.log(`[scraper] DOM state: ${domInfo.mlbLinkCount} MLB links, ${domInfo.resultCount} result containers, URL=${domInfo.url}`);
    console.log(`[scraper] Body text start: "${domInfo.bodyTextStart}"`);

    // If we got redirected or blocked, return null
    if (domInfo.url.includes('account-verification') || domInfo.url.includes('suspicious_traffic')) {
      console.warn('[scraper] Installment fallback: blocked/redirected by bot protection.');
      return null;
    }

    if (domInfo.resultCount === 0 && domInfo.mlbLinkCount === 0) {
      console.warn('[scraper] Installment fallback: page appears empty or not rendered.');
      return null;
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    for (let pageNum = 1; pageNum <= MAX_SEARCH_PAGES; pageNum++) {
      const listingRows = extractListingRows($);

      if (listingRows.length === 0) {
        console.warn(`[scraper] Page ${pageNum}: still no listing rows after render check.`);
        break;
      }

      console.log(`[scraper] Page ${pageNum}: ${listingRows.length} listing rows found.`);

      let bestRow = findSellerRow($, listingRows, sellerName);

      if (!bestRow || !bestRow.length) {
        console.warn(`[scraper] Page ${pageNum}: seller "${sellerName}" not found by name. Trying any row with installments.`);
        listingRows.each((i, row) => {
          const rowText = $(row).text();
          if (/\d+\s*x\s*R\$\s*\d+/i.test(rowText)) {
            bestRow = $(row);
            return false;
          }
        });
      }

      if (bestRow && bestRow.length) {
        const result = extractInstallmentsFromRow($, bestRow);
        if (result) {
          console.log(`[scraper] Page ${pageNum}: found "${result.installmentsText}"`);
          return result;
        }
      }

      if (pageNum < MAX_SEARCH_PAGES) {
        const hasNext = await goToNextPage(page);
        if (!hasNext) {
          console.warn(`[scraper] No more pages available after page ${pageNum}.`);
          break;
        }
      }
    }

    console.warn(`[scraper] Installment fallback: seller "${sellerName}" not found across ${MAX_SEARCH_PAGES} pages.`);
    return null;

  } catch (err) {
    console.error('[scraper] Installment fallback failed:', err.message);
    return null;
  }
}

// ============================================================
// SECTION 7: scrapePage COORDINATOR
// ============================================================

/**
 * Core scraping function for a single page URL.
 * Handles navigation, bot detection, type detection, and extraction.
 */
async function scrapePage(page, url) {
  const { id, type } = parseMercadoLivreUrl(url);
  console.log(`[scraper] Scraping page: ${url} (ID: ${id}, Type: ${type})`);

  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const finalUrl = page.url();
  await new Promise(resolve => setTimeout(resolve, 4000));

  const html = await page.content();
  const $ = cheerio.load(html);

  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();

  // ---- Bot detection ----
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

  // ---- Unavailable detection ----
  let isUnavailable = false;
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

  // ---- Common fields (all listing types) ----
  const commonFields = extractCommonFields($, html);

  // ---- Type-specific extraction ----
  const isCatalog = type === 'catalog';
  let typeSpecificFields;

  if (isCatalog) {
    typeSpecificFields = scrapeCatalogListing($, html, url);

    // Installment fallback for catalogs
    if (typeSpecificFields.needsInstallmentFallback && typeSpecificFields.seller) {
      console.log(`[scraper] Catalog listing missing installments. Trying s? fallback for seller "${typeSpecificFields.seller}"`);
      const fallbackResult = await fetchCatalogInstallments(page, url, typeSpecificFields.seller);
      if (fallbackResult) {
        typeSpecificFields.installmentsText = fallbackResult.installmentsText;
        typeSpecificFields.interestFree = fallbackResult.interestFree;
        typeSpecificFields.installmentsTotal = calculateInstallmentsTotal(
          fallbackResult.installmentsText,
          typeSpecificFields.price
        );
      }
    }
  } else {
    typeSpecificFields = scrapeNormalListing($, html);
  }

  // ---- Validate active listing ----
  if (!isUnavailable && (!commonFields.title || commonFields.title.trim() === '' || typeSpecificFields.price === null)) {
    console.warn(`[scraper] WARNING: Scraping returned empty title or null price for active announcement ID ${id}. Title: "${commonFields.title}", Price: ${typeSpecificFields.price}.`);
    throw new Error('Failed to parse valid product data (possible block or failed load).');
  }

  // ---- Assemble result ----
  return {
    id,
    url,
    title: commonFields.title,
    categoryStr: commonFields.categoryStr,
    image: commonFields.image,
    rating: commonFields.rating,
    reviewsCount: commonFields.reviewsCount,
    aiSummary: commonFields.aiSummary,
    price: typeSpecificFields.price,
    originalPrice: typeSpecificFields.originalPrice,
    discountPercent: typeSpecificFields.discountPercent,
    installmentsText: typeSpecificFields.installmentsText || 'Não informado',
    installmentsTotal: typeSpecificFields.installmentsTotal,
    interestFree: typeSpecificFields.interestFree,
    isFreeShipping: typeSpecificFields.isFreeShipping,
    isFull: typeSpecificFields.isFull,
    deliveryTime: typeSpecificFields.deliveryTime || 'Prazo não informado',
    deliveryDate: typeSpecificFields.deliveryDate,
    shippingCost: typeSpecificFields.shippingCost,
    seller: typeSpecificFields.seller,
    isUnavailable,
    scrapedAt: new Date().toISOString()
  };
}

// ============================================================
// SECTION 8: scrapeMercadoLivre ENTRY POINT
// ============================================================

/**
 * Public entry point. Launches browser and scrapes the given URL.
 *
 * For catalog pages (/p/MLB...), scrapes up to THREE variations:
 *   1. Base URL (default offer)
 *   2. ?offer_type=BEST_PRICE    (best price offer)
 *   3. ?offer_type=BEST_INSTALLMENTS (best installment offer)
 *
 * For normal listings, scrapes once.
 *
 * @param {string} url
 * @returns {Promise<object|object[]>} Single result or array of results
 */
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

    // 2. For catalog pages, also scrape offer_type variants
    //    Only do this when the URL doesn't already have an offer_type filter
    if (parsed.type === 'catalog' && !url.includes('offer_type=')) {
      console.log('[scraper] Catalog page detected. Scraping BEST_PRICE and BEST_INSTALLMENTS variants...');

      const results = [mainResult];

      try {
        const bestPriceUrl = new URL(url);
        bestPriceUrl.searchParams.set('offer_type', 'BEST_PRICE');
        const bestPriceResult = await scrapePage(page, bestPriceUrl.toString());
        results.push(bestPriceResult);
      } catch (err) {
        console.error('[scraper] Failed to scrape BEST_PRICE variation:', err.message);
      }

      try {
        const installmentsUrlObj = new URL(url);
        installmentsUrlObj.searchParams.set('offer_type', 'BEST_INSTALLMENTS');
        const installmentsResult = await scrapePage(page, installmentsUrlObj.toString());
        results.push(installmentsResult);
      } catch (err) {
        console.error('[scraper] Failed to scrape BEST_INSTALLMENTS variation:', err.message);
      }

      return results;
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
