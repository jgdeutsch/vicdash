import { wasCampaignRefreshedRecently, setCampaignRefreshTimestamp } from './cache.js';

export const MAILSHAKE_BASE = 'https://api.mailshake.com/2017-04-01';

export function getConfig() {
  const apiKey = process.env.MAILSHAKE_API_KEY || process.env.API_KEY || '';
  const defaultCampaigns = [
    1472607, 1472605, 1472564, 1472552, 1472550, 1472549,
    1472531, 1472525, 1472277, 1472245, 1472243, 1471775,
    1471681, 1471354, 1471352, 1471181, 1471178, 1469530, 1467476,
    1474401, 1474399, 1474398, 1474382, 1474947, 1474943, 1474926, 1474925
  ];
  const campaignIds = (process.env.CAMPAIGN_IDS || '')
    .split(/\s+/)
    .map(s => Number(s))
    .filter(Boolean);
  return { apiKey, campaignIds: campaignIds.length ? campaignIds : defaultCampaigns };
}

function toQuery(params) {
  const usp = new URLSearchParams(params);
  return usp.toString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function formatLogMessage(msg, log) {
  if (!log) return;
  const timestamp = formatTimestamp();
  log(`[${timestamp}] ${msg}`);
}

export async function fetchPaginated(endpoint, params = {}, apiKey, log) {
  const results = [];
  let nextToken = '';
  do {
    const q = toQuery({ ...params, apiKey, perPage: '100', nextToken });
    const urlStr = `${MAILSHAKE_BASE}/${endpoint}?${q}`;
    formatLogMessage(`GET ${urlStr}`, log);
    let resp;
    let tries = 0;
    while (true) {
      resp = await fetch(urlStr);
      formatLogMessage(`↳ status ${resp.status}`, log);
      if (resp.ok) break;
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        // Exponential backoff in minutes: 1, 2, 4, 8, 16, 32, 64, ...
        const retryAfterMinutes = Math.pow(2, tries);
        const retryAfterMs = retryAfterMinutes * 60 * 1000;
        tries++;
        const now = new Date();
        const retryTime = new Date(now.getTime() + retryAfterMs);
        formatLogMessage(`rate-limited/server error (status ${resp.status}), retrying in ${retryAfterMinutes} minute${retryAfterMinutes !== 1 ? 's' : ''} at ${formatTimestamp(retryTime)} (attempt ${tries})`, log);
        await sleep(retryAfterMs);
        continue;
      }
      throw new Error(`Mailshake ${endpoint} failed: ${resp.status}`);
    }
    const json = await resp.json();
    if (Array.isArray(json.results)) results.push(...json.results);
    nextToken = json.nextToken || '';
    if (nextToken) await new Promise(r => setTimeout(r, 300));
  } while (nextToken);
  return results;
}

export async function getCampaignInfo(campaignId, apiKey, log) {
  const q = toQuery({ apiKey, campaignID: String(campaignId) });
  const urlStr = `${MAILSHAKE_BASE}/campaigns/get?${q}`;
  formatLogMessage(`GET ${urlStr}`, log);
  let resp;
  let tries = 0;
  while (true) {
    resp = await fetch(urlStr);
    formatLogMessage(`↳ status ${resp.status}`, log);
    if (resp.ok) break;
    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      // Exponential backoff in minutes: 1, 2, 4, 8, 16, 32, 64, ...
      const retryAfterMinutes = Math.pow(2, tries);
      const retryAfterMs = retryAfterMinutes * 60 * 1000;
      tries++;
      const now = new Date();
      const retryTime = new Date(now.getTime() + retryAfterMs);
      formatLogMessage(`rate-limited/server error (status ${resp.status}), retrying in ${retryAfterMinutes} minute${retryAfterMinutes !== 1 ? 's' : ''} at ${formatTimestamp(retryTime)} (attempt ${tries})`, log);
      await sleep(retryAfterMs);
      continue;
    }
    throw new Error(`campaigns/get failed: ${resp.status}`);
  }
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

export async function discoverCampaigns(searchTerm, apiKey, log) {
  formatLogMessage(`Discovering campaigns with search term: "${searchTerm}"`, log);
  const results = await fetchPaginated('campaigns/list', { search: searchTerm }, apiKey, log);
  const campaignIds = results.map(c => Number(c.id)).filter(Boolean);
  formatLogMessage(`Found ${campaignIds.length} campaigns matching "${searchTerm}"`, log);
  return campaignIds;
}

export async function collectCampaignStats(campaignId, apiKey, log, options = {}) {
  const { includeSendsOpens = true, includeLeads = true } = options;
  
  let sends = 0, uniqueOpens = 0, replies = 0;
  let won = 0, lost = 0, openLeads = 0;

  if (includeSendsOpens) {
    formatLogMessage(`Campaign ${campaignId}: fetching sends`, log);
    const sent = await fetchPaginated('activity/sent', { campaignID: String(campaignId) }, apiKey, log);
    sends = sent.length;

    formatLogMessage(`Campaign ${campaignId}: fetching opens`, log);
    const opens = await fetchPaginated('activity/opens', { campaignID: String(campaignId) }, apiKey, log);
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

    formatLogMessage(`Campaign ${campaignId}: fetching replies`, log);
    const repliesArr = await fetchPaginated('activity/replies', { campaignID: String(campaignId), replyType: 'reply' }, apiKey, log);
    replies = repliesArr.length;
  }

  if (includeLeads) {
    formatLogMessage(`Campaign ${campaignId}: fetching leads (closed/lost/open)`, log);
    won = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'closed' }, apiKey, log)).length;
    lost = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'lost' }, apiKey, log)).length;
    openLeads = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'open' }, apiKey, log)).length;
  }

  const info = await getCampaignInfo(campaignId, apiKey, log);

  return {
    id: String(campaignId),
    title: info?.title || 'Unknown Title',
    sender: info?.sender?.emailAddress || 'Unknown Sender',
    stats: { sends, uniqueOpens, replies, leads: { won, lost, open: openLeads } }
  };
}

export async function collectAllCampaigns(log, overrideIds, options = {}) {
  const { apiKey } = getConfig();
  if (!apiKey) throw new Error('Missing MAILSHAKE_API_KEY');
  
  // Discover campaigns with [VB] in title if not overridden
  let ids;
  if (Array.isArray(overrideIds) && overrideIds.length) {
    ids = overrideIds;
  } else {
    formatLogMessage(`Discovering campaigns with "[VB]" in title...`, log);
    ids = await discoverCampaigns('[VB]', apiKey, log);
    if (ids.length === 0) {
      formatLogMessage('No campaigns found with "[VB]" in title, using fallback from config', log);
      const { campaignIds } = getConfig();
      ids = campaignIds;
    }
  }
  
  const campaigns = {};
  const skippedIds = [];
  const totalCampaigns = ids.length;
  
  formatLogMessage(`Checking ${totalCampaigns} campaign(s) for refresh eligibility...`, log);
  
  // First pass: check which campaigns need refreshing
  const campaignsToRefresh = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const campaignIdStr = String(id);
    
    // Show progress every 10 campaigns or at the end
    if (i % 10 === 0 || i === ids.length - 1) {
      formatLogMessage(`Checked ${i + 1}/${totalCampaigns} campaigns...`, log);
    }
    
    // Check if campaign was refreshed in the last 12 hours
    const wasRecent = await wasCampaignRefreshedRecently(campaignIdStr, 12);
    if (wasRecent) {
      skippedIds.push(id);
    } else {
      campaignsToRefresh.push(id);
    }
  }
  
  if (skippedIds.length > 0) {
    formatLogMessage(`Skipping ${skippedIds.length} campaign(s) that were refreshed in the last 12 hours`, log);
  }
  
  if (campaignsToRefresh.length === 0) {
    formatLogMessage(`No campaigns need refreshing. All campaigns were recently updated.`, log);
    return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
  }
  
  formatLogMessage(`Processing ${campaignsToRefresh.length} campaign(s) that need refreshing...`, log);
  
  // Second pass: process campaigns that need refreshing
  for (let i = 0; i < campaignsToRefresh.length; i++) {
    const id = campaignsToRefresh[i];
    formatLogMessage(`Processing campaign ${id} (${i + 1}/${campaignsToRefresh.length})`, log);
    try {
      const c = await collectCampaignStats(id, apiKey, log, options);
      campaigns[c.id] = { title: c.title, sender: c.sender, stats: c.stats };
      // Store refresh timestamp after successful refresh
      await setCampaignRefreshTimestamp(c.id);
    } catch (error) {
      formatLogMessage(`Error processing campaign ${id}: ${error.message}`, log);
      // Don't store timestamp on error - allow retry
      throw error;
    }
  }
  
  formatLogMessage(`Refresh complete: ${campaignsToRefresh.length} campaign(s) processed, ${skippedIds.length} skipped`, log);
  
  return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
}


