// Global Console Logging Interceptor for Extension Logs Viewer
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

var browserAPI = typeof browserAPI !== 'undefined' ? browserAPI : (typeof browser !== 'undefined' ? browser : chrome);

function getStorage(keys) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        browser.storage.local.get(keys)
          .then((res) => resolve(res || {}))
          .catch(() => resolve({}));
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, (res) => {
          resolve(res || {});
        });
      } else {
        resolve({});
      }
    } catch (e) {
      resolve({});
    }
  });
}

function setStorage(data) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        browser.storage.local.set(data)
          .then(() => resolve(true))
          .catch(() => resolve(false));
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(data, () => {
          resolve(true);
        });
      } else {
        resolve(false);
      }
    } catch (e) {
      resolve(false);
    }
  });
}

let logQueue = [];
let isWritingLogs = false;

async function processLogQueue() {
  if (isWritingLogs || logQueue.length === 0) return;
  isWritingLogs = true;
  
  try {
    const stored = await getStorage('logs');
    const logs = stored.logs || [];
    
    while (logQueue.length > 0) {
      logs.push(logQueue.shift());
    }
    
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    
    await setStorage({ logs });
  } catch (e) {
    // Ignore storage errors to avoid infinite loop
  } finally {
    isWritingLogs = false;
    if (logQueue.length > 0) {
      setTimeout(processLogQueue, 50);
    }
  }
}

function queueLog(type, args) {
  try {
    const msg = args.map(arg => {
      try {
        return typeof arg === 'object' ? JSON.stringify(arg) : arg;
      } catch (err) {
        return '[Unserializable Object]';
      }
    }).join(' ');
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] [${type.toUpperCase()}] ${msg}`;
    logQueue.push(entry);
    processLogQueue();
  } catch (e) {}
}

try {
  console.log = function(...args) {
    try {
      originalLog.apply(console, args);
    } catch (e) {}
    queueLog('info', args);
  };
} catch (e) {}

try {
  console.warn = function(...args) {
    try {
      originalWarn.apply(console, args);
    } catch (e) {}
    queueLog('warn', args);
  };
} catch (e) {}

try {
  console.error = function(...args) {
    try {
      originalError.apply(console, args);
    } catch (e) {}
    queueLog('error', args);
  };
} catch (e) {}

function parseMercadoLivreUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;

    const pMatch = path.match(/\/p\/(MLBU?\d+)/);
    if (pMatch) return { id: pMatch[1], type: 'catalog' };

    const upMatch = path.match(/\/up\/(MLBU?\d+)/);
    if (upMatch) return { id: upMatch[1], type: 'normal' };

    const mlbMatch = path.match(/\/MLBU?(\d+)/);
    if (mlbMatch) return { id: 'MLB' + mlbMatch[1], type: 'normal' };

    const id = 'MLB' + Math.floor(Math.random() * 900000000) + 100000000;
    return { id, type: 'normal' };
  } catch (e) {
    const id = 'MLB' + Math.floor(Math.random() * 900000000) + 100000000;
    return { id, type: 'normal' };
  }
}

function parsePriceFromText(str) {
  if (!str) return null;
  const cleaned = str.replace(/R\$\s*/g, '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseMoneyAmount(el) {
  if (!el) return null;
  const fraction = el.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\D/g, '') || '';
  const cents = el.querySelector('.andes-money-amount__cents')?.textContent?.replace(/\D/g, '') || '';
  if (!fraction) return null;
  const full = cents ? `${fraction}.${cents}` : fraction;
  const num = parseFloat(full);
  return isNaN(num) ? null : num;
}

function cleanInstallments(text) {
  if (!text) return 'Nao informado';
  let cleaned = text.replace(/[,.;]\s*cupom.*/i, '').trim();
  cleaned = cleaned.replace(/\bagora mesmo\b.*/i, '').trim();
  cleaned = cleaned.replace(/\bseu cupom.*/i, '').trim();
  cleaned = cleaned.replace(/\bcom cupom.*/i, '').trim();
  cleaned = cleaned.replace(/\bcom cartão Mercado Pago\b.*/i, '').trim();
  cleaned = cleaned.replace(/\bcom cartão\b.*/i, '').trim();
  cleaned = cleaned.replace(/\bcom Mercado Pago\b.*/i, '').trim();
  cleaned = cleaned.replace(/\bcom mercado crédito\b.*/i, '').trim();
  // Strip prefix like "ou R$1.949 em 18x R$108,28 sem juros" -> "18x R$108,28 sem juros"
  cleaned = cleaned.replace(/^(?:ou\s+)?R\$\s*[\d.,]+\s+(?:à vista\s+)?(?:em\s+)?/i, '').trim();
  if (cleaned.length > 110) cleaned = cleaned.substring(0, 110) + '...';
  return cleaned || 'Nao informado';
}

function calculateInstallmentsTotal(installmentsText, price) {
  if (!installmentsText) return null;
  const qtyMatch = installmentsText.match(/(\d+)\s*x/);
  if (!qtyMatch) return null;
  const qty = parseInt(qtyMatch[1], 10);
  if (qty < 2) return null;
  // Find the amount AFTER the 'x' pattern (the per-installment value)
  const afterX = installmentsText.substring(qtyMatch.index + qtyMatch[0].length);
  const amountMatch = afterX.match(/R\$\s*([\d.,]+)/);
  if (!amountMatch) {
    // Fallback: first amount in whole text
    const fallback = installmentsText.match(/R\$\s*([\d.,]+)/);
    if (!fallback) return null;
    const perInstallment = parsePriceFromText('R$ ' + fallback[1]);
    if (perInstallment === null) return null;
    if (perInstallment * qty > 100000 || perInstallment > 10000) return null; // sanity check
    return Math.round(perInstallment * qty * 100) / 100;
  }
  const perInstallment = parsePriceFromText('R$ ' + amountMatch[1]);
  if (perInstallment === null) return null;
  return Math.round(perInstallment * qty * 100) / 100;
}

function buildCategoryArray(doc) {
  const categories = [];
  let currentPath = '';
  const breadcrumbs = doc.querySelectorAll('.ui-pdp-breadcrumb__link, .ui-pdp-breadcrumb__item, .ui-pdp-breadcrumb a');
  const seen = new Set();
  breadcrumbs.forEach(el => {
    const text = (el.textContent || '').trim();
    if (text && text.toLowerCase() !== 'voltar') {
      currentPath = currentPath ? `${currentPath} > ${text}` : text;
      if (!seen.has(currentPath)) {
        seen.add(currentPath);
        categories.push(currentPath);
      }
    }
  });
  return categories;
}

function extractCommonFields(doc) {
  let title = doc.querySelector('.ui-pdp-title')?.textContent?.trim() || '';
  if (!title) {
    const titleEl = doc.querySelector('title');
    title = titleEl ? titleEl.textContent.split('|')[0].trim() : '';
  }
  title = title.replace(/\s*\|\s*frete\s*grátis.*/i, '').trim();

  let image = '';
  const galleryImg = doc.querySelector('.ui-pdp-gallery__figure__image');
  if (galleryImg) {
    image = galleryImg.getAttribute('data-zoom') || galleryImg.getAttribute('src') || '';
  }

  const ratingText = doc.querySelector('.ui-pdp-review__rating')?.textContent?.trim() || '';
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;
  const reviewsCountText = doc.querySelector('.ui-pdp-review__amount')?.textContent?.trim() || '';
  const reviewsCount = reviewsCountText ? parseInt(reviewsCountText.replace(/\D/g, ''), 10) : 0;
  const aiSummary = doc.querySelector('.ui-review-capability__summary__plain_text__summary_container, .ui-review-capability__summary__plain_text')?.textContent?.trim() || '';

  const categories = buildCategoryArray(doc);

  return { title, image, rating, reviewsCount, aiSummary, categories };
}

function extractSpecifications(doc) {
  const specs = [];
  const headings = doc.querySelectorAll('h2, h3, h4');
  console.log('[scraper] extractSpecs: found', headings.length, 'headings');
  for (const h of headings) {
    const hText = (h.textContent || '').trim().toLowerCase();
    if (hText.includes('características principais') || hText.includes('características gerais')) {
      console.log('[scraper] extractSpecs: found heading:', h.tagName, hText.substring(0, 50));
      let table = h.nextElementSibling;
      if (!table || table.tagName !== 'TABLE') {
        table = h.parentElement?.querySelector('table');
      }
      console.log('[scraper] extractSpecs: table found:', !!table, 'parent tag:', h.parentElement?.tagName);
      if (table) {
        const rows = table.querySelectorAll('tr');
        console.log('[scraper] extractSpecs: rows:', rows.length);
        rows.forEach(row => {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 2) {
            const key = (cells[0].textContent || '').trim();
            const value = (cells[1].textContent || '').trim();
            if (key && value && key.length < 80 && value.length < 200) {
              specs.push({ key, value });
            }
          }
        });
        if (specs.length > 0) {
          console.log('[scraper] extractSpecs: got', specs.length, 'specs');
          return specs;
        }
      }
    }
  }
  console.log('[scraper] extractSpecs: found 0 specs');
  return specs;
}

function cleanRawText(rawText) {
  var cleaned = rawText;
  var cutPatterns = [
    /Mais detalhes.*/i, /Retire grátis.*/i, /Ver no mapa.*/i,
    /Estoque disponível.*/i, /Armazenado e enviado.*/i,
    /Quantidade:.*/i, /Comprar agora.*/i, /Adicionar ao carrinho.*/i,
    /Vendido por.*/i, /MercadoLíder.*/i, /\+\d+\s*vendas.*/i,
    /\+\d+\s*anúncios.*/i, /\+\s*\d+\s*disponíveis.*/i
  ];
  for (var i = 0; i < cutPatterns.length; i++) {
    cleaned = cleaned.replace(cutPatterns[i], '');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/[,|;]\s*$/, '').trim();
  return cleaned;
}

function extractDeliveryInfo(rawText) {
  const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const shortWeekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const shortMonths = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const lower = rawText.toLowerCase();

  let date = null;
  let today = new Date();
  today.setHours(0, 0, 0, 0);

  // "entre X e Y/mmm" format: "entre 27 e 28/jul", "entre 15 e 16/jul"
  const entreMatch = lower.match(/(\d{1,2})\s*e\s*(\d{1,2})\s*\/\s*(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i);
  if (entreMatch) {
    const endDay = parseInt(entreMatch[2], 10);
    const monthStr = entreMatch[3].toLowerCase();
    let monthIdx = months.indexOf(monthStr);
    if (monthIdx === -1) monthIdx = shortMonths.indexOf(monthStr);
    if (monthIdx >= 0) {
      date = new Date(today.getFullYear(), monthIdx, endDay);
      date.setHours(0, 0, 0, 0);
      if (date < today) date.setFullYear(date.getFullYear() + 1);
      return { deliveryDate: date, rawText: rawText };
    }
  }

  // Single date with month: "10 de junho", "10/jun", "6/jul"
  const dateMatch = lower.match(/(\d{1,2})\s*(?:\/|de\s+)?(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const monthStr = dateMatch[2].toLowerCase();
    let monthIdx = months.indexOf(monthStr);
    if (monthIdx === -1) monthIdx = shortMonths.indexOf(monthStr);
    if (monthIdx >= 0) {
      date = new Date(today.getFullYear(), monthIdx, day);
      date.setHours(0, 0, 0, 0);
      if (date < today) date.setFullYear(date.getFullYear() + 1);
      return { deliveryDate: date, rawText: rawText };
    }
  }

  // "até X dias" or "X dias"
  const daysMatch = lower.match(/(?:até\s+)?(\d+)\s*dias?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    date = new Date(today);
    date.setDate(date.getDate() + days);
    return { deliveryDate: date, rawText: rawText };
  }

  // "amanhã"
  if (lower.includes('amanhã') || lower.includes('amanha')) {
    date = new Date(today);
    date.setDate(date.getDate() + 1);
    return { deliveryDate: date, rawText: rawText };
  }

  // "hoje"
  if (lower.includes('hoje')) {
    date = new Date(today);
    return { deliveryDate: date, rawText: rawText };
  }

  // Weekdays
  var foundWeekdays = [];
  for (var i = 0; i < weekdays.length; i++) {
    if (lower.includes(weekdays[i]) || lower.includes(shortWeekdays[i])) {
      foundWeekdays.push(i);
    }
  }
  // Weekdays - pick the LATEST relative date (furthest from today)
  if (foundWeekdays.length > 0) {
    var currentDay = today.getDay();
    var bestDays = -1;
    for (var w of foundWeekdays) {
      var daysUntil = w - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      if (daysUntil > bestDays) bestDays = daysUntil;
    }
    date = new Date(today);
    date.setDate(date.getDate() + bestDays);
    return { deliveryDate: date, rawText: rawText };
  }

  return { deliveryDate: null, rawText: rawText };
}

function extractOfferData(container, doc) {
  const text = container.textContent || '';
  const lowerText = text.toLowerCase();

  let price = null, originalPrice = null, discountPercent = 0;

  const moneyAmounts = container.querySelectorAll('.andes-money-amount');
  const pricesFound = [];
  moneyAmounts.forEach(el => {
    const amt = parseMoneyAmount(el);
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const isPrev = cls.includes('--previous') || !!el.closest('s, del');
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
    } else if (priceMatches.length === 1) {
      price = parsePriceFromText(priceMatches[0][0]);
    }
  }

  const discountEl = container.querySelector('.ui-pdp-price__discount, .ui-pdp-discount, [data-andes-money-amount-discount]');
  if (discountEl) {
    const dt = discountEl.getAttribute('data-andes-money-amount-discount') || discountEl.textContent.trim();
    const m = dt.match(/(\d+)%/); if (m) discountPercent = parseInt(m[1], 10);
  }
  if (!discountPercent && originalPrice && price && originalPrice > price) {
    discountPercent = Math.round(((originalPrice - price) / originalPrice) * 100);
  }

  if (originalPrice === null && price !== null) originalPrice = price;
  if (originalPrice && price && originalPrice < price) originalPrice = price;

  let installmentsText = '';
  const instSelectors = '.ui-pdp-price__installments, .ui-pdp-price__subtitles, .ui-pdp-payment__title, .ui-pdp-payment__method, .ui-pdp-buybox__installments, [data-testid="installments"]';
  const instEls = container.querySelectorAll(instSelectors);
  for (const el of instEls) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/\d+\s*x\s*(?:R\$\s*)?\d+/i.test(t) && t.length < 150) { installmentsText = t; break; }
  }
  if (!installmentsText) {
    const im = text.match(/(\d+\s*x\s*(?:R\$\s*)?\d+(?:[.,]\d+)?(?:\s*sem\s+juros)?)/i);
    if (im) installmentsText = im[1].trim();
  }
  installmentsText = cleanInstallments(installmentsText);
  const interestFree = installmentsText.toLowerCase().includes('sem juros') || lowerText.includes('sem juros');
  const installmentsTotal = calculateInstallmentsTotal(installmentsText, price);

  let seller = null;
  // 1. DOM-based: find "Vendido por" or "Loja oficial" and get seller from button/link
  const allEls = Array.from(container.querySelectorAll('span, a, button'));
  for (const el of allEls) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (t === 'vendido por' || t === 'loja oficial') {
      // Look in parent for a button or link with seller name
      const parent = el.parentElement || el.closest('div');
      if (parent) {
        const sellerBtn = parent.querySelector('button, a[href*="/perfil/"]');
        if (sellerBtn) {
          const nameSpan = sellerBtn.querySelector('span');
          const name = ((nameSpan || sellerBtn).textContent || '').trim();
          if (name && name.length >= 2 && name.length <= 40 && !/[<>]/.test(name)) {
            seller = name;
            console.log('[scraper] Seller found via DOM button:', seller);
            break;
          }
        }
      }
    }
  }
  // 2. Regex fallback: "Vendido por X +N vendas" or "Vendido por X |"
  if (!seller) {
    const soldBy = text.match(/(?:vendido|compra)\s*por\s+(\S[\s\S]{0,40}?)\s*(?:\+|\||$)/i);
    if (soldBy) {
      const raw = soldBy[1].trim().replace(/MercadoLíder\s*/gi, '').trim();
      if (raw.length >= 2 && raw.length <= 40) seller = raw;
    }
  }
  // 3. Profile link: a[href*="/perfil/"] with short text
  if (!seller) {
    const profileLinks = container.querySelectorAll('a[href*="/perfil/"]');
    for (const el of profileLinks) {
      const t = (el.textContent || '').trim();
      if (t.length >= 2 && t.length <= 40) { seller = t; break; }
    }
  }
  // Clean and validate
  if (seller) {
    seller = seller.replace(/\s*\+\d+\s*vendas?$/i, '').replace(/\s*\|\s*$/, '').replace(/MercadoLíder\s*/gi, '').trim();
    if (seller.length > 40 || /^(mais|retire|estoque|quantidade|comprar|adicionar|ver |no )/i.test(seller)) {
      console.log('[scraper] Seller rejected (invalid):', seller);
      seller = null;
    }
  }
  if (!seller) console.log('[scraper] Seller NOT found in container, checking regex...');

  let isFreeShipping = lowerText.includes('frete grátis') || lowerText.includes('chegará grátis');
  const containerHtml = container.innerHTML || '';
  let isFull = containerHtml.includes('ui-pdp-icon--full') ||
    lowerText.includes('armazenado e enviado pelo full') ||
    lowerText.includes('enviado pelo full');

  let shippingCost = isFreeShipping ? 0 : null;
  if (!isFreeShipping) {
    const scm = text.match(/(?:frete|envio)[^R$]*?(R\$\s*[\d.,]+)/i);
    if (scm) shippingCost = parsePriceFromText(scm[1]);
  }

  // Delivery: search container + body for "Chegará", prefer "grátis"
  var deliveryDate = null;
  var searchScope = container;
  var chegaEls = [];
  for (var scopeAttempt = 0; scopeAttempt < 2 && chegaEls.length === 0; scopeAttempt++) {
    chegaEls = Array.from(searchScope.querySelectorAll('p, span, div, li')).filter(el =>
      (el.textContent || '').toLowerCase().includes('chegará') && (el.textContent || '').length < 200
    );
    searchScope = doc.body;
  }
  if (chegaEls.length > 0) {
    var bestEl = chegaEls.find(el => (el.textContent || '').toLowerCase().includes('grátis')) || chegaEls[0];
    deliveryDate = extractDeliveryInfo(bestEl.textContent || '').deliveryDate;
  }

  return { price, originalPrice, discountPercent, installmentsText, installmentsTotal,
    interestFree, isFreeShipping, isFull, deliveryDate, shippingCost, seller };
}

function scrapeNormalListing(doc, html) {
  const bodyText = doc.body?.textContent || '';
  const lowerBodyText = bodyText.toLowerCase();
  const buyBox = doc.querySelector('.ui-pdp-container__col.col-1, .ui-pdp-container--column-right, #buybox-form');

  let priceFromMeta = null;
  const priceDiv = doc.querySelector('#price');
  if (priceDiv) {
    const priceMeta = priceDiv.querySelector('meta[itemprop="price"]');
    if (priceMeta) {
      const cv = parseFloat(priceMeta.getAttribute('content'));
      if (!isNaN(cv) && cv > 0) priceFromMeta = cv;
    }
  }

  const container = buyBox || doc.body;
  const offerData = extractOfferData(container, doc);

  if (priceFromMeta !== null) {
    offerData.price = priceFromMeta;
    if (offerData.originalPrice && offerData.originalPrice < priceFromMeta) {
      offerData.originalPrice = priceFromMeta;
    }
  }

  if (!offerData.installmentsText || offerData.installmentsText === 'Nao informado') {
    const pricingSub = doc.querySelector('#pricing_price_subtitle');
    if (pricingSub) {
      const t = (pricingSub.textContent || '').replace(/\s+/g, ' ').trim();
      if (/\d+\s*x\s*/i.test(t)) {
        offerData.installmentsText = cleanInstallments(t);
        offerData.installmentsTotal = calculateInstallmentsTotal(t, offerData.price);
      }
    }
  }

  if (!offerData.isFull) {
    offerData.isFull = html.includes('ui-pdp-icon--full') ||
      lowerBodyText.includes('armazenado e enviado pelo full') ||
      lowerBodyText.includes('enviado pelo full');
  }

  // If buybox didn't have seller or delivery, try extracting from the full page
  if ((!offerData.seller || !offerData.deliveryDate) && buyBox && buyBox !== doc.body) {
    const bodyOffer = extractOfferData(doc.body, doc);
    if (!offerData.seller) offerData.seller = bodyOffer.seller;
    if (!offerData.deliveryDate) offerData.deliveryDate = bodyOffer.deliveryDate;
    if (!offerData.isFreeShipping) offerData.isFreeShipping = bodyOffer.isFreeShipping;
  }

  return offerData;
}

function scrapeCatalogListing(doc, html) {
  const buyBox = doc.querySelector('#buybox-form');
  if (!buyBox) return scrapeNormalListing(doc, html);

  const offerList = buyBox.querySelector('ul');
  if (!offerList) return scrapeNormalListing(doc, html);

  let selectedLi = offerList.querySelector('li.selected, li[aria-selected="true"], li[aria-checked="true"], li[selected], li[data-selected="true"], li[data-checked="true"]');

  if (!selectedLi) {
    const checkedRadio = offerList.querySelector('input[type="radio"]:checked, input[checked]');
    if (checkedRadio) selectedLi = checkedRadio.closest('li');
  }

  if (!selectedLi) {
    const lis = offerList.querySelectorAll('li');
    for (const li of lis) {
      const cls = (li.getAttribute('class') || '').toLowerCase();
      if (cls.includes('--selected') || cls.includes('--active') || cls.includes('--highlighted') || cls.includes('--checked')) {
        selectedLi = li; break;
      }
    }
  }

  if (!selectedLi) {
    selectedLi = offerList.querySelector('li');
  }

  const container = selectedLi || buyBox;
  return extractOfferData(container, doc);
}

function hasRealOfferList(doc) {
  const buyBoxForm = doc.querySelector('#buybox-form');
  if (!buyBoxForm) return false;
  const ul = buyBoxForm.querySelector('ul');
  if (!ul) return false;
  const lis = ul.querySelectorAll('li');
  if (!lis.length) return false;
  return Array.from(lis).some(el => {
    const hasRadio = el.querySelector('input[type="radio"]') !== null;
    const hasPrice = el.querySelector('.andes-money-amount') !== null;
    const hasSeller = /vendido\s*por/i.test(el.textContent || '');
    return hasRadio || hasPrice || hasSeller;
  });
}

async function fetchAndParse(url) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const finalUrl = response.url;
  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  return { doc, html, finalUrl };
}

function buildOfferUrl(originalUrl, offerType) {
  try {
    const url = new URL(originalUrl);
    url.searchParams.set('offer_type', offerType);
    url.hash = '';
    return url.toString();
  } catch {
    return originalUrl;
  }
}

function buildCatalogSearchUrl(originalUrl, page = 1) {
  try {
    const url = new URL(originalUrl);
    url.searchParams.delete('offer_type');
    if (!url.pathname.endsWith('/s')) {
      url.pathname = url.pathname.replace(/\/+$/, '') + '/s';
    }
    if (page > 1) {
      url.searchParams.set('page', page);
    } else {
      url.searchParams.delete('page');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return originalUrl;
  }
}

async function fetchCatalogInstallments(originalUrl, sellerName, priceHint) {
  if (!sellerName || !originalUrl) return null;

  const MAX_PAGES = 3;
  const sellerLower = sellerName.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (let page = 1; page <= MAX_PAGES; page++) {
    const searchUrl = buildCatalogSearchUrl(originalUrl, page);
    console.log('[scraper] /s fallback page', page, ':', searchUrl);

    try {
      let parseResult = await fetchAndParse(searchUrl);
      let doc = parseResult.doc;

      // Search forms, divs, articles for seller name
      const containers = Array.from(doc.querySelectorAll('form, div, article, li'));
      if (containers.length === 0) {
        doc = null;
        parseResult = null;
        continue;
      }

      var bestContainer = null;
      var bestScore = -1;

      for (const c of containers) {
        const t = (c.textContent || '').toLowerCase();
        const cleanT = t.replace(/[^a-z0-9]/g, '');
        if (!cleanT.includes(sellerLower)) continue;

        // Score: seller match + price match (if provided)
        var score = 1;
        if (priceHint) {
          const priceStr = priceHint.toString();
          if (t.includes(priceStr.replace('.', '')) || t.includes(priceStr.replace('.', ','))) score += 2;
        }
        if (score > bestScore) {
          bestScore = score;
          bestContainer = c;
        }
      }

      if (!bestContainer) {
        const pagination = doc.querySelector('.ui-search-pagination, [class*="pagination" i]');
        doc = null;
        parseResult = null;
        if (!pagination) break;
        continue;
      }

      console.log('[scraper] /s found seller container, score=' + bestScore);

      // Extract installments from payment div
      var installmentsText = '';
      var interestFree = false;
      var installmentsTotal = null;
      const paymentDiv = bestContainer.querySelector('[class*="ui-pdp-payment" i]');
      if (paymentDiv) {
        const qtySpan = paymentDiv.querySelector('span:not([data-testid="price-part"])');
        const priceSpan = paymentDiv.querySelector('[data-testid="price-part"]');
        const qtyText = qtySpan ? (qtySpan.textContent || '').trim() : '';
        const priceText = priceSpan ? (priceSpan.textContent || '').trim() : '';
        const qtyMatch = qtyText.match(/(\d+)\s*x/);
        if (qtyMatch && priceText) {
          installmentsText = qtyText + ' ' + priceText;
          installmentsText = installmentsText.replace(/\s+/g, ' ').trim();
          installmentsText = cleanInstallments(installmentsText);
          interestFree = installmentsText.toLowerCase().includes('sem juros');
          installmentsTotal = calculateInstallmentsTotal(installmentsText, null);
        } else if (qtyMatch) {
          const allSpans = paymentDiv.querySelectorAll('span');
          for (const s of allSpans) {
            if (s.textContent.match(/R\$/)) {
              installmentsText = qtyText + ' ' + (s.textContent || '').trim();
              break;
            }
          }
          installmentsText = cleanInstallments(installmentsText);
          interestFree = installmentsText.toLowerCase().includes('sem juros');
          installmentsTotal = calculateInstallmentsTotal(installmentsText, null);
        }
      }

      // Extract delivery date from shipping div
      var deliveryDate = null;
      var isFreeShipping = false;
      var isFull = false;
      const shippingDiv = bestContainer.querySelector('[class*="ui-pdp-shipping" i]');
      if (shippingDiv) {
        const text = (shippingDiv.textContent || '').toLowerCase();
        isFreeShipping = text.includes('grátis');
        isFull = shippingDiv.className.toLowerCase().includes('full-icon');
        const chegaSpan = Array.from(shippingDiv.querySelectorAll('span')).find(s =>
          (s.textContent || '').toLowerCase().includes('chegará')
        );
        const shippingText = chegaSpan ? (chegaSpan.textContent || '') : text;
        deliveryDate = extractDeliveryInfo(shippingText).deliveryDate;
      }

      if (installmentsText || deliveryDate) {
        const resultData = { installmentsText: installmentsText || 'Nao informado', interestFree, installmentsTotal, deliveryDate, isFull, isFreeShipping };
        doc = null;
        parseResult = null;
        return resultData;
      }

      const pagination = doc.querySelector('.ui-search-pagination, [class*="pagination" i]');
      doc = null;
      parseResult = null;
      if (!pagination) break;

    } catch (err) {
      console.error('[scraper] /s fallback error page', page, ':', err.message);
      break;
    }
  }

  console.log('[scraper] /s fallback: seller not found in', MAX_PAGES, 'pages');
  return null;
}

async function scrapeListing(url, type) {
  try {
    const { id } = parseMercadoLivreUrl(url);

    if (type === 'catalog') {
      const baseUrl = url.replace(/#.*$/, '');
      const bestPriceUrl = buildOfferUrl(url, 'BEST_PRICE');
      const bestInstallmentsUrl = buildOfferUrl(url, 'BEST_INSTALLMENTS');

      let { doc, html, finalUrl } = await fetchAndParse(baseUrl);
      const pageType = hasRealOfferList(doc) ? 'catalog' : 'normal';

      const bodyText = doc.body?.textContent || '';
      const lowerBodyText = bodyText.toLowerCase();

      if (finalUrl.includes('account-verification') || finalUrl.includes('suspicious_traffic') ||
          lowerBodyText.includes('não sou um robô') || lowerBodyText.includes('não sou um robo') ||
          (doc.querySelector('title')?.textContent?.trim().toLowerCase() === 'mercado livre')) {
        doc = null;
        html = null;
        throw new Error('Blocked by Mercado Livre bot protection.');
      }

      const common = extractCommonFields(doc);
      const specs = extractSpecifications(doc);
      common.specifications = specs;

      let isUnavailable = false;
      if (lowerBodyText.includes('anúncio pausado') || lowerBodyText.includes('o vendedor pausou') ||
          lowerBodyText.includes('estoque esgotado') || lowerBodyText.includes('não disponível') ||
          lowerBodyText.includes('não encontramos este produto') || lowerBodyText.includes('página não encontrada')) {
        isUnavailable = true;
      }

      if (isUnavailable) {
        doc = null;
        html = null;
        return { title: common.title || 'Indisponivel', type: 'catalog', image: common.image,
          rating: common.rating, reviewsCount: common.reviewsCount, aiSummary: common.aiSummary,
          categories: common.categories, specifications: common.specifications || [], isUnavailable: true, offers: null };
      }

      const offers = { BEST_PRICE: null, BEST_INSTALLMENTS: null };

      // First: scrape the base page for the selected/bookmarked offer
      var bpSeller = null;
      var baseOffer = pageType === 'catalog'
        ? scrapeCatalogListing(doc, html)
        : scrapeNormalListing(doc, html);
      offers.BEST_PRICE = baseOffer;
      bpSeller = baseOffer.seller;
      console.log('[scraper] Base page BEST_PRICE: price=' + baseOffer.price + ' seller=' + bpSeller + ' pageType=' + pageType);

      // Keep references to fall back if necessary, then clear main references
      let savedDocForFallback = doc;
      let savedHtmlForFallback = html;
      doc = null;
      html = null;

      // Fetch both variants in parallel with a 400ms stagger delay
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const [bpRes, biRes] = await Promise.allSettled([
        fetchAndParse(bestPriceUrl),
        delay(400).then(() => fetchAndParse(bestInstallmentsUrl))
      ]);

      // Second: scrape variant URL for BEST_PRICE
      if (bpRes.status === 'fulfilled') {
        try {
          let bpDoc = bpRes.value.doc;
          let bpHtml = bpRes.value.html;
          const bpPageType2 = hasRealOfferList(bpDoc) ? 'catalog' : 'normal';
          const variantBp = bpPageType2 === 'catalog'
            ? scrapeCatalogListing(bpDoc, bpHtml)
            : scrapeNormalListing(bpDoc, bpHtml);
          if (!offers.BEST_PRICE || !offers.BEST_PRICE.price) {
            offers.BEST_PRICE = variantBp;
          }
          if (variantBp.seller && !offers.BEST_PRICE.seller) offers.BEST_PRICE.seller = variantBp.seller;
          if (variantBp.deliveryDate && !offers.BEST_PRICE.deliveryDate) offers.BEST_PRICE.deliveryDate = variantBp.deliveryDate;
          if (!offers.BEST_PRICE.isFreeShipping) offers.BEST_PRICE.isFreeShipping = variantBp.isFreeShipping;
          if (!offers.BEST_PRICE.isFull) offers.BEST_PRICE.isFull = variantBp.isFull;
          bpSeller = offers.BEST_PRICE?.seller;

          // Free variant memory
          bpDoc = null;
          bpHtml = null;
          bpRes.value.doc = null;
          bpRes.value.html = null;
        } catch (e) {
          console.warn('[scraper] Parsing BEST_PRICE variant failed:', e.message);
        }
      } else {
        console.warn('[scraper] BEST_PRICE variant fetch failed:', bpRes.reason?.message);
      }

      // /s fallback for BEST_PRICE installments if missing
      if (offers.BEST_PRICE && (!offers.BEST_PRICE.installmentsText || offers.BEST_PRICE.installmentsText === 'Nao informado') && bpSeller) {
        console.log('[scraper] /s fallback for BEST_PRICE, seller=' + bpSeller);
        const bpFallback = await fetchCatalogInstallments(baseUrl, bpSeller, offers.BEST_PRICE?.price);
        if (bpFallback) {
          offers.BEST_PRICE.installmentsText = bpFallback.installmentsText || offers.BEST_PRICE.installmentsText;
          offers.BEST_PRICE.installmentsTotal = bpFallback.installmentsTotal;
          offers.BEST_PRICE.interestFree = bpFallback.interestFree;
          if (bpFallback.deliveryDate && !offers.BEST_PRICE.deliveryDate) {
            offers.BEST_PRICE.deliveryDate = bpFallback.deliveryDate;
          }
          if (bpFallback.isFull != null) offers.BEST_PRICE.isFull = bpFallback.isFull;
          if (bpFallback.isFreeShipping != null) offers.BEST_PRICE.isFreeShipping = bpFallback.isFreeShipping;
        }
      }

      // Scrape BEST_INSTALLMENTS variant
      var biSeller = bpSeller;
      if (biRes.status === 'fulfilled') {
        try {
          let biDoc = biRes.value.doc;
          let biHtml = biRes.value.html;
          const biPageType = hasRealOfferList(biDoc) ? 'catalog' : 'normal';
          var biOffer = biPageType === 'catalog'
            ? scrapeCatalogListing(biDoc, biHtml)
            : scrapeNormalListing(biDoc, biHtml);

          if (biOffer.price === null && biSeller) {
            const fallback = await fetchCatalogInstallments(baseUrl, biSeller, biOffer.price);
            if (fallback) {
              biOffer.installmentsText = fallback.installmentsText || biOffer.installmentsText;
              biOffer.installmentsTotal = fallback.installmentsTotal;
              biOffer.interestFree = fallback.interestFree;
              if (fallback.deliveryDate && !biOffer.deliveryDate) {
                biOffer.deliveryDate = fallback.deliveryDate;
              }
              if (fallback.isFull != null) biOffer.isFull = fallback.isFull;
              if (fallback.isFreeShipping != null) biOffer.isFreeShipping = fallback.isFreeShipping;
            }
          }
          offers.BEST_INSTALLMENTS = biOffer;
          biSeller = biSeller || biOffer.seller;

          // Free variant memory
          biDoc = null;
          biHtml = null;
          biRes.value.doc = null;
          biRes.value.html = null;
        } catch (e) {
          console.warn('[scraper] Parsing BEST_INSTALLMENTS variant failed:', e.message);
        }
      } else {
        console.warn('[scraper] BEST_INSTALLMENTS fetch failed:', biRes.reason?.message);
      }

      // If no real catalog offers found (JS-rendered page), use base page data as single offer
      if (!offers.BEST_PRICE && savedDocForFallback) {
        offers.BEST_PRICE = pageType === 'catalog'
          ? scrapeCatalogListing(savedDocForFallback, savedHtmlForFallback)
          : scrapeNormalListing(savedDocForFallback, savedHtmlForFallback);
      }
      
      savedDocForFallback = null;
      savedHtmlForFallback = null;

      if (!offers.BEST_INSTALLMENTS && offers.BEST_PRICE) {
        offers.BEST_INSTALLMENTS = { ...offers.BEST_PRICE };
      }

      const cleanOffers = {};
      if (offers.BEST_PRICE) {
        cleanOffers.BEST_PRICE = {
          price: offers.BEST_PRICE.price,
          originalPrice: offers.BEST_PRICE.originalPrice,
          discountPercent: offers.BEST_PRICE.discountPercent,
          installmentsText: offers.BEST_PRICE.installmentsText,
          installmentsTotal: offers.BEST_PRICE.installmentsTotal,
          interestFree: offers.BEST_PRICE.interestFree,
          shippingCost: offers.BEST_PRICE.shippingCost,
          deliveryDate: offers.BEST_PRICE.deliveryDate,
          isFull: offers.BEST_PRICE.isFull,
          isFreeShipping: offers.BEST_PRICE.isFreeShipping,
          seller: offers.BEST_PRICE.seller
        };
      }
      if (offers.BEST_INSTALLMENTS) {
        cleanOffers.BEST_INSTALLMENTS = {
          price: offers.BEST_INSTALLMENTS.price,
          originalPrice: offers.BEST_INSTALLMENTS.originalPrice,
          discountPercent: offers.BEST_INSTALLMENTS.discountPercent,
          installmentsText: offers.BEST_INSTALLMENTS.installmentsText,
          installmentsTotal: offers.BEST_INSTALLMENTS.installmentsTotal,
          interestFree: offers.BEST_INSTALLMENTS.interestFree,
          shippingCost: offers.BEST_INSTALLMENTS.shippingCost,
          deliveryDate: offers.BEST_INSTALLMENTS.deliveryDate,
          isFull: offers.BEST_INSTALLMENTS.isFull,
          isFreeShipping: offers.BEST_INSTALLMENTS.isFreeShipping,
          seller: offers.BEST_INSTALLMENTS.seller
        };
      }

      return {
        title: common.title, type: 'catalog', image: common.image,
        rating: common.rating, reviewsCount: common.reviewsCount,
        aiSummary: common.aiSummary, categories: common.categories,
        specifications: common.specifications || [], isUnavailable: false, offers: cleanOffers
      };
    }

    // Normal listing
    let { doc, html, finalUrl } = await fetchAndParse(url);

    const bodyText = doc.body?.textContent || '';
    const lowerBodyText = bodyText.toLowerCase();

    if (finalUrl.includes('account-verification') || finalUrl.includes('suspicious_traffic') ||
        lowerBodyText.includes('não sou um robô') || lowerBodyText.includes('não sou um robo') ||
        (doc.querySelector('title')?.textContent?.trim().toLowerCase() === 'mercado livre')) {
      doc = null;
      html = null;
      throw new Error('Blocked by Mercado Livre bot protection.');
    }

    const common = extractCommonFields(doc);
    const specs = extractSpecifications(doc);
    common.specifications = specs;

    let isUnavailable = false;
    if (lowerBodyText.includes('anúncio pausado') || lowerBodyText.includes('o vendedor pausou') ||
        lowerBodyText.includes('estoque esgotado') || lowerBodyText.includes('não disponível') ||
        lowerBodyText.includes('não encontramos este produto') || lowerBodyText.includes('página não encontrada')) {
      isUnavailable = true;
    }

    if (isUnavailable) {
      doc = null;
      html = null;
      return { title: common.title || 'Indisponivel', type: 'normal', image: common.image,
        rating: common.rating, reviewsCount: common.reviewsCount, aiSummary: common.aiSummary,
        categories: common.categories, specifications: common.specifications || [], isUnavailable: true };
    }

    const offerData = scrapeNormalListing(doc, html);

    const resultData = {
      title: common.title, type: 'normal', image: common.image,
      rating: common.rating, reviewsCount: common.reviewsCount,
      aiSummary: common.aiSummary, categories: common.categories,
      specifications: common.specifications || [], isUnavailable: false,
      price: offerData.price,
      originalPrice: offerData.originalPrice,
      discountPercent: offerData.discountPercent,
      installmentsText: offerData.installmentsText,
      installmentsTotal: offerData.installmentsTotal,
      interestFree: offerData.interestFree,
      shippingCost: offerData.shippingCost,
      deliveryDate: offerData.deliveryDate,
      isFull: offerData.isFull,
      isFreeShipping: offerData.isFreeShipping,
      seller: offerData.seller
    };

    doc = null;
    html = null;
    return resultData;

  } catch (err) {
    console.error(`[ML Tracker Scraper] Error scraping ${url}:`, err.message);
    return null;
  }
}
