import kv from '@vercel/kv';

const CACHE_KEY = 'vicdash:stats';

export async function getCachedStats() {
  try {
    // Try to get from Vercel KV first
    const kvClient = kv.default || kv;
    const cached = await kvClient.get(CACHE_KEY);
    if (cached) return cached;
    
    // Fallback to in-memory for local development
    return globalThis.__vicdashCachedStats || null;
  } catch (error) {
    // If KV is not configured, fall back to in-memory
    console.warn('KV not available, using in-memory cache:', error.message);
    return globalThis.__vicdashCachedStats || null;
  }
}

export async function setCachedStats(data) {
  try {
    // Try to set in Vercel KV first
    const kvClient = kv.default || kv;
    await kvClient.set(CACHE_KEY, data, { ex: 3600 }); // Expire after 1 hour
  } catch (error) {
    // If KV is not configured, fall back to in-memory
    console.warn('KV not available, using in-memory cache:', error.message);
  }
  // Always update in-memory cache for local development
  globalThis.__vicdashCachedStats = data;
}


