import { collectAllCampaigns } from '../lib/mailshake.js';
import { getCachedStats, setCachedStats } from '../lib/cache.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!checkAuth(req, res)) return;
  try {
    const logs = [];
    const idsParam = (req.query?.ids || '').toString();
    const ids = idsParam ? idsParam.split(/[ ,]+/).map(n => Number(n)).filter(Boolean) : undefined;
    
    // Get existing cached data to preserve skipped campaigns
    const cached = await getCachedStats().catch(() => ({ campaigns: {} }));
    const existingCampaigns = cached.campaigns || {};
    
    const newData = await collectAllCampaigns((m) => logs.push(m), ids, { includeSendsOpens: true, includeLeads: true });
    
    // Merge: use new data, preserve campaigns that were skipped (exist in cache but not in new data)
    const mergedCampaigns = { ...newData.campaigns };
    for (const [id, existing] of Object.entries(existingCampaigns)) {
      if (!mergedCampaigns[id]) {
        mergedCampaigns[id] = existing;
      }
    }
    
    const finalData = { campaigns: mergedCampaigns, lastUpdated: newData.lastUpdated };
    await setCachedStats(finalData);
    
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ...finalData, logs });
  } catch (e) {
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


