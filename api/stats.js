import { collectAllCampaigns } from '../lib/mailshake.js';
import { getCachedStats, getCampaignRefreshTimestamps } from '../lib/cache.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  if (!checkAuth(req, res)) return;
  try {
    let cached = await getCachedStats();
    console.log('Cached data keys:', cached ? Object.keys(cached) : 'null');
    console.log('Campaigns count:', cached?.campaigns ? Object.keys(cached.campaigns).length : 0);
    console.log('Sample campaign:', cached?.campaigns ? JSON.stringify(cached.campaigns, null, 2) : 'none');
    // If no shared cache is available (e.g., no KV configured), compute on-demand
    if (!cached) {
      console.log('No cache found, computing on-demand');
      cached = await collectAllCampaigns();
    }
    
    // Get last update timestamps for each campaign
    const refreshTimestamps = await getCampaignRefreshTimestamps();
    
    // Add lastUpdate timestamp to each campaign
    const campaignsWithTimestamps = {};
    for (const [id, campaign] of Object.entries(cached?.campaigns || {})) {
      campaignsWithTimestamps[id] = {
        ...campaign,
        lastUpdate: refreshTimestamps[id] ? refreshTimestamps[id].toISOString() : null
      };
    }
    
    const response = {
      campaigns: campaignsWithTimestamps,
      lastUpdated: cached?.lastUpdated || ''
    };
    
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(response);
  } catch (e) {
    console.error('Stats error:', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

function checkAuth(req, res) {
  const pass = process.env.DASHBOARD_PASSWORD || '#$F(jfi4f;w-lf-21)';
  if (!pass) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) { res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"'); res.status(401).end('Auth required'); return false; }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const password = decoded.split(':').slice(1).join(':');
  const ok = password === pass;
  if (!ok) { res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"'); res.status(401).end('Auth required'); }
  return ok;
}


