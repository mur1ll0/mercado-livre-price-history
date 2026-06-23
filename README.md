# Mercado Livre Price History & Tracker

Um rastreador inteligente de histórico de preços para produtos do Mercado Livre com painel analítico de Custo-Benefício. O sistema coleta dados de anúncios (preço, frete, tempo de entrega, reputação, parcelamento e resumos de avaliações por IA) e agrupa anúncios distintos que vendem o mesmo produto físico usando Inteligência Artificial (LLM).

---

## 🚀 Funcionalidades Principal

- **Raspagem Stealth com Puppeteer:** Ignora bloqueios do Cloudflare e captcha para capturar preços (atual e original), disponibilidade, se é Full, frete grátis, parcelamento sem juros e o resumo de opiniões gerado por IA.
- **Deduplicação de Produtos com IA (OpenRouter):** Anúncios diferentes (Ex: com IDs de catálogo `MLB...` vs links de vendedor comum) contendo o mesmo produto são consolidados em um único produto unificado utilizando o modelo `google/gemini-2.5-flash`.
- **Fórmula de Custo-Benefício Dinâmica:** Classifica cada anúncio de 0 a 100 baseado em:
  - **Preço (45%):** Relação do preço atual com o menor preço histórico detectado.
  - **Frete (20%):** Envio Grátis, Full e tempo de entrega estimado.
  - **Parcelamento (20%):** Presença de parcelamento sem juros.
  - **Avaliação do Produto (15%):** Média de estrelas do produto principal.
- **Autenticação com Google Sign-In:** Integração moderna utilizando a biblioteca oficial Google Identity Services com suporte a One Tap login local e em produção.
- **Dual Execution (Raspagem Híbrida):** 
  - **Local (Desenvolvimento):** Executa raspagens assíncronas em segundo plano utilizando um navegador local via Puppeteer.
  - **Nuvem (Produção/Vercel):** Dispara triggers via API de Dispatch do GitHub Actions para executar as raspagens em workers dedicados, burlando limites de timeout serverless e uso de recursos em nuvem.
- **Painel Responsivo (Dashboard Glassmorphic):** Interface web escura, moderna e polida utilizando conceitos de glassmorfismo, gráficos de histórico de preços interativos (Chart.js) e cartões dinâmicos de estatísticas.

---

## 🛠️ Arquitetura do Banco de Dados (MongoDB)

O banco é estruturado em 5 coleções principais para suportar a unificação por IA:

1. **Users:** Informações do perfil do usuário obtidas pelo login do Google.
2. **UnifiedProducts:** O produto físico consolidado (Ex: *Apple AirPods Pro 3*). Armazena a categoria unificada, nota média de estrelas e o resumo de opiniões por IA.
3. **Announcements:** Os links/anúncios específicos do Mercado Livre que vendem o produto. Vincula-se ao `UnifiedProduct` correspondente.
4. **PriceRecords:** Registro diário de preços de cada anúncio individual para montagem do gráfico histórico.
5. **UserProducts:** Tabela de junção N-para-N que vincula quais usuários estão rastreando quais produtos unificados.

---

## 💻 Instalação e Configuração Local

### Pré-requisitos
- **Node.js** (v18+)
- **MongoDB** rodando localmente ou uma string de conexão do **MongoDB Atlas**.
- Credenciais do **Google Cloud Console** (Google Client ID habilitado para `http://localhost:3000`).
- Uma chave de API do **OpenRouter** para a deduplicação de IA.

### Passo a Passo

1. **Clonar o Repositório:**
   ```bash
   git clone https://github.com/seu-usuario/mercado-livre-price-history.git
   cd mercado-livre-price-history
   ```

2. **Instalar Dependências:**
   ```bash
   npm install
   ```

3. **Configurar Variáveis de Ambiente:**
   Crie um arquivo `.env` na raiz do projeto (use o `.env.example` como guia):
   ```env
   PORT=3000
   MONGODB_URI="sua_string_de_conexao_mongodb"
   JWT_SECRET="um_secret_jwt_qualquer"
   GOOGLE_CLIENT_ID="seu_client_id_do_google.apps.googleusercontent.com"
   OPENROUTER_API_KEY="sua_chave_openrouter"
   
   # Opcional (Para Deploy em Produção na Vercel):
   GITHUB_PAT="seu_github_personal_access_token"
   GITHUB_REPO="seu-usuario/mercado-livre-price-history"
   ```

4. **Rodar a Aplicação Localmente:**
   ```bash
   npm run dev
   ```
   Abra `http://localhost:3000` no seu navegador. O login com Google e a raspagem local em segundo plano estarão 100% operacionais.

---

## ☁️ Deploy e Automação de Cron diário

### Backend e Frontend na Vercel
O projeto é configurado nativamente para a Vercel através do arquivo `vercel.json` que direciona a API para `/api` e a pasta `public/` como assets estáticos.

1. Conecte o repositório na Vercel.
2. Configure as mesmas variáveis do arquivo `.env` nas configurações de Environment Variables do projeto na Vercel.

### Automação de Atualização com GitHub Actions
Para coletar preços diariamente sem custos e sem limites de timeout de funções serverless, configuramos uma Action no GitHub:

1. No seu repositório no GitHub, acesse **Settings > Secrets and variables > Actions**.
2. Adicione as seguintes variáveis como **Repository Secrets**:
   - `MONGODB_URI`: String de conexão com o banco Atlas.
   - `OPENROUTER_API_KEY`: Chave do OpenRouter para o match de novos anúncios.
3. O workflow [scrape-cron.yml](.github/workflows/scrape-cron.yml) roda automaticamente todas as noites à meia-noite (UTC) e atualiza os preços de todos os anúncios ativos no banco.
