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

// Campaign update queue system
const updateQueue = [];
let isProcessingQueue = false;
const campaignUpdateStatus = new Map(); // campaignId -> 'queued' | 'processing' | 'completed' | 'error'
const campaignUpdateButtons = new Map(); // campaignId -> button element

// Process a single campaign update
async function processCampaignUpdate(campaignId) {
  const logEl = document.getElementById('log');
  const formatTimestamp = () => {
    const date = new Date();
    return date.toISOString().replace('T', ' ').substring(0, 19);
  };
  
  const button = campaignUpdateButtons.get(campaignId);
  const originalText = button ? button.textContent : 'Update';
  
  try {
    campaignUpdateStatus.set(campaignId, 'processing');
    if (button) {
      button.disabled = true;
      button.textContent = 'Updating...';
    }
    
    logEl.textContent += `[${formatTimestamp()}] Updating campaign ${campaignId}...\n`;
    logEl.scrollTop = logEl.scrollHeight;
    
    // Use EventSource for streaming updates
    const es = new EventSource(`/api/refresh-campaign?campaignId=${campaignId}`);
    let finalData = null;
    await new Promise((resolve) => {
      es.onmessage = (ev) => {
        try {
          const { msg } = JSON.parse(ev.data);
          if (msg === 'done') { es.close(); resolve(); return; }
          logEl.textContent += msg + '\n';
          logEl.scrollTop = logEl.scrollHeight;
        } catch {
          logEl.textContent += ev.data + '\n';
        }
      };
      es.addEventListener('final', (ev) => {
        try {
          finalData = JSON.parse(ev.data);
        } catch {}
      });
      es.onerror = () => { es.close(); resolve(); };
    });
    
    if (finalData) {
      await render(finalData).catch(err => console.error(err));
    } else {
      // Fallback: try POST request if EventSource doesn't work
      const res = await fetch('/api/refresh-campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      await render();
    }
    
    campaignUpdateStatus.set(campaignId, 'completed');
    if (button) {
      button.textContent = '✓ Updated!';
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
        campaignUpdateStatus.delete(campaignId);
      }, 2000);
    }
  } catch (error) {
    campaignUpdateStatus.set(campaignId, 'error');
    logEl.textContent += `[${formatTimestamp()}] ✗ Error: ${error.message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    if (button) {
      button.textContent = originalText;
      button.disabled = false;
    }
    campaignUpdateStatus.delete(campaignId);
    throw error;
  }
}

// Update queue position displays
function updateQueueDisplays() {
  updateQueue.forEach((campaignId, index) => {
    const button = campaignUpdateButtons.get(campaignId);
    if (button && campaignUpdateStatus.get(campaignId) === 'queued') {
      button.textContent = `Queued (${index + 1})`;
    }
  });
}

// Process the update queue
async function processUpdateQueue() {
  if (isProcessingQueue || updateQueue.length === 0) {
    return;
  }
  
  isProcessingQueue = true;
  
  while (updateQueue.length > 0) {
    const campaignId = updateQueue.shift();
    updateQueueDisplays(); // Update remaining queue positions
    try {
      await processCampaignUpdate(campaignId);
    } catch (error) {
      console.error(`Error processing campaign ${campaignId}:`, error);
      // Continue with next item in queue
    }
  }
  
  isProcessingQueue = false;
}

// Add campaign to update queue
function queueCampaignUpdate(campaignId) {
  // Don't add if already queued or processing
  if (campaignUpdateStatus.has(campaignId)) {
    return;
  }
  
  campaignUpdateStatus.set(campaignId, 'queued');
  updateQueue.push(campaignId);
  
  const button = campaignUpdateButtons.get(campaignId);
  if (button) {
    const queuePosition = updateQueue.length;
    button.textContent = `Queued (${queuePosition})`;
    button.disabled = true;
  }
  
  // Start processing if not already running
  processUpdateQueue();
}

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
  if (pct >= 7) return 'good';
  if (pct >= 5) return 'warn';
  return 'bad';
}

function classifyWinRate(winRate) {
  const pct = winRate * 100;
  if (pct >= 4) return 'good';
  if (pct >= 2) return 'warn';
  return 'bad';
}

function daysSinceUpdate(lastUpdate) {
  if (!lastUpdate) return null;
  const lastUpdateDate = new Date(lastUpdate);
  if (isNaN(lastUpdateDate.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - lastUpdateDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays;
}

function renderTable(tbody, data) {
  const entries = Object.entries(data.campaigns || {});
  try { console.debug('renderTable entries:', entries); } catch {}
  console.log('renderTable entries:', entries);
  
  // Clear button map to avoid stale references (will be repopulated below)
  campaignUpdateButtons.clear();

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
    const winRate = sends ? leadsWon / sends : 0;
    const lastUpdateDays = daysSinceUpdate(c.lastUpdate);
    return { id, c, sends, opens, replies, leadsOpen, leadsWon, leadsLost, openRate, replyRate, winRate, lastUpdateDays };
  });

  enriched.sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const get = (r) => {
      switch (sortKey) {
        case 'lastUpdate': return r.lastUpdateDays !== null ? r.lastUpdateDays : Infinity;
        case 'campaign': return (r.c.title || '').toLowerCase();
        case 'sender': return (r.c.sender || '').toLowerCase();
        case 'sends': return r.sends;
        case 'opens': return r.opens;
        case 'openRate': return r.openRate;
        case 'replies': return r.replies;
        case 'replyRate': return r.replyRate;
        case 'winRate': return r.winRate;
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

  // Wipe existing rows
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (enriched.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.textContent = 'No campaigns to display';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const r of enriched) {
    const { id, c, sends, opens, replies, leadsOpen, leadsWon, leadsLost, openRate, replyRate, winRate, lastUpdateDays } = r;
    const tr = document.createElement('tr');

    // Last update column with update button
    const tdLastUpdate = document.createElement('td');
    const lastUpdateContainer = document.createElement('div');
    lastUpdateContainer.style.display = 'flex';
    lastUpdateContainer.style.alignItems = 'center';
    lastUpdateContainer.style.gap = '8px';
    lastUpdateContainer.style.flexDirection = 'column';
    lastUpdateContainer.style.alignItems = 'flex-start';
    
    const lastUpdateText = document.createElement('span');
    if (lastUpdateDays !== null) {
      lastUpdateText.textContent = `${lastUpdateDays} day${lastUpdateDays !== 1 ? 's' : ''}`;
      // Show completion status if available
      if (c.statsComplete !== undefined) {
        const completionIndicator = document.createElement('span');
        completionIndicator.style.fontSize = '0.75rem';
        completionIndicator.style.marginLeft = '4px';
        if (c.statsComplete) {
          completionIndicator.textContent = '✓';
          completionIndicator.style.color = 'var(--md-sys-color-primary)';
          completionIndicator.title = 'Stats fully updated (pagination complete)';
        } else {
          completionIndicator.textContent = '⚠';
          completionIndicator.style.color = 'var(--md-sys-color-error)';
          completionIndicator.title = 'Stats may be incomplete (pagination not verified)';
        }
        lastUpdateText.appendChild(completionIndicator);
      }
    } else {
      lastUpdateText.textContent = 'Never';
      lastUpdateText.style.color = 'var(--md-sys-color-on-surface-variant)';
    }
    lastUpdateContainer.appendChild(lastUpdateText);
    
    const updateBtn = document.createElement('button');
    updateBtn.textContent = 'Update';
    updateBtn.className = 'secondary';
    updateBtn.style.fontSize = '0.75rem';
    updateBtn.style.padding = '4px 8px';
    updateBtn.style.cursor = 'pointer';
    
    // Store button reference for queue management
    campaignUpdateButtons.set(id, updateBtn);
    
    // Update button state based on current status
    const status = campaignUpdateStatus.get(id);
    if (status === 'queued') {
      const queueIndex = updateQueue.indexOf(id);
      if (queueIndex >= 0) {
        updateBtn.textContent = `Queued (${queueIndex + 1})`;
      } else {
        updateBtn.textContent = 'Queued';
      }
      updateBtn.disabled = true;
    } else if (status === 'processing') {
      updateBtn.textContent = 'Updating...';
      updateBtn.disabled = true;
    }
    
    updateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      queueCampaignUpdate(id);
    });
    lastUpdateContainer.appendChild(updateBtn);
    tdLastUpdate.appendChild(lastUpdateContainer);
    tr.appendChild(tdLastUpdate);

    // Campaign title column
    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://app.mailshake.com/${MAILSHAKE_TEAM_ID}/campaigns/all/${id}/prospects/list`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = c.title || 'Unknown Title';
    tdTitle.appendChild(a);
    tr.appendChild(tdTitle);

    const cells = [
      (c.sender || '').toString(),
      sends.toLocaleString(),
      opens.toLocaleString(),
      replies.toLocaleString(),
      leadsOpen.toLocaleString(),
      leadsWon.toLocaleString(),
      leadsLost.toLocaleString(),
      fmtPct(openRate),
      fmtPct(replyRate),
      fmtPct(winRate)
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      // i === 7 => Open %, i === 8 => Reply %, i === 9 => Win %
      if (i === 7) {
        const span = document.createElement('span');
        span.className = `pill ${classifyOpenRate(openRate)}`;
        span.textContent = cells[i];
        td.appendChild(span);
      } else if (i === 8) {
        const span = document.createElement('span');
        span.className = `pill ${classifyReplyRate(replyRate)}`;
        span.textContent = cells[i];
        td.appendChild(span);
      } else if (i === 9) {
        const span = document.createElement('span');
        span.className = `pill ${classifyWinRate(winRate)}`;
        span.textContent = cells[i];
        td.appendChild(span);
      } else {
        td.textContent = cells[i];
      }
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

async function render(providedData) {
  const summary = document.getElementById('summary');
  const tbody = document.getElementById('campaign-body');
  const data = providedData || await fetchStats();
  console.log('Render data:', data);
  console.log('Campaigns:', data.campaigns);
  console.log('Campaigns keys:', Object.keys(data.campaigns || {}));
  renderSummary(summary, data);
  renderTable(tbody, data);
  const countEl = document.getElementById('campaign-count');
  if (countEl) {
    const n = Object.keys(data.campaigns || {}).length;
    countEl.textContent = n ? `(${n})` : '(0)';
  }
}

function setupRefreshButton(buttonId, endpoint, buttonLabel) {
  const btn = document.getElementById(buttonId);
  if (!btn) {
    console.error(`Button with id "${buttonId}" not found`);
    return;
  }
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    let usedFinal = false;
    try {
      const formatTimestamp = () => {
        const date = new Date();
        return date.toISOString().replace('T', ' ').substring(0, 19);
      };

      const logEl = document.getElementById('log');
      logEl.textContent = '';
      logEl.textContent += `[${formatTimestamp()}] Connecting to ${buttonLabel} refresh stream...\n`;
      let lineCount = 0;
      let finalData = null;
      const es = new EventSource(endpoint);
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
        es.addEventListener('final', (ev) => {
          try { finalData = JSON.parse(ev.data); } catch {}
        });
        es.onerror = () => { es.close(); resolve(); };
      });

      // Fallback if no stream lines were received
      if (lineCount === 0) {
        logEl.textContent += `[${formatTimestamp()}] Stream not available, falling back to one-shot refresh...\n`;
        const res = await fetch(endpoint);
        if (!res.ok) {
          const text = await res.text();
          alert('Refresh failed: ' + text);
        } else {
          logEl.textContent += `[${formatTimestamp()}] Refresh completed.\n`;
        }
      }
      if (finalData) {
        usedFinal = true;
        await render(finalData).catch(err => console.error(err));
        btn.textContent = original;
        btn.disabled = false;
        return;
      }
    } catch (e) {
      alert('Refresh error: ' + e);
    } finally {
      if (!usedFinal) {
        await render().catch(err => console.error(err));
      }
      btn.textContent = original;
      btn.disabled = false;
    }
  });
}


// Export Won Leads functionality
document.getElementById('export-won-leads').addEventListener('click', async () => {
  const exportBtn = document.getElementById('export-won-leads');
  const original = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting...';
  
  try {
    const res = await fetch('/api/export-won-leads', {
      method: 'GET',
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errorData.error || `HTTP ${res.status}`);
    }
    
    // Get the CSV content
    const csv = await res.text();
    
    // Create a blob and download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'won-leads.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    // Show success message briefly
    exportBtn.textContent = '✓ Exported!';
    setTimeout(() => {
      exportBtn.textContent = original;
    }, 2000);
  } catch (error) {
    alert(`Export failed: ${error.message}`);
    exportBtn.textContent = original;
  } finally {
    exportBtn.disabled = false;
  }
});

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

// Setup refresh buttons
setupRefreshButton('refresh-sends-opens', '/api/refresh-sends-opens', 'sends/opens');
setupRefreshButton('refresh-leads', '/api/refresh-leads', 'leads');

// Reset refresh window button
document.getElementById('reset-refresh-window').addEventListener('click', async () => {
  const btn = document.getElementById('reset-refresh-window');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Resetting...';
  
  const logEl = document.getElementById('log');
  const formatTimestamp = () => {
    const date = new Date();
    return date.toISOString().replace('T', ' ').substring(0, 19);
  };
  
  try {
    logEl.textContent += `[${formatTimestamp()}] Resetting 12-hour refresh window...\n`;
    logEl.scrollTop = logEl.scrollHeight;
    
    const res = await fetch('/api/reset-refresh-timestamps', {
      method: 'POST',
      credentials: 'include'
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errorData.error || `HTTP ${res.status}`);
    }
    
    const data = await res.json();
    logEl.textContent += `[${formatTimestamp()}] ✓ ${data.message || 'Refresh window reset successfully'}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    
    btn.textContent = '✓ Reset!';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  } catch (error) {
    logEl.textContent += `[${formatTimestamp()}] ✗ Error: ${error.message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    alert(`Reset failed: ${error.message}`);
    btn.textContent = original;
    btn.disabled = false;
  }
});

// Fetch and display version
(async () => {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const versionEl = document.getElementById('version-number');
      if (versionEl) versionEl.textContent = data.version || 'unknown';
    }
  } catch (e) {
    const versionEl = document.getElementById('version-number');
    if (versionEl) versionEl.textContent = 'unknown';
  }
})();

