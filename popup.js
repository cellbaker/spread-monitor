const $rows = document.getElementById('rows');
const $search = document.getElementById('search');
const $exFilter = document.getElementById('ex-filter');
const $minSpread = document.getElementById('min-spread');
const $sort = document.getElementById('sort');
const $refresh = document.getElementById('refresh');
const $status = document.getElementById('status');
const $autoOpen = document.getElementById('auto-open');
const $tabSpreads = document.getElementById('tab-spreads');
const $tabLogs = document.getElementById('tab-logs');
const $logs = document.getElementById('logs');
const $table = document.getElementById('spread-table');
const $logCount = document.getElementById('log-count');

let currentState = null;
let logs = [];

function fmtPrice(v) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(4);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

function fmtPct(v) {
  if (!isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(3) + '%';
}

function classForSpread(v) {
  if (Math.abs(v) < 0.001) return 'zero';
  return v > 0 ? 'pos' : 'neg';
}

function render() {
  if (!currentState) {
    $rows.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9aa3b2;padding:20px">загрузка...</td></tr>';
    return;
  }

  const query = $search.value.trim().toUpperCase();
  const exFilter = $exFilter.value;
  const minSpread = parseFloat($minSpread.value) || 0;
  const sort = $sort.value;

  let all = [];
  for (const [id, ex] of Object.entries(currentState.exchanges)) {
    if (exFilter !== 'all' && exFilter !== id) continue;
    for (const r of ex.rows) all.push({ ...r, exId: id, exName: ex.name });
  }

  if (query) all = all.filter((r) => r.symbol.includes(query));
  if (minSpread > 0) all = all.filter((r) => Math.abs(r.spreadPct) >= minSpread);

  if (sort === 'abs') all.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
  else if (sort === 'signed') all.sort((a, b) => b.spreadPct - a.spreadPct);
  else all.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (!all.length) {
    $rows.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9aa3b2;padding:20px">ничего не найдено</td></tr>';
    return;
  }

  const html = all.slice(0, 300).map((r) => `
    <tr>
      <td><span class="exchange-tag tag-${r.exId}">${r.exName}</span></td>
      <td>${r.symbol}</td>
      <td class="num">${fmtPrice(r.last)}</td>
      <td class="num">${fmtPrice(r.fair)}</td>
      <td class="num ${classForSpread(r.spreadPct)}">${fmtPct(r.spreadPct)}</td>
    </tr>
  `).join('');
  $rows.innerHTML = html;
}

function renderStatus() {
  if (!currentState) { $status.textContent = ''; return; }
  const ago = Math.round((Date.now() - currentState.updatedAt) / 1000);
  const errs = Object.values(currentState.exchanges).filter((e) => !e.ok).map((e) => e.name);
  let s = `обновлено ${ago}с назад`;
  if (errs.length) s += ` · <span class="err">ошибка: ${errs.join(', ')}</span>`;
  $status.innerHTML = s;
}

async function load() {
  // Спрашиваем воркер напрямую: в storage state кладётся раз в 5с, в памяти он свежий.
  const fresh = await new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'sm-state' }, (r) => res(chrome.runtime.lastError ? null : r));
    } catch { res(null); }
  });
  if (fresh) currentState = fresh;
  else currentState = (await chrome.storage.local.get('state')).state || null; // воркер спит
  render();
  renderStatus();
}

chrome.storage.local.get(['autoOpen', 'autoOpenAvailable'], ({ autoOpen, autoOpenAvailable }) => {
  $autoOpen.checked = autoOpen !== false; // по умолчанию включено
  // В публичной сборке alerts.js отсутствует — прячем тумблер, чтобы не было мёртвой кнопки.
  if (autoOpenAvailable === false) {
    const box = $autoOpen.closest('label') || $autoOpen.parentElement;
    if (box) box.style.display = 'none';
  }
});
$autoOpen.addEventListener('change', () => {
  chrome.storage.local.set({ autoOpen: $autoOpen.checked });
});

$search.addEventListener('input', render);
$exFilter.addEventListener('change', render);
$minSpread.addEventListener('input', render);
$sort.addEventListener('change', render);
$refresh.addEventListener('click', () => {
  $refresh.disabled = true;
  chrome.runtime.sendMessage({ type: 'refresh' }, () => {
    $refresh.disabled = false;
    load();
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.state) {
    currentState = changes.state.newValue;
    render();
    renderStatus();
  }
  if (changes.anomalyLogs) {
    logs = Array.isArray(changes.anomalyLogs.newValue) ? changes.anomalyLogs.newValue : [];
    $logCount.textContent = logs.length;
    if (!$logs.classList.contains('hidden')) renderLogs();
  }
});

// ── вкладка «Логи» ──
function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtSignedPct(v, d = 2) {
  if (v == null || !isFinite(v)) return null;
  return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
}

function renderLogs() {
  $logCount.textContent = logs.length;
  if (!logs.length) {
    $logs.innerHTML = '<div class="empty">пока пусто — сюда падают все срабатывания, включая пропущенные по кулдауну</div>';
    return;
  }
  $logs.innerHTML = logs
    .map((e) => {
      const parts = [];
      if (e.spreadPct != null) parts.push(`спред ${fmtSignedPct(e.spreadPct)}`);
      if (e.maxLev != null) parts.push(`${e.maxLev}x`);
      if (e.movePct != null) parts.push(`движение ${fmtSignedPct(e.movePct, 1)}${e.moveWindow ? ` (${e.moveWindow})` : ''}`);
      return `<div class="log ${e.opened ? 'op' : 'sup'}">
        <div class="l1">
          <span class="dot2"></span>
          <span class="t">${fmtTime(e.t)}</span>
          <span class="sym">${e.symbol}</span>
          <span class="exchange-tag tag-${e.exId}">${e.exName}</span>
          <span class="rsn">${e.reason}</span>
        </div>
        <div class="l2"><span class="ty">${e.type}</span>${parts.length ? ' · ' + parts.join(' · ') : ''}</div>
      </div>`;
    })
    .join('');
}

function showTab(which) {
  const logsActive = which === 'logs';
  $tabLogs.classList.toggle('active', logsActive);
  $tabSpreads.classList.toggle('active', !logsActive);
  $logs.classList.toggle('hidden', !logsActive);
  $table.classList.toggle('hidden', logsActive);
  if (logsActive) renderLogs();
}
$tabSpreads.addEventListener('click', () => showTab('spreads'));
$tabLogs.addEventListener('click', () => showTab('logs'));

async function loadLogs() {
  const { anomalyLogs } = await chrome.storage.local.get('anomalyLogs');
  logs = Array.isArray(anomalyLogs) ? anomalyLogs : [];
  $logCount.textContent = logs.length;
  if (!$logs.classList.contains('hidden')) renderLogs();
}

setInterval(renderStatus, 1000);
load();
loadLogs();
