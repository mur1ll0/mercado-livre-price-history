import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

puppeteer.use(StealthPlugin());

async function inspect(url, name) {
  console.log(`\n================ INSPECTING: ${name} ================`);
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
    });

    console.log(`Navigating to ${url}...`);
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Current URL:', page.url());
    console.log('Title:', await page.title());
    console.log('Status:', response ? response.status() : 'No response');
    
    await new Promise(resolve => setTimeout(resolve, 4000));
    const html = await page.content();
    console.log('HTML Length:', html.length);
    
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    console.log('Body Text (start):', bodyText.substring(0, 500));

    console.log('\n--- Main Price Elements (Cheerio) ---');
    console.log('ui-pdp-price count:', $('.ui-pdp-price').length);
    console.log('andes-money-amount count:', $('.andes-money-amount').length);
    
    $('.andes-money-amount').slice(0, 10).each((i, el) => {
      console.log(`Index ${i}: Text: "${$(el).text().trim()}" | Classes: "${$(el).attr('class')}" | Parent: "${$(el).parent().attr('class')}"`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
  }
}

async function run() {
  await inspect(
    'https://www.mercadolivre.com.br/apple-airpods-pro-3/up/MLBU3468893823#polycard_client=search-desktop&be_origin=backend&search_layout=grid&position=5&type=product&float_highlight=last_units&tracking_id=d9812dd7-4d10-4f9f-b800-fa35f445ec35&wid=MLB5772632804&sid=search',
    'Link 1 - AirPods Pro 3 Promo'
  );
}

run();
