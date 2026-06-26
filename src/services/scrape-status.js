import ScrapeStatus from '../models/ScrapeStatus.js';

/**
 * MongoDB-backed scrape status tracker.
 * Tracks scraping state per user so the frontend can poll for updates consistently,
 * even when running across multiple Vercel serverless containers.
 *
 * States: idle | needs_login | running | done | error
 */

export async function setScrapeStatus(userId, state, message = '') {
  try {
    return await ScrapeStatus.findOneAndUpdate(
      { userId },
      { state, message, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`Error saving scrape status for user ${userId}:`, err);
    return null;
  }
}

export async function getScrapeStatus(userId) {
  try {
    const status = await ScrapeStatus.findOne({ userId });
    return status || { state: 'idle', message: '', updatedAt: null };
  } catch (err) {
    console.error(`Error getting scrape status for user ${userId}:`, err);
    return { state: 'idle', message: 'Erro ao carregar status do banco.', updatedAt: null };
  }
}

export async function updateScrapeStatus(userId, state, message = '') {
  return await setScrapeStatus(userId, state, message);
}
