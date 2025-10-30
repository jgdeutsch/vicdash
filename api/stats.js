import { collectAllCampaigns } from '../lib/mailshake.js';
import { getCachedStats } from '../lib/cache.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  if (!checkAuth(req, res)) return;
  try {
    const cached = getCachedStats();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(cached || { campaigns: {}, lastUpdated: '' });
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


