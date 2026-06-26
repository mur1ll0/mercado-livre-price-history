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

// Dump buybox HTML structure
const buyboxHtml = await page.evaluate(() => {
  const buyBox = document.querySelector('#buybox-form');
  if (!buyBox) return 'NO BUYBOX';
  
  const lis = buyBox.querySelectorAll('li');
  const results = [];
  lis.forEach((li, i) => {
    // Get all text content of the li
    const text = li.textContent.trim().substring(0, 500);
    // Get inner HTML structure (first 300 chars)
    const html = li.innerHTML.substring(0, 400);
    // Check for money amounts
    const moneyAmts = li.querySelectorAll('[class*="money-amount" i], [class*="price" i]');
    const moneyTexts = Array.from(moneyAmts).map(el => ({
      tag: el.tagName,
      class: el.className,
      text: el.textContent.trim().substring(0, 50)
    }));
    // Check for seller
    const sellerEls = li.querySelectorAll('[class*="seller" i], a[href*="perfil"]');
    const sellerTexts = Array.from(sellerEls).map(el => ({
      tag: el.tagName,
      class: el.className,
      text: el.textContent.trim().substring(0, 50)
    }));
    results.push({ i, text: text.substring(0, 200), moneyTexts, sellerTexts });
  });
  
  return { offerCount: lis.length, offers: results, buyboxClasses: buyBox.className };
});

console.log(JSON.stringify(buyboxHtml, null, 2));

await browser.close();
