import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '..', '.browser-data');

const urls = [
  { id: 'MLB54106888', url: 'https://www.mercadolivre.com.br/apple-airpods-pro-3/p/MLB54106888?pdp_filters=item_id%3AMLB4668926493&sid=bookmarks' },
  { id: 'MLBU3790908780', url: 'https://www.mercadolivre.com.br/apple-airpods-pro-3-branco/up/MLBU3790908780' },
  { id: 'MLB19049048', url: 'https://www.mercadolivre.com.br/whey-protein-concentrado-1kg-growth-supplements-milkshake-de-chocolate/p/MLB19049048' },
  { id: 'MLB51970330', url: 'https://www.mercadolivre.com.br/aspirador-de-po-vertical-philco-pas56-sem-fio-2-em-1-para-casa-com-bateria-de-litio/p/MLB51970330' },
  { id: 'MLB19507858', url: 'https://www.mercadolivre.com.br/xiaomi-mi-smart-speaker-ir-control-l05g-cor-preto/p/MLB19507858' },
];

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: BROWSER_DATA_DIR,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
});

// Check if logged in first
const loginPage = await browser.newPage();
await loginPage.goto('https://www.mercadolivre.com.br', { waitUntil: 'networkidle2', timeout: 30000 });
const loggedIn = await loginPage.evaluate(() => !document.querySelector('a[href*="login" i]'));
await loginPage.close();

if (!loggedIn) {
  console.log('❌ Nao esta logado no ML. Abra o navegador, faca login, e rode de novo.');
  await browser.close();
  process.exit(0);
}

console.log('✅ Logado no ML!\n');

for (const { id, url } of urls) {
  console.log(`\n=== ${id} ===`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const data = await page.evaluate(() => {
      const allEls = document.querySelectorAll('span, a, button, p, div');
      const vendidoEls = Array.from(allEls).filter(el => 
        (el.textContent || '').trim().toLowerCase() === 'vendido por'
      );
      return {
        vendidoCount: vendidoEls.length,
        vendidoDetails: vendidoEls.map(el => {
          const parent = el.parentElement;
          const parentsHTML = parent ? parent.innerHTML.substring(0, 400) : 'no parent';
          const buttons = parent ? Array.from(parent.querySelectorAll('button span, a span, button, a')).map(b => ({ tag: b.tagName, text: (b.textContent||'').trim().substring(0, 50) })) : [];
          return { tag: el.tagName, parentHTML: parentsHTML, buttons };
        }),
        profileLinks: Array.from(document.querySelectorAll('a[href*="/perfil/"]')).map(a => a.textContent.trim().substring(0, 50)),
        soldByRegex: (document.body?.textContent || '').match(/Vendido por\s*(\S[\s\S]{0,60}?)(?:\+|\||\n)/)?.[1],
        specs: Array.from(document.querySelectorAll('h2, h3, h4')).filter(h => (h.textContent||'').toLowerCase().includes('características')).map(h => {
          const tbl = h.parentElement?.querySelector('table');
          const rows = tbl ? Array.from(tbl.querySelectorAll('tr')).slice(0, 5).map(r => {
            const tds = r.querySelectorAll('td, th');
            return tds.length >= 2 ? (tds[0].textContent.trim() + ': ' + tds[1].textContent.trim()) : '';
          }).join(' | ') : 'no table';
          return { tag: h.tagName, hasTable: !!tbl, sample: rows.substring(0, 150) };
        }),
        hasBuyBox: !!document.querySelector('#buybox-form'),
      };
    });
    
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  
  await page.close();
}

await browser.close();
console.log('\n✅ Done');
