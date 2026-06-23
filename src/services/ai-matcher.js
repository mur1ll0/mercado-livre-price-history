import axios from 'axios';
import UnifiedProduct from '../models/UnifiedProduct.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

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

/**
 * Compares two products via OpenRouter AI model.
 * @param {object} productA { title: string, category: string }
 * @param {object} productB { title: string, category: string }
 * @returns {Promise<{isSame: boolean, confidence: number, reason: string}>}
 */
async function compareWithLLM(productA, productB) {
  if (!OPENROUTER_API_KEY) {
    console.warn('[ai-matcher] OPENROUTER_API_KEY is not set. Skipping LLM comparison.');
    return { isSame: false, confidence: 0, reason: 'Chave API ausente' };
  }

  const prompt = `Você é um especialista em e-commerce e catálogo de produtos.
Compare os dois anúncios abaixo e determine se eles representam o EXATO MESMO produto físico (mesmo fabricante, marca, modelo e geração).
Desconsidere completamente diferenças de anúncio como: brindes inclusos, frete grátis, parcelamento sem juros, se o produto é novo/usado, ou acessórios adicionais (ex: "capa de brinde"), contanto que o produto base seja idêntico.

Responda estritamente no formato JSON abaixo, sem qualquer texto adicional ou blocos de código extras:
{
  "isSame": true ou false,
  "confidence": valor de 0.0 a 1.0,
  "reason": "Explicação curta em português (máximo 15 palavras)"
}

Anúncio 1:
- Nome: "${productA.title}"
- Categoria: "${productA.category}"

Anúncio 2:
- Nome: "${productB.title}"
- Categoria: "${productB.category}"`;

  try {
    console.log('[ai-matcher] Querying OpenRouter for duplicate detection...');
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 150
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://github.com/mur1ll0/mercado-livre-price-history',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim() || '';
    console.log('[ai-matcher] Raw LLM reply:', content);

    // Clean markdown code blocks if the LLM returned them
    const cleanJson = content.replace(/```json/i, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);

    return {
      isSame: !!result.isSame,
      confidence: parseFloat(result.confidence) || 0,
      reason: result.reason || ''
    };
  } catch (err) {
    console.error('[ai-matcher] OpenRouter API call failed:', err.message);
    // Return safe fallback
    return { isSame: false, confidence: 0, reason: `Erro: ${err.message}` };
  }
}

/**
 * Attempts to match a scraped announcement to an existing UnifiedProduct.
 * If a match is found, returns the existing UnifiedProduct._id.
 * If not, returns null (meaning a new UnifiedProduct should be created).
 * @param {object} scrapedData { title: string, categoryStr: string }
 * @returns {Promise<string|null>} UnifiedProduct ID if matched, null otherwise
 */
export async function findMatchingProduct(scrapedData) {
  console.log(`[ai-matcher] Matching product: "${scrapedData.title}" under category "${scrapedData.categoryStr}"`);

  // 1. Fetch potential candidate products in the database
  // We look for products that share at least part of the category, or we fetch all products if the DB is small
  const categoryParts = scrapedData.categoryStr.split('>').map(c => c.trim()).filter(Boolean);
  const mainCategory = categoryParts[0] || '';

  // Get candidates that share the main category or have similar names
  const candidates = await UnifiedProduct.find({
    category: new RegExp(mainCategory, 'i')
  }).lean();

  console.log(`[ai-matcher] Found ${candidates.length} candidates in category "${mainCategory}"`);

  let bestMatch = null;
  let highestSimilarity = 0;

  // 2. Perform text Jaccard similarity first
  for (const candidate of candidates) {
    const similarity = getJaccardSimilarity(scrapedData.title, candidate.name);
    console.log(`  - Candidate: "${candidate.name}" | Jaccard Similarity: ${similarity.toFixed(2)}`);
    
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  // 3. Evaluate results
  if (highestSimilarity >= 0.85 && bestMatch) {
    console.log(`[ai-matcher] Direct Match! High text similarity (${highestSimilarity.toFixed(2)}) with: "${bestMatch.name}"`);
    return bestMatch._id;
  }

  if (highestSimilarity >= 0.35 && bestMatch) {
    console.log(`[ai-matcher] Ambiguous match (${highestSimilarity.toFixed(2)}). Asking LLM to compare with: "${bestMatch.name}"`);
    const llmResult = await compareWithLLM(
      { title: scrapedData.title, category: scrapedData.categoryStr },
      { title: bestMatch.name, category: bestMatch.category }
    );

    console.log(`[ai-matcher] LLM Result: isSame=${llmResult.isSame}, confidence=${llmResult.confidence}, reason: "${llmResult.reason}"`);
    
    if (llmResult.isSame && llmResult.confidence >= 0.7) {
      console.log(`[ai-matcher] LLM Confirmed Match! Linking to unified product ID ${bestMatch._id}`);
      return bestMatch._id;
    }
  }

  console.log('[ai-matcher] No matching product found. Creating new UnifiedProduct.');
  return null;
}
