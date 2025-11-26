import kv from '@vercel/kv';
import { neon } from '@neondatabase/serverless';

const CACHE_KEY = 'vicdash:stats';

export async function getCachedStats() {
  try {
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      console.log('Using Neon Postgres cache');
      try {
        const sql = neon(dbUrl);
        await sql`create table if not exists vicdash_cache (
          key text primary key,
          value jsonb not null,
          updated_at timestamptz not null default now()
        )`;
        const rows = await sql`select value from vicdash_cache where key = 'stats'`;
        console.log('Neon cache rows found:', rows?.length || 0);
        if (rows && rows.length && rows[0].value) {
          console.log('Returning cached data from Neon');
          console.log('Data type:', typeof rows[0].value);
          console.log('Data keys:', rows[0].value ? Object.keys(rows[0].value) : 'none');
          return rows[0].value;
        }
        console.log('No cached data in Neon');
      } catch (neonError) {
        console.error('Neon cache error:', neonError.message);
        // Fall through to other cache methods
      }
    }

    // Try to get from Vercel KV first
    console.log('Trying Vercel KV cache');
    const kvClient = kv.default || kv;
    const cached = await kvClient.get(CACHE_KEY);
    if (cached) {
      console.log('Returning cached data from KV');
      return cached;
    }
    console.log('No cached data in KV');
    
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
                values ('stats', ${data}::jsonb, now())
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

const REFRESH_TIMESTAMPS_KEY = 'vicdash:refresh_timestamps';

// Get refresh timestamps for campaigns
export async function getCampaignRefreshTimestamps() {
  try {
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`create table if not exists vicdash_refresh_timestamps (
          campaign_id text primary key,
          refreshed_at timestamptz not null default now()
        )`;
        const rows = await sql`select campaign_id, refreshed_at from vicdash_refresh_timestamps`;
        const timestamps = {};
        for (const row of rows) {
          timestamps[row.campaign_id] = new Date(row.refreshed_at);
        }
        return timestamps;
      } catch (neonError) {
        console.error('Neon refresh timestamps error:', neonError.message);
        // Fall through to other methods
      }
    }

    // Try Vercel KV
    const kvClient = kv.default || kv;
    const cached = await kvClient.get(REFRESH_TIMESTAMPS_KEY);
    if (cached) {
      // Convert ISO strings back to Date objects
      const timestamps = {};
      for (const [campaignId, timestamp] of Object.entries(cached)) {
        timestamps[campaignId] = new Date(timestamp);
      }
      return timestamps;
    }
    
    // Fallback to in-memory
    return globalThis.__vicdashRefreshTimestamps || {};
  } catch (error) {
    console.warn('Error getting refresh timestamps, using in-memory:', error.message);
    return globalThis.__vicdashRefreshTimestamps || {};
  }
}

// Set refresh timestamp for a campaign
export async function setCampaignRefreshTimestamp(campaignId) {
  const now = new Date();
  try {
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`create table if not exists vicdash_refresh_timestamps (
          campaign_id text primary key,
          refreshed_at timestamptz not null default now()
        )`;
        await sql`insert into vicdash_refresh_timestamps (campaign_id, refreshed_at)
                  values (${String(campaignId)}, ${now.toISOString()}::timestamptz)
                  on conflict (campaign_id)
                  do update set refreshed_at = excluded.refreshed_at`;
        // Update in-memory cache
        if (!globalThis.__vicdashRefreshTimestamps) {
          globalThis.__vicdashRefreshTimestamps = {};
        }
        globalThis.__vicdashRefreshTimestamps[String(campaignId)] = now;
        return;
      } catch (neonError) {
        console.error('Neon refresh timestamp error:', neonError.message);
        // Fall through to other methods
      }
    }

    // Try Vercel KV
    const kvClient = kv.default || kv;
    const existing = await kvClient.get(REFRESH_TIMESTAMPS_KEY) || {};
    existing[String(campaignId)] = now.toISOString();
    await kvClient.set(REFRESH_TIMESTAMPS_KEY, existing, { ex: 86400 * 7 }); // Expire after 7 days
  } catch (error) {
    console.warn('Error setting refresh timestamp, using in-memory:', error.message);
  }
  
  // Always update in-memory cache
  if (!globalThis.__vicdashRefreshTimestamps) {
    globalThis.__vicdashRefreshTimestamps = {};
  }
  globalThis.__vicdashRefreshTimestamps[String(campaignId)] = now;
}

// Check if a campaign was refreshed in the last N hours
export async function wasCampaignRefreshedRecently(campaignId, hours = 12) {
  const timestamps = await getCampaignRefreshTimestamps();
  const timestamp = timestamps[String(campaignId)];
  if (!timestamp) return false;
  
  const now = new Date();
  const diffMs = now.getTime() - timestamp.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours < hours;
}

const REFRESH_SESSION_KEY = 'vicdash:refresh_session';

// Get current refresh session (campaigns completed in this session)
export async function getRefreshSession() {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`create table if not exists vicdash_refresh_session (
          session_id text primary key,
          completed_campaigns jsonb not null,
          started_at timestamptz not null default now()
        )`;
        const rows = await sql`select completed_campaigns, started_at from vicdash_refresh_session where session_id = 'current'`;
        if (rows && rows.length && rows[0].completed_campaigns) {
          return {
            completedCampaigns: new Set(rows[0].completed_campaigns),
            startedAt: new Date(rows[0].started_at)
          };
        }
      } catch (neonError) {
        console.error('Neon refresh session error:', neonError.message);
      }
    }

    const kvClient = kv.default || kv;
    const session = await kvClient.get(REFRESH_SESSION_KEY);
    if (session) {
      return {
        completedCampaigns: new Set(session.completedCampaigns || []),
        startedAt: new Date(session.startedAt)
      };
    }
    
    return { completedCampaigns: new Set(), startedAt: null };
  } catch (error) {
    console.warn('Error getting refresh session, using in-memory:', error.message);
    return globalThis.__vicdashRefreshSession || { completedCampaigns: new Set(), startedAt: null };
  }
}

// Mark a campaign as completed in the current session
export async function markCampaignCompleted(campaignId) {
  try {
    const session = await getRefreshSession();
    session.completedCampaigns.add(String(campaignId));
    
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`create table if not exists vicdash_refresh_session (
          session_id text primary key,
          completed_campaigns jsonb not null,
          started_at timestamptz not null default now()
        )`;
        await sql`insert into vicdash_refresh_session (session_id, completed_campaigns, started_at)
                  values ('current', ${Array.from(session.completedCampaigns)}::jsonb, ${session.startedAt ? session.startedAt.toISOString() : new Date().toISOString()}::timestamptz)
                  on conflict (session_id)
                  do update set completed_campaigns = excluded.completed_campaigns`;
        globalThis.__vicdashRefreshSession = session;
        return;
      } catch (neonError) {
        console.error('Neon session update error:', neonError.message);
      }
    }

    const kvClient = kv.default || kv;
    await kvClient.set(REFRESH_SESSION_KEY, {
      completedCampaigns: Array.from(session.completedCampaigns),
      startedAt: session.startedAt ? session.startedAt.toISOString() : new Date().toISOString()
    }, { ex: 86400 }); // Expire after 24 hours
    globalThis.__vicdashRefreshSession = session;
  } catch (error) {
    console.warn('Error updating refresh session, using in-memory:', error.message);
    if (!globalThis.__vicdashRefreshSession) {
      globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
    }
    globalThis.__vicdashRefreshSession.completedCampaigns.add(String(campaignId));
  }
}

// Clear the refresh session (when refresh completes successfully)
export async function clearRefreshSession() {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`delete from vicdash_refresh_session where session_id = 'current'`;
        globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
        return;
      } catch (neonError) {
        console.error('Neon session clear error:', neonError.message);
      }
    }

    const kvClient = kv.default || kv;
    await kvClient.del(REFRESH_SESSION_KEY);
    globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
  } catch (error) {
    console.warn('Error clearing refresh session, clearing in-memory:', error.message);
    globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
  }
}

// Reset all campaign refresh timestamps
export async function resetCampaignRefreshTimestamps() {
  try {
    // Prefer Neon Postgres if configured
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl) {
      try {
        const sql = neon(dbUrl);
        await sql`delete from vicdash_refresh_timestamps`;
        await sql`delete from vicdash_refresh_session`;
        // Clear in-memory cache
        globalThis.__vicdashRefreshTimestamps = {};
        globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
        return { success: true, method: 'neon' };
      } catch (neonError) {
        console.error('Neon reset error:', neonError.message);
        // Fall through to other methods
      }
    }

    // Try Vercel KV
    const kvClient = kv.default || kv;
    await kvClient.del(REFRESH_TIMESTAMPS_KEY);
    await kvClient.del(REFRESH_SESSION_KEY);
    // Clear in-memory cache
    globalThis.__vicdashRefreshTimestamps = {};
    globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
    return { success: true, method: 'kv' };
  } catch (error) {
    console.warn('Error resetting refresh timestamps, clearing in-memory:', error.message);
    // Clear in-memory cache as fallback
    globalThis.__vicdashRefreshTimestamps = {};
    globalThis.__vicdashRefreshSession = { completedCampaigns: new Set(), startedAt: null };
    return { success: true, method: 'memory' };
  }
}


