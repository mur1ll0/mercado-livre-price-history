import axios from 'axios';
import UnifiedProduct from '../models/UnifiedProduct.js';


/**
 * Calculates token/word Jaccard similarity between two strings.
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number} 0.0 to 1.0
 */
function getJaccardSimilarity(str1, str2) {
  const words1 = new Set(str1.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const words2 = new Set(str2.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  
  if (words1.size === 0 || words2.size === 0) return 0;
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

function formatSpecs(specs) {
  if (!specs || !specs.length) return 'Nenhuma';
  return specs.map(s => `${s.key}: ${s.value}`).join(', ');
}

/**
 * Compares two products via OpenRouter AI model.
 * @param {object} productA { title: string, category: string, specifications: Array }
 * @param {object} productB { title: string, category: string, specifications: Array }
 * @returns {Promise<{isSame: boolean, confidence: number, reason: string, unifiedName: string|null}>}
 */
async function compareWithLLM(productA, productB) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    console.warn('[ai-matcher] OPENROUTER_API_KEY is not set. Skipping LLM comparison.');
    return { isSame: false, confidence: 0, reason: 'Chave API ausente', unifiedName: null };
  }

  const prompt = `Você é um especialista em e-commerce e catálogo de produtos.
Compare os dois anúncios abaixo e determine se eles representam o EXATO MESMO produto físico (mesmo fabricante, marca, modelo, geração e características técnicas).

IMPORTANTE: Use as CARACTERÍSTICAS TÉCNICAS (especificações) como fonte principal de comparação. Se as especificações de modelo, capacidade, versão ou linha forem diferentes, os produtos NÃO são o mesmo.

Desconsidere completamente diferenças de anúncio como: brindes, frete grátis, parcelamento, novo/usado, acessórios adicionais, ou COR do produto.

Se os produtos forem iguais, sugira um nome unificado que melhor descreva o produto (sem cor, sem informações de frete/parcelamento).

Responda estritamente no formato JSON abaixo, sem qualquer texto adicional:
{
  "isSame": true/false,
  "confidence": 0.0 a 1.0,
  "reason": "Explicação curta em português (máximo 20 palavras)",
  "unifiedName": "Nome unificado sugerido (apenas se isSame=true, senão null)"
}

Anúncio 1:
- Nome: "${productA.title}"
- Categoria: "${productA.category}"
- Características: ${formatSpecs(productA.specifications)}

Anúncio 2:
- Nome: "${productB.title}"
- Categoria: "${productB.category}"
- Características: ${formatSpecs(productB.specifications)}`;

  try {
    console.log('[ai-matcher] Querying OpenRouter for duplicate detection...');
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/mur1ll0/mercado-livre-price-history',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim() || '';
    console.log('[ai-matcher] Raw LLM reply:', content);

    const cleanJson = content.replace(/```json/i, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);

    return {
      isSame: !!result.isSame,
      confidence: parseFloat(result.confidence) || 0,
      reason: result.reason || '',
      unifiedName: result.unifiedName || null
    };
  } catch (err) {
    console.error('[ai-matcher] OpenRouter API call failed:', err.message);
    return { isSame: false, confidence: 0, reason: `Erro: ${err.message}`, unifiedName: null };
  }
}

/**
 * Attempts to match a scraped announcement to an existing UnifiedProduct.
 * @param {object} scrapedData { title, categoryStr, specifications }
 * @returns {Promise<{productId: string|null, unifiedName: string|null}>}
 */
export async function findMatchingProduct(scrapedData) {
  console.log(`[ai-matcher] Matching product: "${scrapedData.title}" under category "${scrapedData.categoryStr}"`);

  const categoryParts = scrapedData.categoryStr.split('>').map(c => c.trim()).filter(Boolean);
  const mainCategory = categoryParts[0] || '';

  const candidates = await UnifiedProduct.find({
    categories: new RegExp(mainCategory, 'i')
  }).lean();

  console.log(`[ai-matcher] Found ${candidates.length} candidates in category "${mainCategory}"`);

  let bestMatch = null;
  let highestSimilarity = 0;

  for (const candidate of candidates) {
    const similarity = getJaccardSimilarity(scrapedData.title, candidate.name);
    console.log(`  - Candidate: "${candidate.name}" | Jaccard Similarity: ${similarity.toFixed(2)}`);
    
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (highestSimilarity >= 0.85 && bestMatch) {
    console.log(`[ai-matcher] Direct Match! (${highestSimilarity.toFixed(2)}) with: "${bestMatch.name}"`);
    return { productId: bestMatch._id, unifiedName: null };
  }

  if (highestSimilarity >= 0.35 && bestMatch) {
    console.log(`[ai-matcher] Ambiguous match (${highestSimilarity.toFixed(2)}). Asking LLM...`);
    const llmResult = await compareWithLLM(
      { title: scrapedData.title, category: scrapedData.categoryStr, specifications: scrapedData.specifications || [] },
      { title: bestMatch.name, category: (bestMatch.categories || [])[0] || '', specifications: [] }
    );

    console.log(`[ai-matcher] LLM Result: isSame=${llmResult.isSame}, confidence=${llmResult.confidence}, unifiedName=${llmResult.unifiedName}`);

    if (llmResult.isSame && llmResult.confidence >= 0.7) {
      return { productId: bestMatch._id, unifiedName: llmResult.unifiedName };
    }
  }

  console.log('[ai-matcher] No matching product found. Creating new UnifiedProduct.');
  return { productId: null, unifiedName: null };
}
