import { collectAllCampaigns } from '../lib/mailshake.js';
import { setCachedStats } from '../lib/cache.js';

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
    send('Starting refresh');
    const idsParam = (req.query?.ids || '').toString();
    const ids = idsParam ? idsParam.split(/[ ,]+/).map(n => Number(n)).filter(Boolean) : undefined;
    const data = await collectAllCampaigns(send, ids);
    await setCachedStats(data);
    // Emit final payload so clients don't need to re-fetch from a different instance
    res.write(`event: final\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
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


