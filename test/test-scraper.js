import { scrapeMercadoLivre } from './scraper.js';

async function test() {
  const url1 = 'https://www.mercadolivre.com.br/apple-airpods-pro-3/p/MLB54106888';
  const url2 = 'https://www.mercadolivre.com.br/apple-airpods-pro-3/up/MLBU3468893823';

  console.log('=== TEST 1: Catalog Product Link ===');
  try {
    const data1 = await scrapeMercadoLivre(url1);
    console.log('SUCCESS:');
    console.log(JSON.stringify(data1, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  console.log('\n=== TEST 2: Seller/Upgraded Product Link ===');
  try {
    // Introduce a brief delay
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const data2 = await scrapeMercadoLivre(url2);
    console.log('SUCCESS:');
    console.log(JSON.stringify(data2, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
  }
}

test();
