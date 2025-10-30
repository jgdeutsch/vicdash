import kv from '@vercel/kv';
import { neon } from '@neondatabase/serverless';

const CACHE_KEY = 'vicdash:stats';

export async function getCachedStats() {
  try {
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      const sql = neon(dbUrl);
      await sql`create table if not exists vicdash_cache (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )`;
      const rows = await sql`select value from vicdash_cache where key = 'stats'`;
      if (rows && rows.length) {
        return rows[0].value;
      }
    }

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
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      const sql = neon(dbUrl);
      await sql`create table if not exists vicdash_cache (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )`;
      await sql`insert into vicdash_cache (key, value, updated_at)
                values ('stats', ${JSON.stringify(data)}::jsonb, now())
                on conflict (key)
                do update set value = excluded.value, updated_at = excluded.updated_at`;
      // Still update in-memory cache for immediate reads in the same invocation
      globalThis.__vicdashCachedStats = data;
      return;
    }

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


