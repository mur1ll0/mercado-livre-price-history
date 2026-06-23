import Category from '../models/Category.js';

/**
 * Splits a composite category string and saves each hierarchical level into the Category collection.
 * @param {string} categoryStr e.g. "Celulares e Telefones > Acessórios para Celulares > Fones e Kits Viva Voz"
 */
export async function saveCategoryTree(categoryStr) {
  if (!categoryStr) return;
  
  const parts = categoryStr.split('>').map(p => p.trim()).filter(Boolean);
  let currentPath = '';
  
  for (let i = 0; i < parts.length; i++) {
    const nodeName = parts[i];
    const previousPath = currentPath;
    currentPath = currentPath ? `${currentPath} > ${nodeName}` : nodeName;
    
    try {
      await Category.findByIdAndUpdate(
        currentPath,
        {
          name: nodeName,
          parent: previousPath || null,
          level: i
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error('[db] Error upserting category node:', currentPath, err.message);
    }
  }
}
