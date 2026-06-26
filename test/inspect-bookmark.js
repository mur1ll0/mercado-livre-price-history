import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

const URL = 'https://www.mercadolivre.com.br/apple-airpods-pro-3/p/MLB54106888?pdp_filters=item_id%3AMLB4668926493&sid=bookmarks';

console.log('🔍 Testing scraper against bookmarked URL');
console.log('📍 URL:', URL);

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

console.log('🌐 Navegando...');
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(resolve => setTimeout(resolve, 4000));

const html = await page.content();

// Check what the page actually shows
const data = await page.evaluate(() => {
  const title = document.querySelector('.ui-pdp-title')?.textContent?.trim() || 'N/A';
  const buyBox = document.querySelector('#buybox-form');
  const lis = buyBox ? buyBox.querySelectorAll('li') : [];
  const selectedLi = document.querySelector('li.selected, li[aria-selected="true"]');
  
  const offers = [];
  lis.forEach((li, i) => {
    const price = li.querySelector('.andes-money-amount__fraction')?.textContent || '';
    const sellerMatch = li.textContent.match(/Vendido por\s*(\S+)/);
    const isSelected = li === selectedLi;
    offers.push({ i, price, seller: sellerMatch ? sellerMatch[1] : 'N/A', selected: isSelected });
  });
  
  return { title, offerCount: lis.length, offers, hasBuyBox: !!buyBox };
});

console.log('📋 Page data:', JSON.stringify(data, null, 2));

// Check if pdp_filters is preserved
console.log('📍 Final URL:', page.url());
console.log('🔗 URL has pdp_filters:', page.url().includes('pdp_filters'));
console.log('🔗 URL has item_id:', page.url().includes('item_id'));

await browser.close();
console.log('✅ Done');
