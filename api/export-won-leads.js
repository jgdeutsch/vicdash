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
        const wonLeads = await fetchPaginated('leads/list', {
          campaignID: String(campaignId),
          status: 'closed'
        }, apiKey);
        
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

    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="won-leads.csv"');

    if (allWonLeads.length === 0) {
      res.status(200).send('No won leads found\n');
      return;
    }

    // Extract all unique field names from leads
    const allFields = new Set();
    allWonLeads.forEach(lead => {
      Object.keys(lead).forEach(key => allFields.add(key));
      // Also check nested objects
      if (lead.lead) Object.keys(lead.lead).forEach(key => allFields.add(`lead.${key}`));
      if (lead.recipient) Object.keys(lead.recipient).forEach(key => allFields.add(`recipient.${key}`));
    });

    // Define important columns to show first
    const priorityFields = [
      'campaignId',
      'lead.emailAddress',
      'lead.firstName',
      'lead.lastName',
      'lead.company',
      'lead.title',
      'lead.phoneNumber',
      'status',
      'createdDate',
      'closedDate',
      'id',
      'lead.id'
    ];

    // Sort fields: priority first, then others
    const sortedFields = [
      ...priorityFields.filter(f => allFields.has(f) || allFields.has(f.replace('.', ''))),
      ...Array.from(allFields).filter(f => !priorityFields.includes(f) && !priorityFields.includes(f.replace('.', '')))
    ];

    // Create CSV header
    const csvHeader = sortedFields.map(field => `"${field}"`).join(',') + '\n';

    // Create CSV rows
    const csvRows = allWonLeads.map(lead => {
      return sortedFields.map(field => {
        let value;
        if (field.includes('.')) {
          const [parent, child] = field.split('.');
          value = lead[parent]?.[child] ?? lead[field] ?? '';
        } else {
          value = lead[field] ?? '';
        }
        
        // Handle null/undefined
        if (value === null || value === undefined) return '""';
        
        // Convert to string and escape quotes
        const str = String(value);
        return `"${str.replace(/"/g, '""')}"`;
      }).join(',');
    }).join('\n');

    res.status(200).send(csvHeader + csvRows);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: String(error?.message || error) });
  }
}

