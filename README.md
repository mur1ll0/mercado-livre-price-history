# Mercado Livre Price History & Tracker

Rastreador de histórico de preços do Mercado Livre com painel analítico de custo-benefício e extensão de navegador para scraping autenticado. O sistema coleta dados de anúncios (preço, frete, prazo de entrega, parcelamento e avaliações) e agrupa anúncios do mesmo produto físico usando IA (LLM via OpenRouter).

---

## Funcionalidades

- **Browser Extension (Chrome + Firefox):** Raspagem usando a sessão real do navegador do usuário — sem precisar de login separado no Mercado Livre. A extensão faz polling de jobs pendentes via API, acessa as páginas com os cookies do navegador, e envia os dados coletados de volta.
- **Scraping Híbrido:** Modo local (Puppeteer + Chromium) ou via extensão de navegador (fetch + DOMParser). Ambos compartilham a mesma lógica de extração.
- **Catálogo com Ofertas:** Para anúncios de catálogo (`/p/MLB...`), coleta BEST_PRICE (menor preço à vista) e BEST_INSTALLMENTS (melhor parcelamento), com fallback `/s` para parcelamento via DOM.
- **Deduplicação com IA (OpenRouter):** Anúncios diferentes do mesmo produto são consolidados usando Jaccard similarity + LLM (`meta-llama/llama-3-8b-instruct:free`).
- **Score de Custo-Benefício (0-100):** Preço (40%) + Desconto (10%) + Frete (20%) + Parcelamento (15%) + Avaliação (15%).
- **Autenticação Google Sign-In:** Login via Google Identity Services com JWT.
- **Dashboard Glassmorphic:** Interface escura com gráficos de histórico (Chart.js), tabela comparativa de anúncios, e atualização automática ao final do scraping.

---

## Arquitetura

### Modos de Scraping

| Modo | Tecnologia | Login ML |
|---|---|---|
| **Extensão (Chrome/Firefox)** | `fetch()` + DOMParser + cookies reais | Sessão do navegador |
| **Local** | Puppeteer + Chromium | Perfil `.browser-data/` |

### Fluxo com Extensão

```
1. Usuário clica "Atualizar Preços" ou adiciona um link
2. API marca anúncios como scrapeStatus='pending'
3. Extensão faz polling GET /api/scrape/jobs a cada 60s
4. Para cada job, fetch() na página do ML com cookies do navegador
5. DOMParser extrai: preço, vendedor, frete, parcelamento, prazo
6. POST /api/scrape/data → salva no MongoDB
7. Frontend faz polling GET /api/scrape/status → atualiza ao terminar
```

---

## Instalação

### Pré-requisitos
- Node.js v18+
- MongoDB (local ou Atlas)
- Google Cloud Console (OAuth Client ID)
- OpenRouter API key

### Backend

```bash
git clone <repo>
cd mercado-livre-price-history
npm install
```

Configure o `.env`:
```env
PORT=3000
MONGODB_URI=sua_string_mongodb
JWT_SECRET=seu_secret
GOOGLE_CLIENT_ID=seu_client_id
OPENROUTER_API_KEY=sk-or-v1-...
```

```bash
npm run dev
```

### Extensão Chrome

1. Acesse `chrome://extensions`
2. Ative "Modo do desenvolvedor"
3. "Carregar sem compactação" → selecione a pasta `extensions/chrome/`
4. Abra `http://localhost:3000`, faça login com Google
5. Abra o popup da extensão — configuração automática

### Extensão Firefox

1. Acesse `about:debugging` → "Este Firefox"
2. "Carregar extensão temporária" → selecione `extensions/firefox/manifest.json`
3. Mesmo fluxo de configuração automática

---

## API Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/config` | Retorna `googleClientId` |
| `POST` | `/api/auth/google` | Login com Google |
| `GET` | `/api/auth/me` | Perfil do usuário |
| `GET` | `/api/products/ranked` | Produtos rastreados com scores e histórico |
| `GET` | `/api/categories` | Árvore de categorias |
| `POST` | `/api/products/track` | Adicionar link para rastrear (já inicia scraping) |
| `DELETE` | `/api/products/track/:id` | Parar de rastrear |
| `POST` | `/api/products/scrape` | Marcar todos anúncios como pendentes |
| `POST` | `/api/products/scrape/:productId` | Marcar anúncios de um produto como pendentes |
| `GET` | `/api/scrape/status` | Status do scraping (polling) |
| `GET` | `/api/scrape/jobs` | Lista jobs pendentes (extensão) |
| `POST` | `/api/scrape/data` | Recebe dados do scraping (extensão) |

---

## Banco de Dados (MongoDB)

### Coleções
- **users** — Perfis Google OAuth
- **unifiedproducts** — Produto físico consolidado (IA)
- **announcements** — Anúncios do ML com `scrapeStatus`, `offers` (catálogo), `deliveryDate`
- **pricerecords** — Histórico diário de preços (com `offers.BEST_PRICE` e `offers.BEST_INSTALLMENTS`)
- **userproducts** — Junção N:N usuário ↔ produto
- **categories** — Árvore hierárquica

### Campo `scrapeStatus`
- `null` — nunca escaneado
- `pending` — aguardando extensão
- `done` — escaneado com sucesso

---

## Comandos

```bash
npm run dev           # Servidor local
npm run clean-db      # Limpar todas as coleções do MongoDB
npm run build         # Gerar ZIPs das extensões
```

## Deploy (Vercel)

O `postinstall` gera `public/extensions/chrome.zip` e `firefox.zip` automaticamente. As extensões ficam disponíveis para download em `/extensions/chrome.zip` e `/extensions/firefox.zip`.
