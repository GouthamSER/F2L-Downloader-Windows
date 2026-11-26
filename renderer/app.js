'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let items = [], settings = {}, tab = 'all', detailId = null, delId = null, query = '', sortMode = 'newest';
const seen = new Set(), lastStatus = new Map();

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

const ytQLabel = q => { const m = String(q || '').match(/^mp3(?:-(\d+))?$/); return m ? `MP3${m[1] ? ' ' + m[1] + ' kbps' : ''}` : q === 'm4a' ? 'M4A audio' : /^\d+$/.test(q || '') ? q + 'p' : 'Best'; };
const fmtDur = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

function sparkSvg(hist, w = 110, h = 34, col = '#14C8D8') {
  if (!hist || hist.length < 2) return '';
  const max = Math.max(...hist, 1), step = w / (hist.length - 1);
  const pts = hist.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (Math.max(v, 0) / max) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" points="${pts.join(' ')}"/></svg>`;
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

const SORTS = {
  newest: (a, b) => (b.addedAt || 0) - (a.addedAt || 0), oldest: (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
  name: (a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base', numeric: true }), size: (a, b) => (b.totalBytes || 0) - (a.totalBytes || 0)
};
const searchOk = i => !query || (i.fileName + ' ' + (i.url || '') + ' ' + (i.ytChannel || '')).toLowerCase().includes(query);
const cardHtml = i => {
    const p = pct(i);
    const ind = (i.status === 'DOWNLOADING' && i.totalBytes <= 0) || i.speed === -1;
    const meta = [];
    if (i.status === 'DOWNLOADING') {
      meta.push(`<span>${fmtSpeed(i.speed)}</span>`);
      if (i.speed >= 0) meta.push(`<span>ETA ${fmtEta(i.eta)}</span>`);
    }
    meta.push(`<span>${fmtBytes(i.downloadedBytes)}${i.totalBytes > 0 ? ' / ' + fmtBytes(i.totalBytes) : ''}</span>`);
    if (i.totalBytes > 0 && i.status !== 'COMPLETED') meta.push(`<span>${p.toFixed(1)}%</span>`);
    if (i.yt) meta.push(`<span>${esc(ytQLabel(i.ytQuality))}</span>${i.ytChannel ? `<span>${esc(i.ytChannel)}</span>` : ''}`);
    const isNew = !seen.has(i.id); seen.add(i.id);
    return `<div class="card ${i.status}${i.yt ? ' yt' : ''}${isNew ? ' new' : ''}" data-id="${i.id}">
      <div style="min-width:0"><div class="name"><span class="badge ${i.status}">${STATUS[i.status] || i.status}</span>${i.yt ? '<span class="badge yt">YouTube</span>' : ''}${i.isTorrent ? `<span class="badge mag">${i.qbit ? 'qBittorrent' : 'magnet'}</span>` : ''}<span style="overflow:hidden;text-overflow:ellipsis">${esc(i.fileName)}</span></div>
      <div class="meta">${meta.join('')}</div></div>
      <div class="acts">${i.status === 'DOWNLOADING' ? sparkSvg(i.speedHistory.slice(-30)) : ''}${actionsFor(i)}</div>
      <div class="prog ${ind ? 'ind' : ''}"><div style="width:${p}%"></div></div>
      ${i.error ? `<div class="err">${esc(i.error)}</div>` : ''}
    </div>`;
};
function renderList() {
  const shown = items.filter(i => matches(i) && searchOk(i)).sort(SORTS[sortMode] || SORTS.newest);
  const list = $('#list');
  list.innerHTML = shown.map(cardHtml).join('');
  $('#empty').hidden = shown.length > 0 || tab === 'youtube';
  list.hidden = shown.length === 0;
  $('#btnRetryAll').hidden = !items.some(i => i.status === 'FAILED');
  if (!$('#viewYoutube').hidden) renderYtMine();

  const c = t => items.filter(i => t === 'all' || (t === 'active' ? ['DOWNLOADING', 'QUEUED', 'PAUSED'].includes(i.status) : t === 'completed' ? i.status === 'COMPLETED' : i.status === 'FAILED')).length;
  for (const t of ['all', 'active', 'completed', 'failed']) $('#c-' + t).textContent = c(t);
  // live summary bar
  const act = items.filter(x => x.status === 'DOWNLOADING');
  const live = $('#live');
  if (act.length) {
    const sp = act.reduce((a, x) => a + (x.speed > 0 ? x.speed : 0), 0);
    if (live.hidden || !live.firstChild) live.innerHTML = '<i class="dot"></i><b id="liveN"></b><span id="liveS"></span>';
    $('#liveN').textContent = act.length + ' downloading'; $('#liveS').textContent = fmtBytes(sp) + '/s'; live.hidden = false;
  } else live.hidden = true;
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
  if (d.length < 2) { g.fillStyle = '#8FBFC4'; g.font = '12px Arial, sans-serif'; g.fillText('Waiting for data…', 12, 22); return; }
  const max = Math.max(...d, 1) * 1.15, step = w / (d.length - 1);
  const y = v => h - 6 - (v / max) * (h - 14);
  g.beginPath(); d.forEach((v, k) => k ? g.lineTo(k * step, y(v)) : g.moveTo(0, y(v)));
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(20,200,216,.45)'); grad.addColorStop(1, 'rgba(20,200,216,0)');
  g.fillStyle = grad; g.fill();
  g.beginPath(); d.forEach((v, k) => k ? g.lineTo(k * step, y(v)) : g.moveTo(0, y(v)));
  g.strokeStyle = '#14C8D8'; g.lineWidth = 2.5; g.shadowColor = '#14C8D8'; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
  g.fillStyle = '#8FBFC4'; g.font = '11px Arial, sans-serif'; g.fillText('peak ' + fmtSpeed(Math.max(...d)), 8, 14);
}

function renderDetail() {
  const i = items.find(x => x.id === detailId);
  if (!i) { $('#dlgDetail').close(); detailId = null; return; }
  const segs = '';
  const root = $('#detail');
  const keep = root.querySelector('canvas');
  root.innerHTML = `<div class="dh"><div style="min-width:0"><h2>${esc(i.fileName)}</h2><span class="badge ${i.status}">${STATUS[i.status]}</span> ${i.yt ? '<span class="badge yt">YouTube</span>' : ''} ${i.isTorrent ? `<span class="badge mag">${i.qbit ? 'qBittorrent' : 'magnet'}</span>` : ''}</div>
    <div class="acts">${actionsFor(i)}<button class="ic" data-act="close" title="Close" aria-label="Close">✕</button></div></div>
    <div class="prog ${i.speed === -1 ? 'ind' : ''}" style="margin-top:12px"><div style="width:${pct(i)}%"></div></div>
    <canvas class="chart" id="chart"></canvas>
    ${segs ? `<div class="segs" title="Per-connection progress">${segs}</div>` : ''}
    <dl class="kv">
      <dt>Speed</dt><dd>${i.status === 'DOWNLOADING' ? fmtSpeed(i.speed) : '—'}</dd>
      <dt>Progress</dt><dd>${fmtBytes(i.downloadedBytes)} / ${fmtBytes(i.totalBytes)} (${pct(i).toFixed(1)}%)</dd>
      <dt>ETA</dt><dd>${i.status === 'DOWNLOADING' ? fmtEta(i.eta) : '—'}</dd>
      <dt>${i.yt ? 'Quality' : i.bt ? 'Peers' : 'Connections'}</dt><dd>${i.yt ? esc(ytQLabel(i.ytQuality)) : i.bt ? i.connections : i.isTorrent ? '—' : 'Single connection'}</dd>
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
  const st = tab === 'settings', ytab = tab === 'youtube';
  $('#viewList').hidden = st || ytab; $('#viewSettings').hidden = !st; $('#viewYoutube').hidden = !ytab;
  $('#title').textContent = { all: 'All downloads', active: 'Active', completed: 'Completed', failed: 'Failed' }[tab] || '';
  if (!st) renderList();
  if (ytab) $('#ytUrl').focus();
});
$('#btnPauseAll').onclick = () => window.f2l.pauseAll();
$('#btnResumeAll').onclick = () => window.f2l.resumeAll();
$('#btnClear').onclick = () => window.f2l.clearCompleted();
$('#btnRetryAll').onclick = () => window.f2l.retryFailed();
$('#search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });
$('#sort').addEventListener('change', e => { sortMode = e.target.value; try { localStorage.setItem('f2l_sort', sortMode); } catch { /* ignore */ } renderList(); });
function gotoTab(t) { const b = document.querySelector(`#nav button[data-tab="${t}"]`); if (b) b.click(); }

// ----- add dialog -----
const UA_PRESETS = $('#addUA');
const urlCount = () => { const n = window.extractCount($('#addUrls').value); $('#addCount').textContent = n ? `${n} link${n > 1 ? 's' : ''} found` : ''; $('#addName').disabled = n > 1; ytRoute(); };
window.extractCount = t => new Set((t.match(/(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi) || [])).size;
async function openAdd(prefill) {
  const pl = linksIn(prefill || '');
  if (pl.length === 1 && YT_RE.test(pl[0])) return openYoutube(pl[0]);
  $('#addUrls').value = prefill || '';
  $('#addName').value = ''; $('#addRef').value = ''; $('#addHdr').value = ''; UA_PRESETS.value = ''; $('#addUACustom').hidden = true;
  $('#addFolder').value = settings.folder; $('#addStart').checked = true;
  urlCount(); $('#dlgAdd').showModal(); $('#addUrls').focus();
}
$('#btnAdd').onclick = async () => openAdd((await window.f2l.clipboard()).join('\n'));
$('#addUrls').addEventListener('input', urlCount);
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
$('#btnAddFolder').onclick = async () => {
  const r = await window.f2l.pickFolder();
  if (r && r.error) return toast(r.error);
  if (r && r.path) $('#addFolder').value = r.path;
};
$('#btnTorrent').onclick = async () => {
  const res = await window.f2l.pickTorrents({ folder: $('#addFolder').value, autoStart: $('#addStart').checked });
  if (!res.length) return;
  $('#dlgAdd').close(); torrentToast(res);
};
function torrentToast(res) {
  const ok = res.filter(r => r.added).length, bad = res.find(r => r.error);
  if (bad && !ok) return toast(bad.error);
  toast(ok ? `Added ${ok} torrent${ok > 1 ? 's' : ''}${res.length > ok ? ` (${res.length - ok} skipped)` : ''}` : 'Torrent already in list');
}
$('#btnAddCancel').onclick = () => $('#dlgAdd').close();
$('#formAdd').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#addUrls').value;
  const urls = [...new Set(text.match(/(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi) || [])];
  if (!urls.length) return toast('Paste at least one http(s) or magnet link');
  const ua = UA_PRESETS.value === '__custom' ? $('#addUACustom').value : UA_PRESETS.value;
  $('#dlgAdd').close();
  const res = await window.f2l.add({
    urls, fileName: $('#addName').value, folder: $('#addFolder').value,
    autoStart: $('#addStart').checked, userAgent: ua, referer: $('#addRef').value, customHeaders: $('#addHdr').value
  });
  if (res[0] && res[0].skipped === 'folder') return toast(res[0].error);
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
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropzone'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropzone'); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  document.body.classList.remove('dropzone');
  const files = [...(e.dataTransfer.files || [])];
  const tor = files.filter(f => /\.torrent$/i.test(f.name) && f.size < 20e6);
  if (tor.length) {
    const payload = await Promise.all(tor.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    return torrentToast(await window.f2l.addTorrents(payload, {}));
  }
  const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (t) return openAdd(t);
  const f = files[0];
  if (f && f.size < 5e6) openAdd(await f.text());
});

// ----- settings -----
function applyTheme() { document.body.dataset.theme = settings.theme === 'light' ? 'light' : 'dark'; }
function fillSettings() {
  $('#folderPath').textContent = settings.folder;
  $('#setLimit').value = String(settings.speedLimitKBps || 0);
  $('#setMax').value = settings.maxConcurrent; $('#setRetry').value = settings.retryAttempts;
  $('#setAuto').checked = settings.autoResume; $('#setNotif').checked = settings.notifications;
  $('#setBt').checked = settings.btEnabled !== false; $('#setQb').checked = !!settings.qbitEnabled; $('#qbBox').hidden = !settings.qbitEnabled;
  for (const [id, k] of [['#setQbUrl', 'qbitUrl'], ['#setQbUser', 'qbitUser'], ['#setQbPass', 'qbitPass']]) if (document.activeElement !== $(id)) $(id).value = settings[k] || '';
  $('#setYtQ').value = settings.ytQuality || '1080'; $('#setTheme').checked = settings.theme === 'light'; $('#setUpd').checked = settings.autoUpdateCheck;
  applyTheme();
}
async function save(patch) { settings = await window.f2l.setSettings(patch); fillSettings(); }
$('#btnFolder').onclick = async () => {
  const r = await window.f2l.pickFolder();
  if (r && r.error) return toast(r.error);
  if (r && r.path) save({ folder: r.path });
};
$('#btnOpenFolder').onclick = () => window.f2l.openFolder();
$('#setLimit').onchange = e => save({ speedLimitKBps: +e.target.value });
$('#setMax').onchange = e => save({ maxConcurrent: +e.target.value });
$('#setRetry').onchange = e => save({ retryAttempts: +e.target.value });
$('#setBt').onchange = e => save({ btEnabled: e.target.checked });
$('#setQb').onchange = e => save({ qbitEnabled: e.target.checked });
$('#setQbUrl').onchange = e => save({ qbitUrl: e.target.value });
$('#setQbUser').onchange = e => save({ qbitUser: e.target.value });
$('#setQbPass').onchange = e => save({ qbitPass: e.target.value });
$('#btnQbTest').onclick = async () => {
  $('#qbMsg').textContent = 'Testing…';
  const r = await window.f2l.qbitTest({ qbitUrl: $('#setQbUrl').value, qbitUser: $('#setQbUser').value, qbitPass: $('#setQbPass').value });
  $('#qbMsg').textContent = r.ok ? `Connected — qBittorrent ${r.version}` : r.error;
};
$('#setYtQ').onchange = e => save({ ytQuality: e.target.value });
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

// ----- YouTube tab (same flow as the Android app: video / audio picker, playlists, "My YouTube") -----
const YT_RE = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;
const yt = { url: null, info: null, mode: 'video', sel: 0, timer: null, pl: null, picked: new Set(), plQ: 'best' };
const PL_QUALITIES = [['best', 'Best'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['mp3-320', 'MP3 320'], ['mp3-128', 'MP3 128'], ['m4a', 'M4A']];
const linksIn = t => [...new Set(String(t).match(/(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi) || [])];
const ytSize = b => b > 0 ? '~' + (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : Math.round(b / 1048576) + ' MB') : '';
const listParam = u => { try { return new URL(u).searchParams.get('list') || ''; } catch { return ''; } };
const isPure = u => { try { const x = new URL(u); return !!listParam(u) && (!x.searchParams.get('v') || /^\/playlist/.test(x.pathname)); } catch { return false; } };

function ytShow(part) {
  $('#ytLoading').hidden = part !== 'loading'; $('#ytErr').hidden = part !== 'err';
  $('#ytBody').hidden = part !== 'video'; $('#plBody').hidden = part !== 'playlist';
}
// Add dialog / Ctrl+V / drag: a single YouTube link jumps to the YouTube tab, prefilled
function ytRoute() {
  const l = linksIn($('#addUrls').value);
  if (l.length === 1 && YT_RE.test(l[0]) && $('#dlgAdd').open) { $('#dlgAdd').close(); openYoutube(l[0]); }
}
function openYoutube(url) { gotoTab('youtube'); $('#ytUrl').value = url || ''; ytChanged(); }

function ytChanged() {
  const u = $('#ytUrl').value.trim();
  $('#ytClear').hidden = !u;
  clearTimeout(yt.timer);
  const ok = YT_RE.test(u);
  const hasList = ok && !!listParam(u);
  $('#ytPlWrap').hidden = !hasList;
  if (hasList && u !== yt.url && !yt.keepToggle) $('#ytPlToggle').checked = isPure(u);
  yt.url = ok ? u : null;
  if (!ok) { ytShow('none'); return; }
  ytShow('loading'); $('#ytLoading').textContent = 'Reading…';
  yt.timer = setTimeout(ytLoad, 350);
}
async function ytLoad() {
  const url = yt.url; if (!url) return;
  const wantPl = !$('#ytPlWrap').hidden && $('#ytPlToggle').checked;
  $('#ytLoading').textContent = wantPl ? 'Reading playlist… first time can take a few seconds' : 'Reading video… first time can take a few seconds';
  ytShow('loading');
  if (wantPl) {
    const r = await window.f2l.ytPlaylist(url);
    if (yt.url !== url) return;
    if (!r.ok) { $('#ytErrTxt').textContent = r.error; return ytShow('err'); }
    yt.pl = r.playlist; yt.picked = new Set(r.playlist.entries.map(e => e.id));
    $('#plName').textContent = r.playlist.title;
    plRender(); return ytShow('playlist');
  }
  const r = await window.f2l.ytInfo(url);
  if (yt.url !== url) return;
  if (!r.ok) { $('#ytErrTxt').textContent = r.error; return ytShow('err'); }
  yt.info = r.info; yt.mode = 'video'; yt.sel = 0;
  $('#ytThumb').src = r.info.thumbData || ''; $('#ytThumb').style.visibility = r.info.thumbData ? 'visible' : 'hidden';
  $('#ytName').textContent = r.info.title;
  $('#ytSub').textContent = [r.info.channel, r.info.duration ? fmtDur(r.info.duration) : ''].filter(Boolean).join(' • ');
  ytList(); ytShow('video');
}
const ytOpts = () => yt.info ? yt.info.options.filter(o => o.kind === yt.mode) : [];
function ytList() {
  document.querySelectorAll('#ytBody .ytp-tabs .chip').forEach(c => c.classList.toggle('on', c.dataset.m === yt.mode));
  $('#ytList').innerHTML = ytOpts().map((o, i) => `<label class="ytp-row"><input type="radio" name="ytq" value="${i}" ${i === yt.sel ? 'checked' : ''}><span>${esc(o.label)}</span><small>${ytSize(o.bytes)}</small></label>`).join('');
  $('#ytGo').textContent = yt.mode === 'audio' ? 'Download audio' : 'Download video';
}
function plRender() {
  const pl = yt.pl; if (!pl) return;
  $('#plSub').textContent = `${pl.entries.length}${pl.capped ? '+' : ''} videos${pl.channel ? ' • ' + pl.channel : ''}${pl.capped ? ' (first 200 shown)' : ''}`;
  $('#plQ').innerHTML = PL_QUALITIES.map(([id, l]) => `<button type="button" class="chip${id === yt.plQ ? ' on' : ''}" data-q="${id}">${l}</button>`).join('');
  $('#plList').innerHTML = pl.entries.map(e => `<label class="ytp-row"><input type="checkbox" data-id="${esc(e.id)}" ${yt.picked.has(e.id) ? 'checked' : ''}><span>${esc(e.title)}</span><small>${e.duration ? fmtDur(e.duration) : ''}</small></label>`).join('');
  const n = yt.picked.size; $('#plGo').textContent = n ? `Download ${n} video${n > 1 ? 's' : ''}` : 'Pick videos'; $('#plGo').disabled = !n;
}
const doneToast = r => toast(r.added ? 'YouTube download added' : r.skipped === 'duplicate' ? 'Already downloading this video' : r.skipped === 'exists' ? 'You already downloaded this video' : r.skipped === 'resumed' ? 'Resumed earlier download' : 'Could not add this video');

$('#ytUrl').addEventListener('input', () => { yt.keepToggle = false; ytChanged(); });
$('#ytPlToggle').addEventListener('change', () => { yt.keepToggle = true; if (yt.url) { ytShow('loading'); ytLoad(); } });
$('#ytPaste').onclick = async () => {
  const u = (await window.f2l.clipboard()).find(x => YT_RE.test(x));
  if (!u) return toast('No YouTube link on the clipboard');
  $('#ytUrl').value = u; yt.keepToggle = false; ytChanged();
};
$('#ytClear').onclick = () => { $('#ytUrl').value = ''; yt.keepToggle = false; ytChanged(); $('#ytUrl').focus(); };
$('#ytBody .ytp-tabs').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; yt.mode = c.dataset.m; yt.sel = 0; ytList(); });
$('#ytList').addEventListener('change', e => { yt.sel = +e.target.value; });
$('#ytRetry').onclick = () => { ytShow('loading'); ytLoad(); };
$('#plQ').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; yt.plQ = c.dataset.q; plRender(); });
$('#plList').addEventListener('change', e => { const id = e.target.dataset.id; if (!id) return; e.target.checked ? yt.picked.add(id) : yt.picked.delete(id); const n = yt.picked.size; $('#plGo').textContent = n ? `Download ${n} video${n > 1 ? 's' : ''}` : 'Pick videos'; $('#plGo').disabled = !n; });
$('#plAll').onclick = () => { yt.picked = new Set(yt.pl.entries.map(e => e.id)); plRender(); };
$('#plNone').onclick = () => { yt.picked.clear(); plRender(); };
$('#ytGo').onclick = async () => {
  const o = ytOpts()[yt.sel]; if (!yt.info || !o) return;
  $('#ytGo').disabled = true;
  const r = await window.f2l.ytAdd({ url: yt.info.url, title: yt.info.title, channel: yt.info.channel, quality: o.id, expected: o.bytes, folder: settings.folder, autoStart: true });
  $('#ytGo').disabled = false;
  if (r.skipped === 'folder') return toast(r.error);
  doneToast(r);
};
$('#plGo').onclick = async () => {
  const entries = yt.pl.entries.filter(e => yt.picked.has(e.id)); if (!entries.length) return;
  $('#plGo').disabled = true;
  const r = await window.f2l.ytAddMany({ entries, quality: yt.plQ, channel: yt.pl.channel, folder: settings.folder, autoStart: true });
  $('#plGo').disabled = false;
  if (r.skipped === 'folder') return toast(r.error);
  toast(`Queued ${r.added} video${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped)` : ''} — ${settings.maxConcurrent} at a time`);
};
function renderYtMine() {
  const mine = items.filter(i => i.yt).sort(SORTS.newest);
  $('#ytMine').innerHTML = mine.map(cardHtml).join('');
  $('#ytMineEmpty').hidden = mine.length > 0;
}
window.f2l.onYtSetup(p => { if (!$('#ytLoading').hidden) $('#ytLoading').textContent = `Setting up the YouTube engine (first time only)… ${p}%`; });

(async function init() {
  const s = await window.f2l.state();
  items = s.items; settings = s.settings; $('#ver').textContent = 'v' + s.version;
  try { const sm = localStorage.getItem('f2l_sort'); if (SORTS[sm]) { sortMode = sm; $('#sort').value = sm; } } catch { /* ignore */ }
  fillSettings(); renderList();
  items.forEach(x => { seen.add(x.id); lastStatus.set(x.id, x.status); });
  window.f2l.onItems(list => {
    items = list;
    // feedback when something finishes / fails
    for (const x of list) {
      const prev = lastStatus.get(x.id);
      if (prev === 'DOWNLOADING' && x.status !== prev) {
        if (x.status === 'COMPLETED') toast('✓ Done: ' + x.fileName);
        else if (x.status === 'FAILED') toast('✗ Failed: ' + x.fileName);
      }
      lastStatus.set(x.id, x.status);
    }
    renderList();
  });
  if (settings.autoUpdateCheck) setTimeout(() => doUpdate(false), 4000);
})();
