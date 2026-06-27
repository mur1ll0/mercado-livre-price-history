import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

// ============================================================
// LISTING TYPES
// ============================================================
// 1. CATALOG (/p/MLB...)  -> has #buybox-form with <ul> of offers
//    Scrapes BEST_PRICE + BEST_INSTALLMENTS, stored in offers{}
// 2. NORMAL  (/MLB... or /up/MLBU...) -> single-seller page
//    Data goes into top-level fields

// ============================================================
// SECTION 1: URL PARSER
// ============================================================

export function parseMercadoLivreUrl(urlString) {
  try {
    const url = new URL(urlString);

    const catalogMatch = url.pathname.match(/\/p\/(MLB\d+)/i);
    if (catalogMatch) {
      return { id: catalogMatch[1].toUpperCase(), type: 'catalog' };
    }

    const sellerUpgradedMatch = url.pathname.match(/\/up\/(MLBU\d+)/i);
    if (sellerUpgradedMatch) {
      return { id: sellerUpgradedMatch[1].toUpperCase(), type: 'normal' };
    }

    const itemMatch = url.pathname.match(/\/MLB-?(\d+)/i);
    if (itemMatch) {
      return { id: `MLB${itemMatch[1]}`.toUpperCase(), type: 'normal' };
    }

    const anyMlbMatch = urlString.match(/(MLB-?\d+)/i);
    if (anyMlbMatch) {
      return { id: anyMlbMatch[1].replace('-', '').toUpperCase(), type: 'normal' };
    }

    const randomId = `MLB${Math.floor(100000000 + Math.random() * 900000000)}`;
    return { id: randomId, type: 'normal' };
  } catch (err) {
    const randomId = `MLB${Math.floor(100000000 + Math.random() * 900000000)}`;
    return { id: randomId, type: 'normal' };
  }
}

export function getBaseProductId(urlString) {
  try {
    const url = new URL(urlString);
    const catalogMatch = url.pathname.match(/\/p\/(MLB\d+)/i);
    if (catalogMatch) return catalogMatch[1].toUpperCase();
    const upgradeMatch = url.pathname.match(/\/up\/(MLBU\d+)/i);
    if (upgradeMatch) return upgradeMatch[1].toUpperCase();
    const itemMatch = url.pathname.match(/\/MLB-?(\d+)/i);
    if (itemMatch) return `MLB${itemMatch[1]}`.toUpperCase();
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// SECTION 2: HELPERS
// ============================================================

const monthMap = {
  jan: 0, janeiro: 0, fev: 1, fevereiro: 1, mar: 2, 'março': 2, marco: 2,
  abr: 3, abril: 3, mai: 4, maio: 4, jun: 5, junho: 5,
  jul: 6, julho: 6, ago: 7, agosto: 7, set: 8, setembro: 8,
  out: 9, outubro: 9, nov: 10, novembro: 10, dez: 11, dezembro: 11
};

const dayOfWeekMap = {
  domingo: 0, 'segunda-feira': 1, segunda: 1, 'terça-feira': 2, 'terça': 2, terca: 2,
  'quarta-feira': 3, quarta: 3, 'quinta-feira': 4, quinta: 4,
  'sexta-feira': 5, sexta: 5, 'sábado': 6, sabado: 6
};

function parseMoneyAmount($, element) {
  if (!element || element.length === 0) return null;
  const fraction = element.find('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '');
  const cents = element.find('.andes-money-amount__cents').first().text().trim();
  if (fraction) return parseFloat(fraction + (cents ? '.' + cents : ''));
  return null;
}

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
    let clean = match[1].trim().replace(/\s+/g, ' ');
    // Validate: installment count should be reasonable (1-48)
    const qtyMatch = clean.match(/^(\d+)\s*x/);
    if (qtyMatch) {
      const qty = parseInt(qtyMatch[1], 10);
      if (qty < 1 || qty > 48) return 'Não informado';
    }
    if (text.toLowerCase().includes('sem juros') && !clean.toLowerCase().includes('sem juros')) clean += ' sem juros';
    else if (text.toLowerCase().includes('com juros') && !clean.toLowerCase().includes('sem juros')) clean += ' com juros';
    return clean;
  }
  return text;
}

function calculateInstallmentsTotal(text, fallbackPrice) {
  if (!text || text === 'Não informado') return null;
  const match = text.match(/(\d+)\s*x\s*(?:R\$\s*)?(\d+(?:[.,]\d+)?)/i);
  if (match) {
    const qty = parseInt(match[1], 10);
    const val = parseFloat(match[2].replace(',', '.'));
    if (!isNaN(qty) && !isNaN(val) && qty >= 1 && qty <= 48) {
      return parseFloat((qty * val).toFixed(2));
    }
  }
  return null;
}

function cleanDeliveryText(text) {
  if (!text) return '';
  text = text.replace(/([a-zà-ú])([A-ZÀ-Ú])/g, '$1 $2');
  // If there are multiple delivery phrases concatenated, take only the first
  const secondDelivery = text.search(/\s(?:Chegará|Chega|Entrega)(?:\s|$)/);
  if (secondDelivery > 0) text = text.substring(0, secondDelivery);
  const truncateAt = ['Mais detalhes', 'Formas de entrega', 'Retirar', 'Ver mais',
    'por ser sua primeira compra', 'Saiba mais', 'Ver detalhes'];
  for (const marker of truncateAt) {
    const idx = text.indexOf(marker);
    if (idx > 0) { text = text.substring(0, idx).trim(); break; }
  }
  if (text.length > 100) text = text.substring(0, 100);
  return text.trim();
}

function parseDeliveryDate(text) {
  if (!text) return null;
  const cleanLines = text.replace(/(?:retire|retirar)[^\n\.]*/gi, '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const today = new Date();
  const currentYear = today.getFullYear();
  let maxDate = null;

  for (const line of cleanLines) {
    const cleanText = line.toLowerCase();
    if (!/(chegará|chega|entrega|receba|envio|chegar)/i.test(cleanText)) continue;
    let datesFound = [];

    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?hoje/i.test(cleanText))
      datesFound.push(new Date(today));
    if (/(chegará|chega|entrega|receba|envio|chegar)\s+(grátis\s+)?amanhã/i.test(cleanText)) {
      const d = new Date(today); d.setDate(today.getDate() + 1); datesFound.push(d);
    }

    const dayRegex = /(domingo|segunda-feira|segunda|terça-feira|terça|terca|quarta-feira|quarta|quinta-feira|quinta|sexta-feira|sexta|sábado|sabado)/gi;
    let match;
    while ((match = dayRegex.exec(cleanText)) !== null) {
      const targetDow = dayOfWeekMap[match[1].toLowerCase()];
      let diff = targetDow - today.getDay();
      if (diff <= 0) diff += 7;
      const d = new Date(today); d.setDate(today.getDate() + diff); datesFound.push(d);
    }

    const rangeMatch = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s*(?:de\s*)?\/?[a-z]*\s+(?:e|a)\s+(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
    if (rangeMatch) {
      const day = parseInt(rangeMatch[2], 10);
      const monthIdx = monthMap[rangeMatch[3].substring(0, 3)] ?? today.getMonth();
      let year = currentYear; if (monthIdx < today.getMonth()) year += 1;
      datesFound.push(new Date(year, monthIdx, day));
    } else {
      const rangeSame = cleanText.match(/(?:entre|chegará|chega|chegar).*?(\d+)\s+(?:e|a)\s+(\d+)\s*\/([a-zçãõ]+)/i);
      if (rangeSame) {
        const day = parseInt(rangeSame[2], 10);
        const monthIdx = monthMap[rangeSame[3].substring(0, 3)] ?? today.getMonth();
        let year = currentYear; if (monthIdx < today.getMonth()) year += 1;
        datesFound.push(new Date(year, monthIdx, day));
      } else {
        const singleMatch = cleanText.match(/(\d+)\s*(?:de\s*)?\/([a-zçãõ]+)/i);
        if (singleMatch) {
          const day = parseInt(singleMatch[1], 10);
          const monthIdx = monthMap[singleMatch[2].substring(0, 3)] ?? today.getMonth();
          let year = currentYear; if (monthIdx < today.getMonth()) year += 1;
          datesFound.push(new Date(year, monthIdx, day));
        } else {
          const genericMatch = cleanText.match(/(\d+)\/(\d+)/);
          if (genericMatch) {
            const day = parseInt(genericMatch[1], 10);
            const monthIdx = parseInt(genericMatch[2], 10) - 1;
            let year = currentYear; if (monthIdx < today.getMonth()) year += 1;
            datesFound.push(new Date(year, monthIdx, day));
          }
        }
      }
    }

    for (const date of datesFound) { date.setHours(0, 0, 0, 0); if (!maxDate || date > maxDate) maxDate = date; }
  }
  return maxDate;
}

function buildCategoryArray($) {
  const categories = [];
  let currentPath = '';
  $('.ui-pdp-breadcrumb__link, .ui-pdp-breadcrumb__item, .ui-pdp-breadcrumb a').each((i, el) => {
    const text = $(el).text().trim();
    if (text && text.toLowerCase() !== 'voltar') {
      currentPath = currentPath ? `${currentPath} > ${text}` : text;
      categories.push(currentPath);
    }
  });
  return [...new Set(categories)];
}

// ============================================================
// SECTION 3: COMMON FIELDS
// ============================================================

function extractCommonFields($) {
  let title = $('.ui-pdp-title').first().text().trim();
  if (!title) title = $('title').text().split('|')[0].trim();
  title = title.replace(/\s*\|\s*frete\s*grátis.*/i, '').trim();

  let image = '';
  const galleryImg = $('.ui-pdp-gallery__figure img, .ui-pdp-image, .ui-pdp-gallery__figure__container img').first();
  if (galleryImg.length > 0)
    image = galleryImg.attr('data-zoom') || galleryImg.attr('data-src') || galleryImg.attr('src') || '';

  const ratingText = $('.ui-pdp-review__rating').first().text().trim();
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;
  const reviewsCountText = $('.ui-pdp-review__amount').first().text().trim();
  const reviewsCount = reviewsCountText ? parseInt(reviewsCountText.replace(/\D/g, ''), 10) : 0;
  const aiSummary = $('.ui-review-capability__summary__plain_text__summary_container, .ui-review-capability__summary__plain_text').first().text().trim();

  const categories = buildCategoryArray($);

  return { title, image, rating, reviewsCount, aiSummary: aiSummary || '', categories };
}

// ============================================================
// SECTION 4: EXTRACT OFFER DATA (used by both listing types)
// ============================================================

function extractOfferData(container, $, html, fallbackText) {
  const text = container.text();
  const lowerText = text.toLowerCase();

  // Price
  let price = null, originalPrice = null, discountPercent = 0;
  const moneyAmounts = container.find('.andes-money-amount');
  const pricesFound = [];
  moneyAmounts.each((i, el) => {
    const amt = parseMoneyAmount($, $(el));
    const isPrev = ($(el).attr('class') || '').includes('--previous') || $(el).closest('s, del').length > 0;
    if (amt !== null) pricesFound.push({ amt, isPrev });
  });
  for (const p of pricesFound) {
    if (p.isPrev && originalPrice === null) originalPrice = p.amt;
    else if (!p.isPrev && price === null) price = p.amt;
  }
  if (price === null && pricesFound.length > 0) price = pricesFound[0].amt;

  if (price === null) {
    const priceMatches = [...text.matchAll(/R\$\s*([\d.]+,\d{2})/g)];
    if (priceMatches.length >= 2) {
      const vals = priceMatches.map(m => parsePriceFromText(m[0])).sort((a, b) => a - b);
      price = vals[0]; originalPrice = vals[1];
    } else if (priceMatches.length === 1) price = parsePriceFromText(priceMatches[0][0]);
  }

  // Discount
  const discountEl = container.find('.ui-pdp-price__discount, .ui-pdp-discount, [data-andes-money-amount-discount]');
  if (discountEl.length > 0) {
    const dt = discountEl.attr('data-andes-money-amount-discount') || discountEl.text().trim();
    const m = dt.match(/(\d+)%/); if (m) discountPercent = parseInt(m[1], 10);
  }
  if (!discountPercent && originalPrice && price && originalPrice > price)
    discountPercent = Math.round(((originalPrice - price) / originalPrice) * 100);

  if (originalPrice === null && price !== null) originalPrice = price;
  if (originalPrice && price && originalPrice < price) originalPrice = price;

  // Installments
  let installmentsText = '';
  const instSelectors = '.ui-pdp-price__installments, .ui-pdp-price__subtitles, .ui-pdp-payment__title, .ui-pdp-payment__method, .ui-pdp-buybox__installments, [data-testid="installments"]';
  const instEls = container.find(instSelectors);
  instEls.each((i, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/\d+\s*x\s*(?:R\$\s*)?\d+/i.test(t) && t.length < 150) { installmentsText = t; return false; }
  });
  if (!installmentsText) {
    const im = text.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
    if (im) installmentsText = im[1].trim();
  }
  installmentsText = cleanInstallments(installmentsText);
  const interestFree = installmentsText.toLowerCase().includes('sem juros') || lowerText.includes('sem juros');
  const installmentsTotal = calculateInstallmentsTotal(installmentsText, price);

  // Seller
  let seller = null;
  const soldBy = text.match(/(?:vendido|compra)\s*por\s*([A-ZÀ-Ú][\s\S]+?)\+\d+\s*vendas/i);
  if (soldBy) { seller = soldBy[1].trim().replace(/\s*MercadoLíder\s*\|?\s*$/, '').trim(); }
  if (!seller) {
    const pm = text.match(/\bpor\s+([A-ZÀ-Ú][A-ZÀ-Ú0-9&.\-\s]{2,80}?)(?:\s*(?:\||\+\d+\s*vendas|$))/i);
    if (pm) seller = pm[1].trim();
  }
  if (!seller) {
    container.find('a[href*="/perfil/"]').each((i, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 1 && t.length < 60) { seller = t; return false; }
    });
  }
  if (seller) { seller = seller.replace(/\s*\+\d+\s*vendas?$/i, '').replace(/\s*\|\s*$/, '').trim(); }

  // Shipping
  let isFreeShipping = lowerText.includes('frete grátis') || lowerText.includes('chegará grátis');
  const containerHtml = container.html() || '';
  let isFull = containerHtml.includes('ui-pdp-icon--full') || containerHtml.includes('poly-shipping__promise-icon--full') ||
    containerHtml.includes('full-shipping') || lowerText.includes('armazenado e enviado pelo full') ||
    lowerText.includes('enviado pelo full') || lowerText.includes('pelo full') || lowerText.includes('por full');

  let shippingCost = isFreeShipping ? 0 : null;
  if (!isFreeShipping) {
    const scm = text.match(/(?:frete|envio)[^R$]*?(R\$\s*[\d.,]+)/i);
    if (scm) shippingCost = parsePriceFromText(scm[1]);
  }

  // Delivery
  let deliveryTime = '';
  const deliveryRegex = /(?:chegará|entrega|chega)\s+(?:grátis\s+)?(?:entre\s+[^<\n\.]+|(?:no\s+)?prazo|amanhã|quinta-feira|sexta-feira|sábado|segunda-feira|terça-feira|quarta-feira|\d+\s+dias|\d+\s+a\s+\d+\s+de\s+\w+|\d+\s+e\s+\d+\s*\/\s*\w+|até\s+(?:dia\s+)?\d+\s*\/?\s*\w*|a\s+partir\s+de\s+[^<\n\.]+)/i;
  const dm = text.match(deliveryRegex);
  if (dm) deliveryTime = cleanDeliveryText(dm[0]);
  if (!deliveryTime) {
    const simple = text.match(/(chegará\s+grátis|chega\s+amanhã|chegará\s+amanhã|chega\s+hoje|entrega\s+full)/i);
    if (simple) deliveryTime = simple[0];
  }
  if (!deliveryTime) {
    if (lowerText.includes('chegará amanhã')) deliveryTime = 'Chegará amanhã';
    else if (lowerText.includes('chega amanhã')) deliveryTime = 'Chega amanhã';
    else deliveryTime = 'Consulte prazos no link';
  }
  const deliveryDate = parseDeliveryDate(deliveryTime);

  return { price, originalPrice, discountPercent, installmentsText, installmentsTotal,
    interestFree, isFreeShipping, isFull, deliveryTime, deliveryDate, shippingCost, seller };
}

// ============================================================
// SECTION 5: NORMAL LISTING
// ============================================================

function scrapeNormalListing($, html) {
  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();
  const buyBox = $('.ui-pdp-container__col.col-1, .ui-pdp-container--column-right, #buybox-form');

  // Try #price meta first
  let priceFromMeta = null;
  const priceDiv = $('#price');
  if (priceDiv.length > 0) {
    const priceMeta = priceDiv.find('meta[itemprop="price"]');
    if (priceMeta.length > 0) {
      const cv = parseFloat(priceMeta.attr('content'));
      if (!isNaN(cv) && cv > 0) priceFromMeta = cv;
    }
  }

  const offerData = extractOfferData(buyBox.length > 0 ? buyBox : $('body'), $, html, bodyText);

  // If meta price was found and differs, prefer the meta price (more reliable for normal listings)
  if (priceFromMeta !== null) {
    offerData.price = priceFromMeta;
    if (offerData.originalPrice && offerData.originalPrice < priceFromMeta)
      offerData.originalPrice = priceFromMeta;
  }

  // Also check p#pricing_price_subtitle for installments (specific to normal listings)
  if (!offerData.installmentsText || offerData.installmentsText === 'Não informado') {
    const pricingSub = $('#pricing_price_subtitle');
    if (pricingSub.length > 0) {
      const t = pricingSub.text().replace(/\s+/g, ' ').trim();
      if (/\d+\s*x\s*/i.test(t)) {
        offerData.installmentsText = cleanInstallments(t);
        offerData.installmentsTotal = calculateInstallmentsTotal(t, offerData.price);
      }
    }
  }

  // Also check page-level Full indicators
  if (!offerData.isFull) {
    offerData.isFull = html.includes('ui-pdp-icon--full') || html.includes('poly-shipping__promise-icon--full') ||
      lowerBodyText.includes('armazenado e enviado pelo full');
  }

  return offerData;
}

// ============================================================
// SECTION 6: CATALOG LISTING
// ============================================================

function scrapeCatalogListing($, html, url) {
  const buyBox = $('#buybox-form');
  if (!buyBox.length) return { ...scrapeNormalListing($, html), needsFallback: false };

  // Find the offer list and selected li
  const offerList = buyBox.find('ul');
  let selectedLi = offerList.length > 0 ? offerList.find(
    'li.selected, li[aria-selected="true"], li[aria-checked="true"], li[selected], li[data-selected="true"], li[data-checked="true"]'
  ).first() : $([]);

  if (!selectedLi.length && offerList.length > 0) {
    const checkedRadio = offerList.find('input[type="radio"]:checked, input[checked]');
    if (checkedRadio.length > 0) selectedLi = checkedRadio.closest('li');
  }

  if (!selectedLi.length && offerList.length > 0) {
    offerList.find('li').each((i, el) => {
      const cls = ($(el).attr('class') || '').toLowerCase();
      if (cls.includes('--selected') || cls.includes('--active') || cls.includes('--highlighted') || cls.includes('--checked')) {
        selectedLi = $(el); return false;
      }
    });
  }

  if (!selectedLi || !selectedLi.length) {
    selectedLi = offerList.length > 0 ? offerList.find('li').first() : $([]);
  }

  const container = selectedLi.length > 0 ? selectedLi : buyBox;
  const result = extractOfferData(container, $, html, buyBox.text());

  // Check for installments in other offers if not found
  let needsFallback = false;
  if ((!result.installmentsText || result.installmentsText === 'Não informado') && result.seller && offerList.length > 0) {
    offerList.find('li').each((i, el) => {
      if (result.installmentsText && result.installmentsText !== 'Não informado') return false;
      const t = $(el).text();
      const im = t.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
      if (im) {
        result.installmentsText = cleanInstallments(im[1].trim());
        result.installmentsTotal = calculateInstallmentsTotal(result.installmentsText, result.price);
        result.interestFree = result.installmentsText.toLowerCase().includes('sem juros');
        return false;
      }
    });
    if (!result.installmentsText || result.installmentsText === 'Não informado') needsFallback = true;
  }

  result.needsFallback = needsFallback;
  return result;
}

// ============================================================
// SECTION 6.5: CATALOG INSTALLMENT FALLBACK (/s URL)
// ============================================================

function buildCatalogSearchUrl(originalUrl) {
  try {
    const url = new URL(originalUrl);
    url.searchParams.delete('offer_type');
    url.pathname = url.pathname + '/s';
    url.hash = '';
    return url.toString();
  } catch {
    return originalUrl;
  }
}

async function fetchCatalogInstallments(page, originalUrl, sellerName) {
  if (!sellerName || !originalUrl) return null;
  const searchUrl = buildCatalogSearchUrl(originalUrl);
  console.log(`[scraper] /s fallback: ${searchUrl} searching for "${sellerName}"`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let h = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 300); h += 300;
          if (h >= document.body.scrollHeight || h > 5000) { clearInterval(timer); resolve(); }
        }, 200);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if redirected to login
    const pageUrl = page.url();
    if (pageUrl.includes('/login') || pageUrl.includes('/account-verification')) {
      console.warn('[scraper] /s fallback: redirected to login page.');
      return null;
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    const rowSelectors = [
      'ol.ui-search-layout > li', '.ui-search-layout__item', '.ui-search-result',
      '[data-testid="search-results"] > div', '.ui-search-results > li',
      'article.andes-card', '.ui-search-item__group'
    ];

    let rows = $([]);
    for (const sel of rowSelectors) { rows = $(sel); if (rows.length > 0) break; }
    if (rows.length === 0) {
      rows = $('div, li, article').filter((i, el) => {
        const t = $(el).text(); return /R\$\s*[\d.,]+/.test(t) && t.length > 100 && t.length < 4000;
      });
    }

    if (rows.length === 0) {
      console.warn('[scraper] /s fallback: no listing rows found.');
      return null;
    }

    const sellerLower = sellerName.toLowerCase().replace(/[^a-z0-9]/g, '');
    let bestRow = null;

    rows.each((i, row) => {
      const rowText = $(row).text().replace(/\s+/g, ' ').toLowerCase();
      if (sellerLower && rowText.includes(sellerLower)) { bestRow = $(row); return false; }
    });

    // Fallback: any row with installments
    if (!bestRow || !bestRow.length) {
      rows.each((i, row) => {
        if (/\d+\s*x\s*R\$\s*\d+/i.test($(row).text())) { bestRow = $(row); return false; }
      });
    }

    if (!bestRow || !bestRow.length) {
      console.warn(`[scraper] /s fallback: seller "${sellerName}" not found.`);
      return null;
    }

    const rowText = bestRow.text();
    const instMatch = rowText.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
    if (!instMatch) { console.warn('[scraper] /s fallback: no installments in row.'); return null; }

    const installmentsText = cleanInstallments(instMatch[1].trim());
    const interestFree = installmentsText.toLowerCase().includes('sem juros');
    const installmentsTotal = calculateInstallmentsTotal(installmentsText, null);

    console.log(`[scraper] /s fallback: found "${installmentsText}"`);
    return { installmentsText, interestFree, installmentsTotal };
  } catch (err) {
    console.error('[scraper] /s fallback error:', err.message);
    return null;
  }
}

// ============================================================
// SECTION 7: scrapePage COORDINATOR
// ============================================================

async function scrapePage(page, url) {
  const { id, type } = parseMercadoLivreUrl(url);
  console.log(`[scraper] Scraping: ${url} (ID: ${id}, Type: ${type})`);

  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const finalUrl = page.url();
  await new Promise(resolve => setTimeout(resolve, 4000));

  const html = await page.content();
  const $ = cheerio.load(html);
  const bodyText = $('body').text();
  const lowerBodyText = bodyText.toLowerCase();

  // Bot detection
  if (finalUrl.includes('account-verification') || finalUrl.includes('suspicious_traffic') ||
    lowerBodyText.includes('não sou um robô') || lowerBodyText.includes('não sou um robo') ||
    lowerBodyText.includes('trace-id') ||
    $('title').text().trim().toLowerCase() === 'mercado livre' ||
    $('title').text().trim().toLowerCase() === 'mercado libre') {
    throw new Error('Blocked by Mercado Livre bot protection.');
  }

  let isUnavailable = false;
  if (lowerBodyText.includes('anúncio pausado') || lowerBodyText.includes('o vendedor pausou') ||
    lowerBodyText.includes('estoque esgotado') || lowerBodyText.includes('não disponível') ||
    lowerBodyText.includes('não encontramos este produto') || lowerBodyText.includes('página não encontrada') ||
    response?.status() === 404) {
    isUnavailable = true;
  }

  const common = extractCommonFields($);

  // Detect page type from the actual page content (may differ from URL parse)
  // Catalog pages have an offer list with radio buttons, not just any ul>li
  const buyBoxForm = $('#buybox-form');
  let hasOfferList = false;
  if (buyBoxForm.length > 0) {
    const ul = buyBoxForm.find('ul');
    if (ul.length > 0) {
      // Real offer lists have radio inputs or money amounts in the li items
      const lis = ul.find('li');
      hasOfferList = lis.length > 0 && lis.toArray().some(el => {
        const $el = $(el);
        const hasRadio = $el.find('input[type="radio"]').length > 0;
        const hasPrice = $el.find('.andes-money-amount').length > 0;
        const hasSeller = /vendido\s*por/i.test($el.text());
        return hasRadio || hasPrice || hasSeller;
      });
    }
  }
  const actualType = hasOfferList ? 'catalog' : 'normal';

  let offerData;
  if (actualType === 'catalog') {
    offerData = scrapeCatalogListing($, html, url);
  } else {
    offerData = scrapeNormalListing($, html);
  }

  // Validate
  if (!isUnavailable && (!common.title || common.title.trim() === '' || offerData.price === null)) {
    throw new Error('Failed to parse valid product data (possible block or failed load).');
  }

  const result = {
    id,
    url,
    title: common.title,
    type: actualType,
    categories: common.categories,
    rating: common.rating,
    reviewsCount: common.reviewsCount,
    aiSummary: common.aiSummary,
    image: common.image,
    isUnavailable,
    scrapedAt: new Date().toISOString()
  };

  // Always preserve the extracted offer data for the caller
  result._offerData = { ...offerData };

  if (actualType === 'catalog') {
    result.offers = { BEST_PRICE: null, BEST_INSTALLMENTS: null };
  } else {
    Object.assign(result, {
      price: offerData.price, originalPrice: offerData.originalPrice,
      discountPercent: offerData.discountPercent,
      installmentsText: offerData.installmentsText || 'Não informado',
      installmentsTotal: offerData.installmentsTotal, interestFree: offerData.interestFree,
      isFreeShipping: offerData.isFreeShipping, isFull: offerData.isFull,
      deliveryTime: offerData.deliveryTime || 'Prazo não informado', deliveryDate: offerData.deliveryDate,
      shippingCost: offerData.shippingCost, seller: offerData.seller
    });
  }

  result._needsFallback = offerData.needsFallback || false;
  result._sellerForFallback = offerData.seller;
  result._page = page;

  // Run /s fallback for catalog pages missing installments
  if (actualType === 'catalog' && result._needsFallback && result._sellerForFallback) {
    console.log(`[scraper] Catalog missing installments. Trying /s fallback for "${result._sellerForFallback}"`);
    const fb = await fetchCatalogInstallments(page, url, result._sellerForFallback);
    if (fb) {
      result._offerData.installmentsText = fb.installmentsText;
      result._offerData.installmentsTotal = fb.installmentsTotal;
      result._offerData.interestFree = fb.interestFree;
      if (result.offers) {
        // Also update the main result if this is a single-offer catalog scrape
      }
    }
  }

  return result;
}

// ============================================================
// SECTION 8: scrapeMercadoLivre ENTRY POINT
// ============================================================

export async function scrapeMercadoLivre(url, existingBrowser = null) {
  const parsed = parseMercadoLivreUrl(url);
  console.log(`[scraper] Starting scrape for: ${url} (ID: ${parsed.id})`);

  const ownBrowser = !existingBrowser;
  let browser = existingBrowser;

  if (!browser) {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: BROWSER_DATA_DIR,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      const u = req.url().toLowerCase();
      if (['font', 'media'].includes(rt) || u.includes('google-analytics') ||
        u.includes('doubleclick') || u.includes('analytics') || u.includes('melidata')) {
        req.abort();
      } else req.continue();
    });

    // Go directly to product — login is handled before scraping starts
    const mainResult = await scrapePage(page, url);

    // For catalog pages, scrape BEST_PRICE and BEST_INSTALLMENTS as offers
    if (mainResult.type === 'catalog' && !url.includes('offer_type=')) {
      console.log('[scraper] Catalog detected. Scraping BEST_PRICE and BEST_INSTALLMENTS offers...');

      // BEST_PRICE
      try {
        const bpUrl = new URL(url);
        bpUrl.searchParams.set('offer_type', 'BEST_PRICE');
        const bpResult = await scrapePage(page, bpUrl.toString());
        const od = bpResult._offerData || {};
        mainResult.offers.BEST_PRICE = {
          price: od.price || null,
          originalPrice: od.originalPrice || null,
          discountPercent: od.discountPercent || 0,
          installmentsText: od.installmentsText || 'Não informado',
          installmentsTotal: od.installmentsTotal || null,
          interestFree: od.interestFree || false,
          shippingCost: od.shippingCost || null,
          deliveryTime: od.deliveryTime || '',
          deliveryDate: od.deliveryDate || null,
          isFull: od.isFull || false,
          isFreeShipping: od.isFreeShipping || false,
          seller: od.seller || null
        };
        if (!mainResult.rating && bpResult.rating) mainResult.rating = bpResult.rating;
        if (!mainResult.reviewsCount && bpResult.reviewsCount) mainResult.reviewsCount = bpResult.reviewsCount;
        if (bpResult.categories?.length) mainResult.categories = [...new Set([...mainResult.categories, ...bpResult.categories])];
      } catch (err) {
        console.error('[scraper] BEST_PRICE scrape failed:', err.message);
      }

      // BEST_INSTALLMENTS
      try {
        const biUrl = new URL(url);
        biUrl.searchParams.set('offer_type', 'BEST_INSTALLMENTS');
        const biResult = await scrapePage(page, biUrl.toString());
        const od = biResult._offerData || {};
        mainResult.offers.BEST_INSTALLMENTS = {
          price: od.price || null,
          originalPrice: od.originalPrice || null,
          discountPercent: od.discountPercent || 0,
          installmentsText: od.installmentsText || 'Não informado',
          installmentsTotal: od.installmentsTotal || null,
          interestFree: od.interestFree || false,
          shippingCost: od.shippingCost || null,
          deliveryTime: od.deliveryTime || '',
          deliveryDate: od.deliveryDate || null,
          isFull: od.isFull || false,
          isFreeShipping: od.isFreeShipping || false,
          seller: od.seller || null
        };
        if (biResult.categories?.length) mainResult.categories = [...new Set([...mainResult.categories, ...biResult.categories])];
      } catch (err) {
        console.error('[scraper] BEST_INSTALLMENTS scrape failed:', err.message);
      }
    }

    // If URL already has offer_type, this is a single-offer scrape for a catalog
    if (mainResult.type === 'catalog' && url.includes('offer_type=')) {
      const offerType = url.includes('BEST_PRICE') ? 'BEST_PRICE' : 'BEST_INSTALLMENTS';
      const od = mainResult._offerData || {};
      mainResult.offers = { BEST_PRICE: null, BEST_INSTALLMENTS: null };
      mainResult.offers[offerType] = {
        price: od.price || null,
        originalPrice: od.originalPrice || null,
        discountPercent: od.discountPercent || 0,
        installmentsText: od.installmentsText || 'Não informado',
        installmentsTotal: od.installmentsTotal || null,
        interestFree: od.interestFree || false,
        shippingCost: od.shippingCost || null,
        deliveryTime: od.deliveryTime || '',
        deliveryDate: od.deliveryDate || null,
        isFull: od.isFull || false,
        isFreeShipping: od.isFreeShipping || false,
        seller: od.seller || null
      };
    }

    // Remove internal fields
    delete mainResult._offerData;
    delete mainResult._needsFallback;
    delete mainResult._sellerForFallback;
    delete mainResult._page;

    return mainResult;

  } finally {
    if (ownBrowser) {
      await browser.close();
      console.log('[scraper] Browser closed.');
    }
  }
}
