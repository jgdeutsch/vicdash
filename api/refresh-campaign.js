import { collectCampaignStats, getConfig } from '../lib/mailshake.js';
import { getCachedStats, setCachedStats, setCampaignRefreshTimestamp } from '../lib/cache.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).end(); return; }
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
    let campaignId;
    
    if (req.method === 'GET') {
      // Get campaign ID from query parameter
      const url = new URL(req.url, `http://${req.headers.host}`);
      campaignId = url.searchParams.get('campaignId');
    } else {
      // Get campaign ID from request body
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
      await new Promise(resolve => req.on('end', resolve));
      const parsed = JSON.parse(body || '{}');
      campaignId = parsed.campaignId;
    }
    
    if (!campaignId) {
      send('error: Missing campaignId');
      res.end();
      return;
    }

    send(`Starting refresh for campaign ${campaignId}`);
    
    const { apiKey } = getConfig();
    if (!apiKey) {
      send('error: Missing MAILSHAKE_API_KEY');
      res.end();
      return;
    }
    
    // Get existing cached data to preserve other campaigns
    const cached = await getCachedStats().catch(() => ({ campaigns: {} }));
    const existingCampaigns = cached.campaigns || {};
    
    // Collect stats for this single campaign (both sends/opens and leads)
    const campaignData = await collectCampaignStats(
      Number(campaignId),
      apiKey,
      send,
      { includeSendsOpens: true, includeLeads: true }
    );
    
    // Update the cached stats with the new campaign data
    const updatedCampaigns = {
      ...existingCampaigns,
      [campaignData.id]: {
        title: campaignData.title,
        sender: campaignData.sender,
        stats: campaignData.stats,
        statsComplete: campaignData.statsComplete
      }
    };
    
    const finalData = {
      campaigns: updatedCampaigns,
      lastUpdated: new Date().toISOString().replace(/\..+/, 'Z')
    };
    
    await setCachedStats(finalData);
    
    // Store refresh timestamp
    await setCampaignRefreshTimestamp(campaignData.id);
    
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

