import dotenv from 'dotenv';
dotenv.config();

const MODELS = [
  'meta-llama/llama-3-8b-instruct',
  'google/gemini-2.0-flash-001',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
  'deepseek/deepseek-r1:free',
];

for (const model of MODELS) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say OK' }],
        max_tokens: 10
      })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`✅ ${model} — OK`);
    } else {
      console.log(`❌ ${model} — ${data.error?.message || res.status}`);
    }
  } catch (e) {
    console.log(`❌ ${model} — ${e.message}`);
  }
}
