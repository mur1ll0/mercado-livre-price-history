import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

const URL = 'https://www.mercadolivre.com.br/apple-airpods-pro-3/p/MLB54106888?pdp_filters=item_id%3AMLB4668926493&sid=bookmarks';

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(resolve => setTimeout(resolve, 4000));

// Find ALL prices and sellers on the page
const data = await page.evaluate(() => {
  const moneyAmts = document.querySelectorAll('.andes-money-amount');
  const prices = Array.from(moneyAmts).map(el => {
    const frac = el.querySelector('.andes-money-amount__fraction')?.textContent || '';
    const cents = el.querySelector('.andes-money-amount__cents')?.textContent || '';
    const isPrev = (el.className || '').includes('--previous');
    return { price: frac + (cents ? ',' + cents : ''), isPrev, class: el.className };
  });
  
  const sellerLinks = document.querySelectorAll('a[href*="/perfil/"]');
  const sellers = Array.from(sellerLinks).map(el => el.textContent.trim());
  
  const soldBy = (document.body.textContent || '').match(/Vendido por\s*(\S[\s\S]{0,30}?)(?:\+|\||$)/);
  
  // Check for typical normal-listing elements
  const hasBuyBox = !!document.querySelector('#buybox-form');
  const hasUiPdpPrice = !!document.querySelector('.ui-pdp-price');
  const hasPricingSubtitle = document.querySelector('#pricing_price_subtitle')?.textContent;
  
  return { prices, sellers, soldBy: soldBy ? soldBy[1].trim() : null, hasBuyBox, hasUiPdpPrice, hasPricingSubtitle };
});

console.log(JSON.stringify(data, null, 2));

await browser.close();
