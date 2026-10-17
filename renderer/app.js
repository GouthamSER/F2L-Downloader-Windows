'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let items = [], settings = {}, tab = 'all', detailId = null, delId = null;

const fmtBytes = b => {
  if (b == null || b < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + u[i];
};
const fmtSpeed = s => s < 0 ? 'Finalizing…' : fmtBytes(s) + '/s';
const fmtEta = s => {
  if (s == null || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
};
const pct = i => i.totalBytes > 0 ? Math.min(100, i.downloadedBytes * 100 / i.totalBytes) : (i.status === 'COMPLETED' ? 100 : 0);
const STATUS = { QUEUED: 'Queued', DOWNLOADING: 'Downloading', PAUSED: 'Paused', COMPLETED: 'Completed', FAILED: 'Failed', CANCELED: 'Canceled' };
const matches = i => tab === 'all' || (tab === 'active' && (i.status === 'DOWNLOADING' || i.status === 'QUEUED' || i.status === 'PAUSED')) ||
  (tab === 'completed' && i.status === 'COMPLETED') || (tab === 'failed' && i.status === 'FAILED');

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

function sparkSvg(hist, w = 110, h = 34) {
  if (!hist || hist.length < 2) return '';
  const max = Math.max(...hist, 1), step = w / (hist.length - 1);
  const pts = hist.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (Math.max(v, 0) / max) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="#2F7BFF" stroke-width="2" stroke-linejoin="round" points="${pts.join(' ')}"/></svg>`;
}

function actionsFor(i) {
  const b = (act, icon, title) => `<button class="ic" data-act="${act}" title="${title}" aria-label="${title}">${icon}</button>`;
  const a = [];
  if (i.status === 'DOWNLOADING' || i.status === 'QUEUED') a.push(b('pause', '⏸', 'Pause'));
  if (i.status === 'PAUSED') a.push(b('start', '▶', 'Resume'));
  if (i.status === 'FAILED') a.push(b('retry', '⟳', 'Retry'));
  if (i.status === 'COMPLETED') { a.push(b('open', '📄', 'Open file')); a.push(b('reveal', '📁', 'Show in folder')); }
  a.push(b('remove', '🗑', 'Remove'));
  return a.join('');
}

function renderList() {
  const shown = items.filter(matches);
  const list = $('#list');
  list.innerHTML = shown.map(i => {
    const p = pct(i);
    const ind = (i.status === 'DOWNLOADING' && i.totalBytes <= 0) || i.speed === -1;
    const meta = [];
    if (i.status === 'DOWNLOADING') {
      meta.push(`<span>${fmtSpeed(i.speed)}</span>`);
      if (i.speed >= 0) meta.push(`<span>ETA ${fmtEta(i.eta)}</span>`);
    }
    meta.push(`<span>${fmtBytes(i.downloadedBytes)}${i.totalBytes > 0 ? ' / ' + fmtBytes(i.totalBytes) : ''}</span>`);
    if (i.totalBytes > 0 && i.status !== 'COMPLETED') meta.push(`<span>${p.toFixed(1)}%</span>`);
    if (!i.isTorrent && i.status === 'DOWNLOADING') meta.push(`<span>${i.singleOnly ? 1 : i.connections} conn</span>`);
    return `<div class="card ${i.status}" data-id="${i.id}">
      <div style="min-width:0"><div class="name"><span class="badge ${i.status}">${STATUS[i.status] || i.status}</span>${i.isTorrent ? '<span class="badge mag">magnet</span>' : ''}<span style="overflow:hidden;text-overflow:ellipsis">${esc(i.fileName)}</span></div>
      <div class="meta">${meta.join('')}</div></div>
      <div class="acts">${i.status === 'DOWNLOADING' ? sparkSvg(i.speedHistory.slice(-30)) : ''}${actionsFor(i)}</div>
      <div class="prog ${ind ? 'ind' : ''}"><div style="width:${p}%"></div></div>
      ${i.error ? `<div class="err">${esc(i.error)}</div>` : ''}
    </div>`;
  }).join('');
  $('#empty').hidden = shown.length > 0;
  list.hidden = shown.length === 0;

  const c = t => items.filter(i => t === 'all' || (t === 'active' ? ['DOWNLOADING', 'QUEUED', 'PAUSED'].includes(i.status) : t === 'completed' ? i.status === 'COMPLETED' : i.status === 'FAILED')).length;
  for (const t of ['all', 'active', 'completed', 'failed']) $('#c-' + t).textContent = c(t);
  $('#totalSpeed').textContent = fmtBytes(items.reduce((a, i) => a + (i.status === 'DOWNLOADING' && i.speed > 0 ? i.speed : 0), 0)) + '/s';
  if (detailId) renderDetail();
}

function drawChart(cv, hist) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const dark = document.body.dataset.theme !== 'light';
  g.clearRect(0, 0, w, h);
  g.strokeStyle = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.08)'; g.lineWidth = 1;
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(0, h * k / 4); g.lineTo(w, h * k / 4); g.stroke(); }
  const d = hist.map(v => Math.max(v, 0));
  if (d.length < 2) { g.fillStyle = '#8B93A7'; g.font = '12px sans-serif'; g.fillText('Waiting for data…', 12, 22); return; }
  const max = Math.max(...d, 1) * 1.15, step = w / (d.length - 1);
  const y = v => h - 6 - (v / max) * (h - 14);
  g.beginPath(); d.forEach((v, k) => k ? g.lineTo(k * step, y(v)) : g.moveTo(0, y(v)));
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(47,123,255,.45)'); grad.addColorStop(1, 'rgba(47,123,255,0)');
  g.fillStyle = grad; g.fill();
  g.beginPath(); d.forEach((v, k) => k ? g.lineTo(k * step, y(v)) : g.moveTo(0, y(v)));
  g.strokeStyle = '#2F7BFF'; g.lineWidth = 2.5; g.shadowColor = '#2F7BFF'; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
  g.fillStyle = '#8B93A7'; g.font = '11px sans-serif'; g.fillText('peak ' + fmtSpeed(Math.max(...d)), 8, 14);
}

function renderDetail() {
  const i = items.find(x => x.id === detailId);
  if (!i) { $('#dlgDetail').close(); detailId = null; return; }
  const segs = (i.segs || []).map(s => `<div title="${fmtBytes(s.d)} / ${fmtBytes(s.e - s.s + 1)}"><i style="width:${Math.min(100, s.d * 100 / (s.e - s.s + 1))}%"></i></div>`).join('');
  const root = $('#detail');
  const keep = root.querySelector('canvas');
  root.innerHTML = `<div class="dh"><div style="min-width:0"><h2>${esc(i.fileName)}</h2><span class="badge ${i.status}">${STATUS[i.status]}</span> ${i.isTorrent ? '<span class="badge mag">magnet</span>' : ''}</div>
    <div class="acts">${actionsFor(i)}<button class="ic" data-act="close" title="Close" aria-label="Close">✕</button></div></div>
    <div class="prog ${i.speed === -1 ? 'ind' : ''}" style="margin-top:12px"><div style="width:${pct(i)}%"></div></div>
    <canvas class="chart" id="chart"></canvas>
    ${segs ? `<div class="segs" title="Per-connection progress">${segs}</div>` : ''}
    <dl class="kv">
      <dt>Speed</dt><dd>${i.status === 'DOWNLOADING' ? fmtSpeed(i.speed) : '—'}</dd>
      <dt>Progress</dt><dd>${fmtBytes(i.downloadedBytes)} / ${fmtBytes(i.totalBytes)} (${pct(i).toFixed(1)}%)</dd>
      <dt>ETA</dt><dd>${i.status === 'DOWNLOADING' ? fmtEta(i.eta) : '—'}</dd>
      <dt>Connections</dt><dd>${i.isTorrent ? '—' : (i.singleOnly ? '1 (server has no range support)' : i.connections)}</dd>
      <dt>Saved to</dt><dd>${esc(i.folder)}</dd>
      <dt>URL</dt><dd>${esc(i.url)}</dd>
      ${i.magnetHash ? `<dt>Info hash</dt><dd>${esc(i.magnetHash)}</dd>` : ''}
      ${i.referer ? `<dt>Referer</dt><dd>${esc(i.referer)}</dd>` : ''}
      ${i.userAgent ? `<dt>User-Agent</dt><dd>${esc(i.userAgent)}</dd>` : ''}
      ${i.error ? `<dt>Error</dt><dd style="color:var(--err)">${esc(i.error)}</dd>` : ''}
    </dl>`;
  drawChart($('#chart'), i.speedHistory || []);
}

// ---------- events ----------
async function act(act, id) {
  const i = items.find(x => x.id === id); if (!i) return;
  switch (act) {
    case 'pause': return window.f2l.pause(id);
    case 'start': return window.f2l.start(id);
    case 'retry': return window.f2l.retry(id);
    case 'open': { const err = await window.f2l.open(id); if (err) toast('Cannot open file: ' + err); return; }
    case 'reveal': return window.f2l.reveal(id);
    case 'remove':
      if (i.status === 'COMPLETED') { delId = id; $('#delText').textContent = `Remove “${i.fileName}” from the list? You can also delete the file from disk.`; $('#delFile').hidden = false; }
      else { delId = id; $('#delText').textContent = `Remove “${i.fileName}”? Partial data will be deleted.`; $('#delFile').hidden = true; }
      return $('#dlgDel').showModal();
    case 'close': return $('#dlgDetail').close();
  }
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    e.stopPropagation();
    const id = btn.closest('.card') ? +btn.closest('.card').dataset.id : detailId;
    return act(btn.dataset.act, id);
  }
  const card = e.target.closest('.card');
  if (card) { detailId = +card.dataset.id; renderDetail(); $('#dlgDetail').showModal(); }
});
$('#dlgDetail').addEventListener('close', () => { detailId = null; });
$('#dlgDetail').addEventListener('click', e => { if (e.target.id === 'dlgDetail') e.target.close(); });
$('#delCancel').onclick = () => $('#dlgDel').close();
$('#delList').onclick = async () => { $('#dlgDel').close(); await window.f2l.remove(delId, false); };
$('#delFile').onclick = async () => { $('#dlgDel').close(); await window.f2l.remove(delId, true); };

$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x === b));
  const st = tab === 'settings';
  $('#viewList').hidden = st; $('#viewSettings').hidden = !st;
  $('#title').textContent = { all: 'All downloads', active: 'Active', completed: 'Completed', failed: 'Failed' }[tab] || '';
  if (!st) renderList();
});
$('#btnPauseAll').onclick = () => window.f2l.pauseAll();
$('#btnResumeAll').onclick = () => window.f2l.resumeAll();
$('#btnClear').onclick = () => window.f2l.clearCompleted();

// ----- add dialog -----
const UA_PRESETS = $('#addUA');
const urlCount = () => { const n = window.extractCount($('#addUrls').value); $('#addCount').textContent = n ? `${n} link${n > 1 ? 's' : ''} found` : ''; $('#addName').disabled = n > 1; };
window.extractCount = t => new Set((t.match(/(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi) || [])).size;
async function openAdd(prefill) {
  $('#addUrls').value = prefill || '';
  $('#addName').value = ''; $('#addRef').value = ''; $('#addHdr').value = ''; UA_PRESETS.value = ''; $('#addUACustom').hidden = true;
  $('#addConn').value = settings.connections; $('#addConnV').textContent = settings.connections;
  $('#addFolder').value = settings.folder; $('#addStart').checked = true;
  urlCount(); $('#dlgAdd').showModal(); $('#addUrls').focus();
}
$('#btnAdd').onclick = async () => openAdd((await window.f2l.clipboard()).join('\n'));
$('#addUrls').addEventListener('input', urlCount);
$('#addConn').addEventListener('input', e => { $('#addConnV').textContent = e.target.value; });
UA_PRESETS.addEventListener('change', () => { $('#addUACustom').hidden = UA_PRESETS.value !== '__custom'; });
$('#btnPaste').onclick = async () => {
  const u = await window.f2l.clipboard();
  if (!u.length) return toast('No links on the clipboard');
  const cur = $('#addUrls').value.trim();
  $('#addUrls').value = (cur ? cur + '\n' : '') + u.join('\n'); urlCount();
};
$('#btnImport').onclick = async () => {
  const u = await window.f2l.importFile(); if (!u.length) return;
  const cur = $('#addUrls').value.trim(); $('#addUrls').value = (cur ? cur + '\n' : '') + u.join('\n'); urlCount();
};
$('#btnAddFolder').onclick = async () => { const f = await window.f2l.pickFolder(); if (f) $('#addFolder').value = f; };
$('#btnAddCancel').onclick = () => $('#dlgAdd').close();
$('#formAdd').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#addUrls').value;
  const urls = [...new Set(text.match(/(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi) || [])];
  if (!urls.length) return toast('Paste at least one http(s) or magnet link');
  const ua = UA_PRESETS.value === '__custom' ? $('#addUACustom').value : UA_PRESETS.value;
  $('#dlgAdd').close();
  const res = await window.f2l.add({
    urls, fileName: $('#addName').value, connections: +$('#addConn').value, folder: $('#addFolder').value,
    autoStart: $('#addStart').checked, userAgent: ua, referer: $('#addRef').value, customHeaders: $('#addHdr').value
  });
  const added = res.filter(r => r.added).length, skipped = res.length - added;
  toast(added ? `Added ${added} download${added > 1 ? 's' : ''}${skipped ? ` (${skipped} skipped: duplicate/exists)` : ''}` : 'Nothing added — duplicate, already downloaded or invalid link');
});

// Ctrl+V anywhere (outside inputs) → open Add with clipboard links
document.addEventListener('keydown', async e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
    const u = await window.f2l.clipboard(); if (u.length) openAdd(u.join('\n'));
  }
});
// Drag & drop links or text files
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (t) return openAdd(t);
  const f = e.dataTransfer.files[0];
  if (f && f.size < 5e6) openAdd(await f.text());
});

// ----- settings -----
function applyTheme() { document.body.dataset.theme = settings.theme === 'light' ? 'light' : 'dark'; }
function fillSettings() {
  $('#folderPath').textContent = settings.folder;
  $('#setConn').value = settings.connections; $('#setConnV').textContent = settings.connections;
  $('#setMax').value = settings.maxConcurrent; $('#setRetry').value = settings.retryAttempts;
  $('#setAuto').checked = settings.autoResume; $('#setNotif').checked = settings.notifications;
  $('#setTheme').checked = settings.theme === 'light'; $('#setUpd').checked = settings.autoUpdateCheck;
  applyTheme();
}
async function save(patch) { settings = await window.f2l.setSettings(patch); fillSettings(); }
$('#btnFolder').onclick = async () => { const f = await window.f2l.pickFolder(); if (f) save({ folder: f }); };
$('#btnOpenFolder').onclick = () => window.f2l.openFolder();
$('#setConn').oninput = e => { $('#setConnV').textContent = e.target.value; };
$('#setConn').onchange = e => save({ connections: +e.target.value });
$('#setMax').onchange = e => save({ maxConcurrent: +e.target.value });
$('#setRetry').onchange = e => save({ retryAttempts: +e.target.value });
$('#setAuto').onchange = e => save({ autoResume: e.target.checked });
$('#setNotif').onchange = e => save({ notifications: e.target.checked });
$('#setTheme').onchange = e => save({ theme: e.target.checked ? 'light' : 'dark' });
$('#setUpd').onchange = e => save({ autoUpdateCheck: e.target.checked });
async function doUpdate(manual) {
  if (manual) $('#updMsg').textContent = 'Checking…';
  const r = await window.f2l.checkUpdate();
  if (r.state === 'available') {
    $('#updMsg').textContent = `Version ${r.version} available`;
    toast(`Update ${r.version} available — opening download page`);
    if (manual) window.f2l.openExternal(r.url);
  } else if (r.state === 'uptodate') { if (manual) $('#updMsg').textContent = 'You are on the latest version.'; }
  else if (manual) $('#updMsg').textContent = r.message;
}
$('#btnUpdate').onclick = () => doUpdate(true);

(async function init() {
  const s = await window.f2l.state();
  items = s.items; settings = s.settings; $('#ver').textContent = 'v' + s.version;
  fillSettings(); renderList();
  window.f2l.onItems(list => { items = list; renderList(); });
  if (settings.autoUpdateCheck) setTimeout(() => doUpdate(false), 4000);
})();
