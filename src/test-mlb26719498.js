import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
});

// Test BEST_PRICE variant
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

console.log('=== BEST_PRICE variant ===');
await page.goto('https://www.mercadolivre.com.br/fone-de-ouvido-sony-wf-1000xm5-tws-nc-bluetooth-cor-preto/p/MLB26719498?offer_type=BEST_PRICE', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(resolve => setTimeout(resolve, 4000));

const bpData = await page.evaluate(() => {
  // Check buybox list structure
  const buyBox = document.querySelector('#buybox-form');
  const ul = buyBox?.querySelector('ul');
  const lis = ul ? Array.from(ul.querySelectorAll('li')) : [];
  
  const selected = lis.find(li => li.classList.contains('selected') || li.querySelector('[aria-selected="true"]'));
  
  // Look for "Chegará" in the selected li
  const chegaSpans = selected ? Array.from(selected.querySelectorAll('*')).filter(el => (el.textContent||'').toLowerCase().includes('chegará') && el.textContent.length < 200) : [];
  
  // Check all elements with "chegará" in the buybox
  const allChegaBuybox = Array.from(buyBox?.querySelectorAll('*') || []).filter(el => (el.textContent||'').toLowerCase().includes('chegará') && el.textContent.length < 200);
  
  return {
    liCount: lis.length,
    hasSelected: !!selected,
    selectedText: selected?.textContent?.substring(0, 300),
    chegaInSelected: chegaSpans.map(s => ({ tag: s.tagName, text: s.textContent.trim().substring(0, 150) })),
    chegaInBuybox: allChegaBuybox.map(s => ({ tag: s.tagName, text: s.textContent.trim().substring(0, 150) })),
    fullBuyboxText: buyBox?.textContent?.substring(0, 500)
  };
});

console.log(JSON.stringify(bpData, null, 2));
await page.close();

// Test /s fallback
console.log('\n=== /s fallback ===');
const sPage = await browser.newPage();
await sPage.setViewport({ width: 1280, height: 800 });
await sPage.goto('https://www.mercadolivre.com.br/fone-de-ouvido-sony-wf-1000xm5-tws-nc-bluetooth-cor-preto/p/MLB26719498/s?page=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(resolve => setTimeout(resolve, 4000));

const sData = await sPage.evaluate((seller) => {
  const sellerLower = seller.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Find forms containing the seller
  const forms = document.querySelectorAll('form');
  const matches = [];
  forms.forEach((f, i) => {
    const text = (f.textContent || '').toLowerCase();
    if (text.includes(sellerLower)) {
      // Find payment div
      const payDiv = f.querySelector('[class*="ui-pdp-payment" i]');
      const shipDiv = f.querySelector('[class*="ui-pdp-shipping" i]');
      const pricePart = f.querySelector('[data-testid="price-part"]');
      const qtySpan = f.querySelector('span:not([data-testid="price-part"])');
      
      matches.push({
        formIndex: i,
        hasPayment: !!payDiv,
        hasShipping: !!shipDiv,
        paymentQty: qtySpan?.textContent?.trim(),
        paymentPrice: pricePart?.textContent?.trim(),
        shippingText: shipDiv?.textContent?.trim()?.substring(0, 150)
      });
    }
  });
  return { matchCount: matches.length, details: matches };
}, 'AMC_SHOOP');

console.log(JSON.stringify(sData, null, 2));
await sPage.close();

await browser.close();
console.log('\n✅ Done');
