import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.log('❌ OPENROUTER_API_KEY NÃO está definida no .env');
  console.log('   Verifique se existe uma linha assim no arquivo .env:');
  console.log('   OPENROUTER_API_KEY=sk-or-v1-...');
  process.exit(1);
}

console.log('✅ OPENROUTER_API_KEY encontrada (primeiros 10 chars):', apiKey.substring(0, 10) + '...');

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/mur1ll0/mercado-livre-price-history',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'meta-llama/llama-3-8b-instruct',
    messages: [{ role: 'user', content: 'Responda apenas com a palavra: OK' }],
    temperature: 0.1,
    max_tokens: 10
  })
});

const data = await response.json();

if (response.ok) {
  const reply = data?.choices?.[0]?.message?.content?.trim();
  console.log('✅ OpenRouter respondeu:', reply);
  console.log('   Modelo:', data.model);
  console.log('   Tokens usados:', data.usage?.total_tokens);
} else {
  console.log('❌ Erro na API:', response.status);
  console.log(JSON.stringify(data, null, 2));
}
