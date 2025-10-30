function fmtPct(n) {
  if (!isFinite(n)) return '0.0%';
  return (n * 100).toFixed(1) + '%';
}

function num(n) {
  return Number(n || 0);
}

async function fetchStats() {
  const res = await fetch('/api/stats', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch /api/stats');
  return res.json();
}

const MAILSHAKE_TEAM_ID = 6788;
let sortKey = 'leadsOpen'; // default sort by open leads desc
let sortDir = 'desc';

function computeAggregates(campaigns) {
  let sends = 0, opens = 0, replies = 0, leadsOpen = 0, leadsWon = 0, leadsLost = 0;
  Object.values(campaigns).forEach(c => {
    sends += num(c.stats?.sends);
    opens += num(c.stats?.uniqueOpens ?? c.stats?.opens);
    replies += num(c.stats?.replies);
    leadsOpen += num(c.stats?.leads?.open);
    leadsWon += num(c.stats?.leads?.won);
    leadsLost += num(c.stats?.leads?.lost);
  });
  return { sends, opens, replies, leadsOpen, leadsWon, leadsLost };
}

function renderSummary(root, data) {
  const { sends, opens, replies, leadsOpen, leadsWon, leadsLost } = computeAggregates(data.campaigns || {});
  const openRate = sends ? opens / sends : 0;
  const replyRate = sends ? replies / sends : 0;
  root.innerHTML = `
    <div class="kpi"><div class="label">Total Sends</div><div class="value">${sends.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Total Opens</div><div class="value">${opens.toLocaleString()} <span class="muted">(${fmtPct(openRate)})</span></div></div>
    <div class="kpi"><div class="label">Total Replies</div><div class="value">${replies.toLocaleString()} <span class="muted">(${fmtPct(replyRate)})</span></div></div>
    <div class="kpi"><div class="label">Open Leads</div><div class="value">${leadsOpen.toLocaleString()}</div></div>
    <div class="kpi"><div class="label">Won / Lost</div><div class="value">${leadsWon.toLocaleString()} / ${leadsLost.toLocaleString()}</div></div>
  `;
}

function classifyOpenRate(openRate) {
  const pct = openRate * 100;
  if (pct >= 60) return 'good';
  if (pct >= 50) return 'warn';
  return 'bad';
}

function classifyReplyRate(replyRate) {
  const pct = replyRate * 100;
  if (pct >= 6) return 'good';
  if (pct >= 4) return 'warn';
  return 'bad';
}

function renderTable(tbody, data) {
  const rows = [];
  const entries = Object.entries(data.campaigns || {});

  // Build comparable metrics per row for sorting
  const enriched = entries.map(([id, c]) => {
    const sends = num(c.stats?.sends);
    const opens = num(c.stats?.uniqueOpens ?? c.stats?.opens);
    const replies = num(c.stats?.replies);
    const leadsOpen = num(c.stats?.leads?.open);
    const leadsWon = num(c.stats?.leads?.won);
    const leadsLost = num(c.stats?.leads?.lost);
    const openRate = sends ? opens / sends : 0;
    const replyRate = sends ? replies / sends : 0;
    return { id, c, sends, opens, replies, leadsOpen, leadsWon, leadsLost, openRate, replyRate };
  });

  enriched.sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const get = (r) => {
      switch (sortKey) {
        case 'campaign': return (r.c.title || '').toLowerCase();
        case 'sender': return (r.c.sender || '').toLowerCase();
        case 'sends': return r.sends;
        case 'opens': return r.opens;
        case 'openRate': return r.openRate;
        case 'replies': return r.replies;
        case 'replyRate': return r.replyRate;
        case 'leadsOpen': return r.leadsOpen;
        case 'leadsWon': return r.leadsWon;
        case 'leadsLost': return r.leadsLost;
        default: return r.leadsOpen;
      }
    };
    const av = get(a);
    const bv = get(b);
    if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });

  for (const r of enriched) {
    const { id, c, sends, opens, replies, leadsOpen, leadsWon, leadsLost, openRate, replyRate } = r;
    const openBadge = classifyOpenRate(openRate);
    const replyBadge = classifyReplyRate(replyRate);

    rows.push(`
      <tr>
        <td><a href="https://app.mailshake.com/${MAILSHAKE_TEAM_ID}/campaigns/all/${id}/prospects/list" target="_blank" rel="noopener">${c.title || 'Unknown Title'}</a></td>
        <td>${(c.sender || '').toString()}</td>
        <td>${sends.toLocaleString()}</td>
        <td>${opens.toLocaleString()}</td>
        <td><span class="pill ${openBadge}">${fmtPct(openRate)}</span></td>
        <td>${replies.toLocaleString()}</td>
        <td><span class="pill ${replyBadge}">${fmtPct(replyRate)}</span></td>
        <td>${leadsOpen.toLocaleString()}</td>
        <td>${leadsWon.toLocaleString()}</td>
        <td>${leadsLost.toLocaleString()}</td>
      </tr>
    `);
  }

  tbody.innerHTML = rows.join('');
}

async function render() {
  const summary = document.getElementById('summary');
  const tbody = document.getElementById('campaign-body');
  const data = await fetchStats();
  renderSummary(summary, data);
  renderTable(tbody, data);
}

document.getElementById('refresh').addEventListener('click', async () => {
  const btn = document.getElementById('refresh');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const logEl = document.getElementById('log');
    logEl.textContent = '';
    logEl.textContent += 'Connecting to refresh stream...\n';
    let lineCount = 0;
    const es = new EventSource('/api/refresh-stream');
    await new Promise((resolve) => {
      es.onmessage = (ev) => {
        try {
          const { msg } = JSON.parse(ev.data);
          if (msg === 'done') { es.close(); resolve(); return; }
          logEl.textContent += msg + '\n';
          logEl.scrollTop = logEl.scrollHeight;
          lineCount++;
        } catch {
          logEl.textContent += ev.data + '\n';
          lineCount++;
        }
      };
      es.onerror = () => { es.close(); resolve(); };
    });

    // Fallback if no stream lines were received
    if (lineCount === 0) {
      logEl.textContent += 'Stream not available, falling back to one-shot refresh...\n';
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        alert('Refresh failed: ' + text);
      } else {
        logEl.textContent += 'Refresh completed.\n';
      }
    }
  } catch (e) {
    alert('Refresh error: ' + e);
  } finally {
    await render().catch(err => console.error(err));
    btn.textContent = original;
    btn.disabled = false;
  }
});

// Settings modal
function openSettings() {
  const tpl = document.getElementById('settings-template');
  const node = tpl.content.cloneNode(true);
  const modal = node.querySelector('.modal');
  document.body.appendChild(node);

  const close = () => document.querySelector('.modal')?.remove();
  document.getElementById('closeSettings').addEventListener('click', close);
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const campaignIds = document.getElementById('campaignIdsInput').value.trim();
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, campaignIds })
      });
      if (!res.ok) {
        const text = await res.text();
        alert(`Failed to save settings (status ${res.status}):\n${text}`);
        return;
      }
      close();
      // Immediately refresh after saving
      document.getElementById('refresh').click();
    } catch (e) {
      alert('Save error: ' + e);
    }
  });
}

document.getElementById('settings').addEventListener('click', openSettings);

render().catch(err => console.error(err));

// Sorting interactions
function applySortIndicators() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sorted');
    th.querySelector('.sort').textContent = '';
    if (th.dataset.sort === sortKey) {
      th.classList.add('sorted');
      th.querySelector('.sort').textContent = sortDir === 'asc' ? '▲' : '▼';
    }
  });
}

document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = key === 'campaign' || key === 'sender' ? 'asc' : 'desc';
    }
    render().then(applySortIndicators);
  });
});


