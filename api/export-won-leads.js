import { fetchPaginated, getConfig } from '../lib/mailshake.js';

function checkAuth(req, res) {
  const pass = process.env.DASHBOARD_PASSWORD || '#$F(jfi4f;w-lf-21)';
  if (!pass) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"');
    res.status(401).end('Auth required');
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const password = decoded.split(':').slice(1).join(':');
  const ok = password === pass;
  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"');
    res.status(401).end('Auth required');
  }
  return ok;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  if (!checkAuth(req, res)) return;

  try {
    const { apiKey, campaignIds } = getConfig();
    if (!apiKey) {
      res.status(500).json({ error: 'MAILSHAKE_API_KEY not configured' });
      return;
    }

    // Get campaign IDs override if present
    let ids = campaignIds;
    try {
      const override = (req.query.ids || '').trim();
      if (override) {
        ids = override.split(/\s+/).map(s => Number(s)).filter(Boolean);
      }
    } catch {}

    const allWonLeads = [];
    
    // Fetch won leads from all campaigns
    for (const campaignId of ids) {
      try {
        const wonLeadsData = await fetchPaginated('leads/list', {
          campaignID: String(campaignId),
          status: 'closed'
        }, apiKey);
        const wonLeads = wonLeadsData.results;
        
        // Add campaign ID to each lead for reference
        for (const lead of wonLeads) {
          allWonLeads.push({
            ...lead,
            campaignId: String(campaignId)
          });
        }
      } catch (e) {
        console.error(`Error fetching won leads for campaign ${campaignId}:`, e);
        // Continue with other campaigns even if one fails
      }
    }

    // Extract unique email addresses
    const emails = new Set();
    for (const lead of allWonLeads) {
      const email = lead?.recipient?.emailAddress || 
                    lead?.lead?.emailAddress || 
                    lead?.emailAddress || 
                    null;
      if (email && typeof email === 'string') {
        emails.add(email.toLowerCase().trim());
      }
    }

    // Create simple line-delimited list (one email per line, no quotes, no header)
    const emailList = Array.from(emails).sort();
    const output = emailList.join('\n') + (emailList.length > 0 ? '\n' : '');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="won-leads.txt"');
    res.status(200).send(output);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: String(error?.message || error) });
  }
}

