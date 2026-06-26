import dotenv from 'dotenv';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const URL = 'https://www.mercadolivre.com.br/apple-airpods-pro-3/p/MLB54106888/s?pdp_filters=item_id%3AMLB4668926493&sid=bookmarks&page=1';
const SELLER = 'primetech20';
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

console.log('🔍 Debug /s fallback for seller:', SELLER);
console.log('📍 URL:', URL);

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

console.log('🌐 Navegando para a página /s...');
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

// Check if redirected to login
const pageUrl = page.url();
console.log('📍 URL final:', pageUrl);
if (pageUrl.includes('/login') || pageUrl.includes('/account-verification')) {
  console.log('❌ Redirecionado para login! Faça login no navegador que abriu.');
}

// Wait for manual login
console.log('⏳ Aguardando você fazer login (se necessário)...');
console.log('   Digite "Ok" no chat quando estiver logado.');

// Don't close - let the user interact
console.log('\n📋 Analisando DOM...');

// Check what forms/articles exist
const formCount = await page.evaluate(() => document.querySelectorAll('form').length);
const articleCount = await page.evaluate(() => document.querySelectorAll('article').length);
const shopItemCount = await page.evaluate(() => document.querySelectorAll('[data-testid="shop-item"]').length);
const actionBtns = await page.evaluate(() => document.querySelectorAll('[data-testid="action-modal-link"]').length);

console.log('  <form>:', formCount);
console.log('  <article>:', articleCount);
console.log('  [data-testid="shop-item"]:', shopItemCount);
console.log('  [data-testid="action-modal-link"]:', actionBtns);

// Look for seller name in action buttons
const sellerMatches = await page.evaluate((seller) => {
  const btns = document.querySelectorAll('[data-testid="action-modal-link"]');
  const results = [];
  btns.forEach((btn, i) => {
    const spans = Array.from(btn.querySelectorAll('span'));
    const texts = spans.map(s => s.textContent.trim()).join(' | ');
    const lower = texts.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = lower.includes(seller.toLowerCase().replace(/[^a-z0-9]/g, ''));
    results.push({ i, texts, match });
  });
  return results;
}, SELLER);

console.log('\n📦 Botões action-modal-link encontrados:');
sellerMatches.forEach(m => {
  console.log(`  [${m.i}] "${m.texts}" → match=${m.match}`);
});

// Look for payment divs
const paymentDivs = await page.evaluate(() => {
  const divs = document.querySelectorAll('[class*="ui-pdp-payment" i]');
  return Array.from(divs).map(d => ({
    class: d.className,
    html: d.innerHTML.substring(0, 300)
  }));
});

console.log('\n💳 Divs de payment encontradas:', paymentDivs.length);
paymentDivs.forEach((d, i) => {
  console.log(`  [${i}] class="${d.class}"`);
  console.log(`      html="${d.html}"`);
});

// Look for shipping divs
const shippingDivs = await page.evaluate(() => {
  const divs = document.querySelectorAll('[class*="ui-pdp-shipping" i]');
  return Array.from(divs).map(d => ({
    class: d.className,
    text: d.textContent.trim().substring(0, 200)
  }));
});

console.log('\n🚚 Divs de shipping encontradas:', shippingDivs.length);
shippingDivs.forEach((d, i) => {
  console.log(`  [${i}] class="${d.class}"`);
  console.log(`      text="${d.text}"`);
});

// Also check all span texts in the page that contain "primetech" or seller
const sellerTexts = await page.evaluate((seller) => {
  const spans = document.querySelectorAll('span');
  return Array.from(spans)
    .filter(s => s.textContent.toLowerCase().includes(seller.toLowerCase().substring(0, 5)))
    .slice(0, 10)
    .map(s => s.textContent.trim().substring(0, 100));
}, SELLER);

console.log('\n🔤 Spans contendo "prime":');
sellerTexts.forEach(t => console.log('  ' + t));

// Keep browser open for manual inspection
console.log('\n✅ Navegador mantido aberto para inspeção manual.');
console.log('   Feche o navegador ou pressione Ctrl+C para encerrar.');
