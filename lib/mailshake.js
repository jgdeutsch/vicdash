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

export async function fetchPaginated(endpoint, params = {}, apiKey, log) {
  const results = [];
  let nextToken = '';
  do {
    const q = toQuery({ ...params, apiKey, perPage: '100', nextToken });
    const urlStr = `${MAILSHAKE_BASE}/${endpoint}?${q}`;
    log?.(`GET ${urlStr}`);
    let resp;
    let tries = 0;
    while (true) {
      resp = await fetch(urlStr);
      log?.(`↳ status ${resp.status}`);
      if (resp.ok) break;
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        const retryAfter = Number(resp.headers.get('retry-after')) || 1 + Math.min(5, tries) * 2;
        tries++;
        if (tries > 5) throw new Error(`Mailshake ${endpoint} failed: ${resp.status}`);
        log?.(`rate-limited/server error, retrying in ${retryAfter}s (attempt ${tries})`);
        await sleep(retryAfter * 1000);
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
  log?.(`GET ${urlStr}`);
  const resp = await fetch(urlStr);
  log?.(`↳ status ${resp.status}`);
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

export async function collectCampaignStats(campaignId, apiKey, log) {
  log?.(`Campaign ${campaignId}: fetching sends`);
  const sent = await fetchPaginated('activity/sent', { campaignID: String(campaignId) }, apiKey, log);
  const sends = sent.length;

  log?.(`Campaign ${campaignId}: fetching opens`);
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
  const uniqueOpens = unique.size;

  log?.(`Campaign ${campaignId}: fetching replies`);
  const repliesArr = await fetchPaginated('activity/replies', { campaignID: String(campaignId), replyType: 'reply' }, apiKey, log);
  const replies = repliesArr.length;

  log?.(`Campaign ${campaignId}: fetching leads (closed/lost/open)`);
  const won = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'closed' }, apiKey, log)).length;
  const lost = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'lost' }, apiKey, log)).length;
  const openLeads = (await fetchPaginated('leads/list', { campaignID: String(campaignId), status: 'open' }, apiKey, log)).length;

  const info = await getCampaignInfo(campaignId, apiKey, log);

  return {
    id: String(campaignId),
    title: info?.title || 'Unknown Title',
    sender: info?.sender?.emailAddress || 'Unknown Sender',
    stats: { sends, uniqueOpens, replies, leads: { won, lost, open: openLeads } }
  };
}

export async function collectAllCampaigns(log, overrideIds) {
  const { apiKey, campaignIds } = getConfig();
  if (!apiKey) throw new Error('Missing MAILSHAKE_API_KEY');
  const ids = Array.isArray(overrideIds) && overrideIds.length ? overrideIds : campaignIds;
  const campaigns = {};
  for (const id of ids) {
    log?.(`Processing campaign ${id}`);
    const c = await collectCampaignStats(id, apiKey, log);
    campaigns[c.id] = { title: c.title, sender: c.sender, stats: c.stats };
  }
  return { campaigns, lastUpdated: new Date().toISOString().replace(/\..+/, 'Z') };
}


