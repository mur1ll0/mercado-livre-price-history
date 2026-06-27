# Mercado Livre Price History & Tracker

Rastreador de histórico de preços do Mercado Livre com painel analítico de custo-benefício e extensão de navegador para scraping autenticado. O sistema coleta dados de anúncios (preço, frete, prazo de entrega, parcelamento e avaliações) e agrupa anúncios do mesmo produto físico usando IA (LLM via OpenRouter).

---

## Funcionalidades

- **Browser Extension (Chrome + Firefox):** Raspagem usando a sessão real do navegador do usuário — sem precisar de login separado no Mercado Livre. A extensão faz polling de jobs pendentes via API, acessa as páginas com os cookies do navegador, e envia os dados coletados de volta.
- **Catálogo com Ofertas:** Para anúncios de catálogo (`/p/MLB...`), coleta BEST_PRICE (menor preço à vista) e BEST_INSTALLMENTS (melhor parcelamento), com fallback `/s` para parcelamento via DOM.
- **Deduplicação com IA (OpenRouter):** Anúncios diferentes do mesmo produto são consolidados usando Jaccard similarity + LLM.
- **Score de Custo-Benefício (0-100):** Preço (40%) + Desconto (10%) + Frete (20%) + Parcelamento (15%) + Avaliação (15%).
- **Autenticação Google Sign-In:** Login via Google Identity Services com JWT.
- **Dashboard Glassmorphic:** Interface escura com gráficos de histórico (Chart.js), tabela comparativa de anúncios, e atualização automática ao final do scraping.

---

## Arquitetura

### Modo de Scraping

O scraping é feito exclusivamente via **extensão de navegador** (Chrome/Firefox) que utiliza cookies reais da sessão do Mercado Livre do usuário.

| Tecnologia | Login ML |
|---|---|
| `fetch()` + DOMParser + cookies reais | Sessão do navegador |

> O modo Puppeteer local (`cron-scraper.js`) existe como fallback para execução via GitHub Actions, mas o fluxo principal é pela extensão.

### Fluxo de Scraping

```
1. Usuário clica "Atualizar Preços" ou adiciona um link
2. API marca anúncios como scrapeStatus='pending'
3. Extensão faz polling GET /api/scrape/jobs a cada 60s
4. Para cada job, fetch() na página do ML com cookies do navegador
5. DOMParser extrai: preço, vendedor, frete, parcelamento, prazo
6. POST /api/scrape/data → salva no MongoDB
7. Frontend faz polling GET /api/scrape/status → atualiza ao terminar
```

### Scrape Status Tracking (`scrapestatuses` collection)

Estado de scraping persiste no MongoDB — sobrevive a restarts de containers serverless do Vercel:

- **Model:** `src/models/ScrapeStatus.js` — `{ userId, state, message, updatedAt }`
- **States:** `idle` → `needs_login` → `running` → `done` | `error`
- Backend auto-corrige `idle` para `running` se existirem anúncios pendentes

### Deduplicação de Produtos (`src/services/ai-matcher.js`)

Dois níveis: similaridade Jaccard → OpenRouter LLM.

### Estrutura de Arquivos

```
├── api/index.js              # Vercel serverless entry point
├── src/
│   ├── server.js             # Local dev entry point (Express)
│   ├── app.js                # Express app (local + Vercel)
│   ├── db.js                 # MongoDB connection (IPv4 DNS fix)
│   ├── cron-scraper.js       # Puppeteer scraper (GitHub Actions fallback)
│   ├── models/               # Mongoose models (6 coleções)
│   │   ├── Announcement.js   # Anúncios MLB/MLBU
│   │   ├── Category.js       # Categorias hierárquicas
│   │   ├── PriceRecord.js    # Histórico diário de preços
│   │   ├── ScrapeStatus.js   # Estado de scraping por usuário
│   │   ├── UnifiedProduct.js # Produtos deduplicados
│   │   ├── User.js           # Usuários Google OAuth
│   │   └── UserProduct.js    # Relação usuário↔produto
│   └── services/
│       ├── ai-matcher.js     # Deduplicação com IA
│       └── scrape-status.js  # CRUD de ScrapeStatus
├── public/                   # Frontend estático
├── extensions/
│   ├── chrome/               # Manifest V3
│   └── firefox/              # Manifest V2
├── vercel.json               # Vercel build + routing
└── .github/workflows/
    └── scrape-cron.yml       # GitHub Actions (Puppeteer, fallback)
```

---

## Instalação

### Pré-requisitos

- Node.js v18+
- MongoDB (Atlas ou local)
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

| Coleção | Descrição |
|---|---|
| `users` | Perfis Google OAuth |
| `unifiedproducts` | Produto físico consolidado (IA) |
| `announcements` | Anúncios do ML com `scrapeStatus`, `offers` (catálogo), `deliveryDate` |
| `pricerecords` | Histórico diário de preços (com `offers.BEST_PRICE` e `offers.BEST_INSTALLMENTS`) |
| `userproducts` | Junção N:N usuário ↔ produto |
| `categories` | Árvore hierárquica |
| `scrapestatuses` | Estado de scraping por usuário (persiste em serverless) |

### Campo `scrapeStatus`

- `null` — nunca escaneado
- `pending` — aguardando extensão
- `done` — escaneado com sucesso

---

## Comandos

```bash
npm run dev              # Servidor local (localhost:3000)
npm run clean-db         # Limpar todas as coleções do MongoDB
npm run build            # Sincronizar Chrome→Firefox + gerar ZIPs das extensões
npm run test-scraper     # Testar scraper contra URLs hardcoded
npm run test-openrouter  # Testar conexão OpenRouter
```

---

## Deploy (Vercel)

### Variáveis de Ambiente (Vercel)

Configure no dashboard do Vercel (Settings → Environment Variables):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MONGODB_URI` | Sim | String de conexão do MongoDB Atlas |
| `JWT_SECRET` | Sim | Chave para assinar tokens JWT |
| `GOOGLE_CLIENT_ID` | Sim | Google OAuth Client ID |
| `OPENROUTER_API_KEY` | Sim | Chave da API OpenRouter |
| `VERCEL` | Automática | Detecta ambiente serverless (setado pelo Vercel) |

O `postinstall` gera `public/extensions/chrome.zip` e `firefox.zip` automaticamente. As extensões ficam disponíveis em `/extensions/chrome.zip` e `/extensions/firefox.zip`.
