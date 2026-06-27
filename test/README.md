# Test Scripts

Scripts de diagnóstico e debugging. Rode com `node test/<script>.js`.

## Verificação de API

| Script | Descrição |
|---|---|
| `test-openrouter.js` | Testa conexão com OpenRouter — valida API key e modelo configurado |
| `list-openrouter-models.js` | Lista modelos disponíveis vs indisponíveis no OpenRouter |

## Inspeção de DOM

| Script | Descrição |
|---|---|
| `inspect-page-prices.js` | Abre um Chromium, navega para uma URL e lista todos os preços e vendedores na página. Útil para debug de extração de preço/seller |
| `inspect-buybox.js` | Abre Chromium e inspeciona o `#buybox-form` — mostra estrutura dos `<li>` de ofertas, textos, money amounts e sellers |
| `inspect-bookmark.js` | Testa scraping de URL com `pdp_filters` (bookmarks). Verifica se a página com filtro de bookmark é carregada corretamente |
| `inspect-s-fallback.js` | Inspeciona a página `/s` de catálogo — mostra forms, payment divs, shipping divs e sellers. Usado para debug do fallback de parcelamento |
| `inspect-links.js` | Script genérico para inspecionar múltiplas URLs — mostra vendido, profile links, regex matches, specs e buybox de cada página |

## Scraper Test

| Script | Descrição |
|---|---|
| `test-scraper.js` | Testa o scraper Puppeteer (`src/scraper.js`) contra URLs hardcoded. Roda o fluxo completo de scraping local |
