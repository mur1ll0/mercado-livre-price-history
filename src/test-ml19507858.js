import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

const URL = 'https://www.mercadolivre.com.br/xiaomi-mi-smart-speaker-ir-control-l05g-cor-preto/p/MLB19507858';

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

console.log('🌐 Navegando...');
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(resolve => setTimeout(resolve, 4000));

const data = await page.evaluate(() => {
  const buyBoxForm = document.querySelector('#buybox-form');
  if (!buyBoxForm) return { hasBuyBox: false, hasOfferList: false, reason: 'no #buybox-form' };

  const ul = buyBoxForm.querySelector('ul');
  if (!ul) return { hasBuyBox: true, hasOfferList: false, reason: 'no ul in buybox' };

  const lis = ul.querySelectorAll('li');
  if (!lis.length) return { hasBuyBox: true, hasOfferList: false, reason: 'no li in ul' };

  const offerDetails = Array.from(lis).map(el => ({
    hasRadio: !!el.querySelector('input[type="radio"]'),
    hasPrice: !!el.querySelector('.andes-money-amount'),
    sellerText: (el.textContent||'').match(/Vendido por\s*\S+/)?.[0] || '',
    selected: el.classList.contains('selected') || !!el.querySelector('[aria-selected="true"]')
  }));

  const hasRealOffer = offerDetails.some(o => o.hasRadio || o.hasPrice || /vendido/i.test(o.sellerText));

  return {
    hasBuyBox: true,
    offerCount: lis.length,
    hasOfferList: hasRealOffer,
    details: offerDetails
  };
});

console.log(JSON.stringify(data, null, 2));

await browser.close();
