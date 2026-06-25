/**
 * In-memory scrape status tracker.
 * Tracks scraping state per user so the frontend can poll for updates.
 *
 * States: idle | needs_login | running | done | error
 */

const statusMap = new Map();

const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes

export function setScrapeStatus(userId, state, message = '') {
  const entry = { state, message, updatedAt: new Date() };
  statusMap.set(String(userId), entry);
  // Auto-cleanup after TTL
  setTimeout(() => {
    const current = statusMap.get(String(userId));
    if (current && current.updatedAt === entry.updatedAt && current.state === entry.state) {
      statusMap.delete(String(userId));
    }
  }, DEFAULT_TTL);
}

export function getScrapeStatus(userId) {
  return statusMap.get(String(userId)) || { state: 'idle', message: '', updatedAt: null };
}

export function updateScrapeStatus(userId, state, message = '') {
  setScrapeStatus(userId, state, message);
}
