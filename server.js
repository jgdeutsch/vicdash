import http from 'http';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import url from 'url';

const PORT = 6969;

// Resolve project root and public directory
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Minimal .env loader (no dependency)
function loadDotEnv(envPath) {
  try {
    const txt = fsSync.readFileSync(envPath, 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
      if (!process.env[key]) process.env[key] = value;
    });
  } catch (e) {
    // ignore
  }
}

loadDotEnv(path.join(__dirname, '.env'));
loadDotEnv(path.join(process.cwd(), '.env'));


// Expand '~' in a path
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

const DEFAULT_STATS_FILE = expandHome('~/mailshake_stats.json');
const STATS_FILE = expandHome(process.env.STATS_FILE || DEFAULT_STATS_FILE);

// --- Mailshake Config ---
let MAILSHAKE_API_KEY = process.env.MAILSHAKE_API_KEY || process.env.API_KEY || 'FAKE_API_KEY_REPLACED_AT_RUNTIME';
const MAILSHAKE_BASE = 'https://api.mailshake.com/2017-04-01';
// Default campaign list (can be overridden via env CAMPAIGN_IDS="id1 id2 ...")
const DEFAULT_CAMPAIGNS = [
  1472607, 1472605, 1472564, 1472552, 1472550, 1472549,
  1472531, 1472525, 1472277, 1472245, 1472243, 1471775,
  1471681, 1471354, 1471352, 1471181, 1471178, 1469530, 1467476
];
let CAMPAIGN_IDS = (process.env.CAMPAIGN_IDS || '').trim().length > 0
  ? (process.env.CAMPAIGN_IDS || '').split(/\s+/).map(s => Number(s)).filter(Boolean)
  : DEFAULT_CAMPAIGNS;

// --- Auth Config ---
const BASIC_PASSWORD = process.env.DASHBOARD_PASSWORD || '#$F(jfi4f;w-lf-21)';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif'
};

async function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsed.pathname || '/';

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(500);
      res.end('Internal server error');
    }
  }
}

async function serveStats(_req, res) {
  try {
    const raw = await fs.readFile(STATS_FILE, 'utf8');
    // Validate JSON
    let json;
    try { json = JSON.parse(raw); } catch (_e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON in stats file', file: STATS_FILE }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(json));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // If no cache exists, trigger a refresh and return that
      try {
        const data = await refreshStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ campaigns: {}, lastUpdated: '' }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read stats file', file: STATS_FILE }));
    }
  }
}

// --- Mailshake helpers (no deps; uses global fetch) ---
function toQuery(params) {
  const usp = new URLSearchParams(params);
  return usp.toString();
}

async function fetchPaginated(endpoint, params = {}, log) {
  const results = [];
  let nextToken = '';
  do {
    const q = toQuery({ ...params, apiKey: MAILSHAKE_API_KEY, perPage: '100', nextToken });
    const urlStr = `${MAILSHAKE_BASE}/${endpoint}?${q}`;
    if (log) log(`GET ${urlStr}`);
    const resp = await fetch(urlStr);
    if (log) log(`↳ status ${resp.status}`);
    if (!resp.ok) throw new Error(`Mailshake ${endpoint} failed: ${resp.status}`);
    const json = await resp.json();
    if (Array.isArray(json.results)) results.push(...json.results);
    nextToken = json.nextToken || '';
    if (nextToken) await new Promise(r => setTimeout(r, 400));
  } while (nextToken);
  return results;
}

async function getCampaignInfo(campaignId, log) {
  const q = toQuery({ apiKey: MAILSHAKE_API_KEY, campaignID: String(campaignId) });
  const urlStr = `${MAILSHAKE_BASE}/campaigns/get?${q}`;
  if (log) log(`GET ${urlStr}`);
  const resp = await fetch(urlStr);
  if (log) log(`↳ status ${resp.status}`);
  if (!resp.ok) throw new Error(`campaigns/get failed: ${resp.status}`);
  return resp.json();
}

function coalesceEmail(item) {
  return (
    item?.recipient?.emailAddress ||
    item?.lead?.emailAddress ||
    item?.emailAddress ||
    null
  );
}

async function discoverCampaigns(searchTerm, log) {
  if (log) log(`Discovering campaigns with search term: "${searchTerm}"`);
  const results = await fetchPaginated('campaigns/list', { search: searchTerm }, log);
  const campaignIds = results.map(c => Number(c.id)).filter(Boolean);
  if (log) log(`Found ${campaignIds.length} campaigns matching "${searchTerm}"`);
  return campaignIds;
}

async function collectCampaignStats(campaignId, log, options = {}) {
  const { includeSendsOpens = true, includeLeads = true } = options;
  
  let sends = 0, uniqueOpens = 0, replies = 0;
  let won = 0, lost = 0, openLeads = 0;

  if (includeSendsOpens) {
    // Sent events count
    if (log) log(`Campaign ${campaignId}: fetching sends`);
    const sent = await fetchPaginated('activity/sent', { campaignID: String(campaignId) }, log);
    sends = sent.length;

    // Unique opens by recipient email (fallback to id string if email missing)
    if (log) log(`Campaign ${campaignId}: fetching opens`);
    const opens = await fetchPaginated('activity/opens', { campaignID: String(campaignId) }, log);
    const unique = new Set();
    for (const ev of opens) {
      const email = coalesceEmail(ev);
      if (email) unique.add(email.toLowerCase());
      else {
        const id = ev?.recipient?.id || ev?.lead?.id || ev?.recipientID || ev?.leadID || ev?.id;
        if (id) unique.add(`id:${String(id)}`);
      }
    }
    uniqueOpens = unique.size;

    // Replies count (events)
    if (log) log(`Campaign ${campaignId}: fetching replies`);
    const repliesArr = await fetchPaginated('activity/replies', { campaignID: String(campaignId), replyType: 'reply' }, log);
    replies = repliesArr.length;
  }

  if (includeLeads) {
    // Leads
    if (log) log(`Campaign ${campaignId}: fetching leads (closed/lost/open)`);
    won = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'closed' }, log)).length;
    lost = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'lost' }, log)).length;
    openLeads = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'open' }, log)).length;
  }

  const info = await getCampaignInfo(campaignId, log);

  return {
    id: String(campaignId),
    title: info?.title || 'Unknown Title',
    sender: info?.sender?.emailAddress || 'Unknown Sender',
    stats: {
      sends,
      uniqueOpens,
      replies,
      leads: { won, lost, open: openLeads }
    }
  };
}

async function refreshStats(log, options = {}) {
  // Discover campaigns with [VB] in title
  let ids;
  if (log) log(`Discovering campaigns with "[VB]" in title...`);
  ids = await discoverCampaigns('[VB]', log);
  if (ids.length === 0) {
    if (log) log('No campaigns found with "[VB]" in title, using fallback from config');
    ids = CAMPAIGN_IDS;
  }
  
  const campaigns = {};
  for (const id of ids) {
    if (log) log(`Processing campaign ${id}`);
    const c = await collectCampaignStats(id, log, options);
    campaigns[c.id] = { title: c.title, sender: c.sender, stats: c.stats };
  }
  const data = { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
  try {
    await fs.writeFile(STATS_FILE, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
  return data;
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const parsed = new URL(req.url || '/', `http://${req.headers.host}`);
  const reqUrl = parsed.pathname + (parsed.search || '');

  // Basic Auth for all routes
  const authHeader = req.headers['authorization'] || '';
  const okAuth = (() => {
    if (!BASIC_PASSWORD) return true;
    if (!authHeader.startsWith('Basic ')) return false;
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const parts = decoded.split(':');
    const password = parts.slice(1).join(':'); // allow ':' in password
    return password === BASIC_PASSWORD;
  })();
  if (!okAuth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="VicDash"' });
    res.end('Authentication required');
    return;
  }

  // Simple routing
  if (method === 'GET' && reqUrl.startsWith('/api/stats')) {
    return void serveStats(req, res);
  }

  if (method === 'GET' && reqUrl === '/api/version') {
    try {
      const packageJson = JSON.parse(fsSync.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: packageJson.version }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read version', version: 'unknown' }));
    }
    return;
  }

  if (method === 'POST' && reqUrl === '/api/config') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        if (json.apiKey && typeof json.apiKey === 'string') {
          MAILSHAKE_API_KEY = json.apiKey.trim();
        }
        if (json.campaignIds) {
          if (Array.isArray(json.campaignIds)) {
            CAMPAIGN_IDS = json.campaignIds.map(n => Number(n)).filter(Boolean);
          } else if (typeof json.campaignIds === 'string') {
            CAMPAIGN_IDS = json.campaignIds.split(/\s+/).map(n => Number(n)).filter(Boolean);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, campaignIds: CAMPAIGN_IDS, apiKeySet: !!MAILSHAKE_API_KEY }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (method === 'POST' && reqUrl === '/api/refresh') {
    try {
      const data = await refreshStats(null, { includeSendsOpens: true, includeLeads: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }

  if (method === 'GET' && reqUrl === '/api/refresh-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    const send = (msg) => {
      res.write(`data: ${JSON.stringify({ t: Date.now(), msg })}\n\n`);
    };
    (async () => {
      try {
        send('Starting refresh');
        const data = await refreshStats(send, { includeSendsOpens: true, includeLeads: true });
        send('done');
      } catch (e) {
        send(`error: ${String(e && e.message || e)}`);
      } finally {
        res.end();
      }
    })();
    return;
  }

  if (method === 'GET' && reqUrl === '/api/refresh-sends-opens') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    const send = (msg) => {
      res.write(`data: ${JSON.stringify({ t: Date.now(), msg })}\n\n`);
    };
    (async () => {
      try {
        send('Starting refresh: sends and opens');
        // Read existing stats to preserve leads
        let existingData = { campaigns: {} };
        try {
          const raw = await fs.readFile(STATS_FILE, 'utf8');
          existingData = JSON.parse(raw);
        } catch {}
        
        const newData = await refreshStats(send, { includeSendsOpens: true, includeLeads: false });
        
        // Merge: use new sends/opens, preserve existing leads
        const mergedCampaigns = {};
        for (const [id, newCampaign] of Object.entries(newData.campaigns)) {
          const existing = existingData.campaigns[id] || {};
          mergedCampaigns[id] = {
            title: newCampaign.title,
            sender: newCampaign.sender,
            stats: {
              ...newCampaign.stats,
              leads: existing.stats?.leads || { won: 0, lost: 0, open: 0 }
            }
          };
        }
        for (const [id, existing] of Object.entries(existingData.campaigns)) {
          if (!mergedCampaigns[id]) mergedCampaigns[id] = existing;
        }
        
        const finalData = { campaigns: mergedCampaigns, lastUpdated: newData.lastUpdated };
        await fs.writeFile(STATS_FILE, JSON.stringify(finalData, null, 2));
        res.write(`event: final\n`);
        res.write(`data: ${JSON.stringify(finalData)}\n\n`);
        send('done');
      } catch (e) {
        send(`error: ${String(e && e.message || e)}`);
      } finally {
        res.end();
      }
    })();
    return;
  }

  if (method === 'GET' && reqUrl === '/api/refresh-leads') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    const send = (msg) => {
      res.write(`data: ${JSON.stringify({ t: Date.now(), msg })}\n\n`);
    };
    (async () => {
      try {
        send('Starting refresh: leads and lead status');
        // Read existing stats to preserve sends/opens
        let existingData = { campaigns: {} };
        try {
          const raw = await fs.readFile(STATS_FILE, 'utf8');
          existingData = JSON.parse(raw);
        } catch {}
        
        const newData = await refreshStats(send, { includeSendsOpens: false, includeLeads: true });
        
        // Merge: use new leads, preserve existing sends/opens
        const mergedCampaigns = {};
        for (const [id, newCampaign] of Object.entries(newData.campaigns)) {
          const existing = existingData.campaigns[id] || {};
          mergedCampaigns[id] = {
            title: newCampaign.title,
            sender: newCampaign.sender,
            stats: {
              sends: existing.stats?.sends || 0,
              uniqueOpens: existing.stats?.uniqueOpens || existing.stats?.opens || 0,
              replies: existing.stats?.replies || 0,
              leads: newCampaign.stats.leads
            }
          };
        }
        for (const [id, existing] of Object.entries(existingData.campaigns)) {
          if (!mergedCampaigns[id]) mergedCampaigns[id] = existing;
        }
        
        const finalData = { campaigns: mergedCampaigns, lastUpdated: newData.lastUpdated };
        await fs.writeFile(STATS_FILE, JSON.stringify(finalData, null, 2));
        res.write(`event: final\n`);
        res.write(`data: ${JSON.stringify(finalData)}\n\n`);
        send('done');
      } catch (e) {
        send(`error: ${String(e && e.message || e)}`);
      } finally {
        res.end();
      }
    })();
    return;
  }

  if (method === 'GET' && reqUrl === '/api/config-info') {
    const info = {
      campaignIds: CAMPAIGN_IDS,
      apiKeySet: !!MAILSHAKE_API_KEY && MAILSHAKE_API_KEY !== 'FAKE_API_KEY_REPLACED_AT_RUNTIME'
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  return void serveStatic(req, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`VicDash running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Reading stats from: ${STATS_FILE}`);
});


