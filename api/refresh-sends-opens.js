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

  const send = (msg) => {
    res.write(`data: ${JSON.stringify({ t: Date.now(), msg })}\n\n`);
  };

  try {
    send('Starting refresh: sends and opens');
    const idsParam = (req.query?.ids || '').toString();
    const ids = idsParam ? idsParam.split(/[ ,]+/).map(n => Number(n)).filter(Boolean) : undefined;
    
    // Get existing cached data to preserve leads data and determine processing order
    const cached = await getCachedStats().catch(() => ({ campaigns: {} }));
    const existingCampaigns = cached.campaigns || {};
    
    // Collect only sends/opens, passing existing campaigns for sorting
    // collectAllCampaigns will sort: 0 sends first, then ascending by sends
    const newData = await collectAllCampaigns(send, ids, { 
      includeSendsOpens: true, 
      includeLeads: false,
      existingCampaigns 
    });
    
    // Merge: use new sends/opens data, preserve existing leads data
    const mergedCampaigns = {};
    for (const [id, newCampaign] of Object.entries(newData.campaigns)) {
      const existing = existingCampaigns[id] || {};
      mergedCampaigns[id] = {
        title: newCampaign.title,
        sender: newCampaign.sender,
        stats: {
          ...newCampaign.stats,
          leads: existing.stats?.leads || { won: 0, lost: 0, open: 0 }
        }
      };
    }
    
    // Preserve campaigns that exist in cache but weren't refreshed
    for (const [id, existing] of Object.entries(existingCampaigns)) {
      if (!mergedCampaigns[id]) {
        mergedCampaigns[id] = existing;
      }
    }
    
    const finalData = { campaigns: mergedCampaigns, lastUpdated: newData.lastUpdated };
    await setCachedStats(finalData);
    
    // Emit final payload
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

