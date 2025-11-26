import { wasCampaignRefreshedRecently, setCampaignRefreshTimestamp, getRefreshSession, markCampaignCompleted, clearRefreshSession } from './cache.js';

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
        // Retry every 1 minute until not rate limited
        const retryAfterMs = 60 * 1000; // 1 minute
        tries++;
        const now = new Date();
        const retryTime = new Date(now.getTime() + retryAfterMs);
        formatLogMessage(`rate-limited/server error (status ${resp.status}), retrying in 1 minute at ${formatTimestamp(retryTime)} (attempt ${tries})`, log);
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
      // Retry every 1 minute until not rate limited
      const retryAfterMs = 60 * 1000; // 1 minute
      tries++;
      const now = new Date();
      const retryTime = new Date(now.getTime() + retryAfterMs);
      formatLogMessage(`rate-limited/server error (status ${resp.status}), retrying in 1 minute at ${formatTimestamp(retryTime)} (attempt ${tries})`, log);
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
    formatLogMessage(`Campaign ${campaignId}: found ${sends} send(s)`, log);

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
    formatLogMessage(`Campaign ${campaignId}: found ${uniqueOpens} unique open(s) from ${opens.length} open event(s)`, log);

    formatLogMessage(`Campaign ${campaignId}: fetching replies`, log);
    const repliesArr = await fetchPaginated('activity/replies', { campaignID: String(campaignId), replyType: 'reply' }, apiKey, log);
    replies = repliesArr.length;
    formatLogMessage(`Campaign ${campaignId}: found ${replies} reply(ies)`, log);
  }

  if (includeLeads) {
    formatLogMessage(`Campaign ${campaignId}: fetching leads (closed/lost/open)`, log);
    won = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'closed' }, apiKey, log)).length;
    lost = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'lost' }, apiKey, log)).length;
    openLeads = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'open' }, apiKey, log)).length;
  }

  const info = await getCampaignInfo(campaignId, apiKey, log);
  
  // Log summary of collected stats for verification
  formatLogMessage(`Campaign ${campaignId} (${info?.title || 'Unknown'}): ${sends} sends, ${uniqueOpens} opens, ${replies} replies, ${won + lost + openLeads} leads`, log);

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
    // Log first few skipped campaign IDs for debugging
    if (skippedIds.length <= 10) {
      formatLogMessage(`Skipped campaign IDs: ${skippedIds.join(', ')}`, log);
    } else {
      formatLogMessage(`Skipped campaign IDs (first 10): ${skippedIds.slice(0, 10).join(', ')}...`, log);
    }
  }
  
  if (campaignsToRefresh.length === 0) {
    formatLogMessage(`No campaigns need refreshing. All campaigns were recently updated.`, log);
    return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
  }
  
  // Check for incomplete session to resume from
  const session = await getRefreshSession();
  const completedInSession = session.completedCampaigns;
  let resumedCount = 0;
  
  if (completedInSession.size > 0) {
    const sessionAge = session.startedAt ? (new Date().getTime() - session.startedAt.getTime()) / (1000 * 60 * 60) : 0;
    if (sessionAge < 24) { // Only resume if session is less than 24 hours old
      formatLogMessage(`Resuming previous refresh session (${completedInSession.size} campaign(s) already completed)`, log);
      resumedCount = completedInSession.size;
    } else {
      // Session too old, clear it
      await clearRefreshSession();
      formatLogMessage(`Previous session expired, starting fresh`, log);
    }
  }
  
  // Filter out campaigns already completed in this session
  const campaignsToProcess = campaignsToRefresh.filter(id => !completedInSession.has(String(id)));
  
  if (campaignsToProcess.length === 0 && campaignsToRefresh.length > 0) {
    formatLogMessage(`All ${campaignsToRefresh.length} campaign(s) already completed in this session`, log);
    // Clear session since we're done
    await clearRefreshSession();
    return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
  }
  
  formatLogMessage(`Processing ${campaignsToProcess.length} campaign(s) that need refreshing${resumedCount > 0 ? ` (${resumedCount} already done)` : ''}...`, log);
  
  // Second pass: process campaigns that need refreshing
  for (let i = 0; i < campaignsToProcess.length; i++) {
    const id = campaignsToProcess[i];
    formatLogMessage(`Processing campaign ${id} (${i + 1}/${campaignsToProcess.length})`, log);
    try {
      const c = await collectCampaignStats(id, apiKey, log, options);
      campaigns[c.id] = { title: c.title, sender: c.sender, stats: c.stats };
      // Store refresh timestamp after successful refresh
      await setCampaignRefreshTimestamp(c.id);
      // Mark as completed in this session
      await markCampaignCompleted(c.id);
    } catch (error) {
      formatLogMessage(`Error processing campaign ${id}: ${error.message}`, log);
      // Don't store timestamp on error - allow retry
      // Don't mark as completed - allow resume from here
      throw error;
    }
  }
  
  // Clear session on successful completion
  await clearRefreshSession();
  
  formatLogMessage(`Refresh complete: ${campaignsToProcess.length} campaign(s) processed, ${skippedIds.length} skipped`, log);
  
  return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
}


