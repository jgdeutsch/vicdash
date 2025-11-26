import { collectAllCampaigns } from '../lib/mailshake.js';
import { getCachedStats, setCachedStats } from '../lib/cache.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  if (!checkAuth(req, res)) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  const formatTimestamp = (date = new Date()) => {
    return date.toISOString().replace('T', ' ').substring(0, 19);
  };

  const send = (msg) => {
    // If message doesn't already have a timestamp, add one
    const timestampedMsg = msg.startsWith('[') ? msg : `[${formatTimestamp()}] ${msg}`;
    res.write(`data: ${JSON.stringify({ t: Date.now(), msg: timestampedMsg })}\n\n`);
  };

  try {
    send('Starting refresh');
    const idsParam = (req.query?.ids || '').toString();
    const ids = idsParam ? idsParam.split(/[ ,]+/).map(n => Number(n)).filter(Boolean) : undefined;
    
    // Get existing cached data to preserve skipped campaigns
    const cached = await getCachedStats().catch(() => ({ campaigns: {} }));
    const existingCampaigns = cached.campaigns || {};
    
    const newData = await collectAllCampaigns(send, ids, { includeSendsOpens: true, includeLeads: true });
    
    // Merge: use new data, preserve campaigns that were skipped (exist in cache but not in new data)
    const mergedCampaigns = { ...newData.campaigns };
    for (const [id, existing] of Object.entries(existingCampaigns)) {
      if (!mergedCampaigns[id]) {
        mergedCampaigns[id] = existing;
      }
    }
    
    const finalData = { campaigns: mergedCampaigns, lastUpdated: newData.lastUpdated };
    await setCachedStats(finalData);
    
    // Emit final payload so clients don't need to re-fetch from a different instance
    res.write(`event: final\n`);
    res.write(`data: ${JSON.stringify(finalData)}\n\n`);
    send('done');
  } catch (e) {
    send(`error: ${String(e && e.message || e)}`);
  } finally {
    res.end();
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


