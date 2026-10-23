'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const engine = require('./engine');
const qbit = require('./qbit');
const bt = require('./torrent');

const VERSION = require('./package.json').version;
const REPO = 'GouthamSER/F2L-Downloader-Windows';

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let items = [];
let settings = {};
const runners = new Map(); // id -> { ac, done }
const qb = qbit.createClient(() => settings);

const DEFAULT_SETTINGS = () => ({
  folder: app.getPath('downloads'),
  connections: 8,
  retryAttempts: 3,
  maxConcurrent: 3,
  autoResume: true,
  notifications: true,
  theme: 'dark',
  autoUpdateCheck: true,
  btEnabled: true,
  qbitEnabled: false,
  qbitUrl: 'http://127.0.0.1:8080',
  qbitUser: 'admin',
  qbitPass: ''
});

// ---------- persistence ----------
let saveTimer = null;
const file = n => path.join(app.getPath('userData'), n);
function readJson(n, fallback) { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return fallback; } }
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
}
function saveNow() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(file('downloads.json.tmp'), JSON.stringify(items));
    fs.renameSync(file('downloads.json.tmp'), file('downloads.json'));
    fs.writeFileSync(file('settings.json'), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('save failed', e); }
}

// ---------- UI sync ----------
let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('items', items);
      const active = items.filter(i => i.status === 'DOWNLOADING' && i.totalBytes > 0);
      const tot = active.reduce((a, i) => a + i.totalBytes, 0), got = active.reduce((a, i) => a + i.downloadedBytes, 0);
      win.setProgressBar(active.length && tot > 0 ? Math.min(1, got / tot) : -1);
    }
  }, 250);
  saveSoon();
}
const find = id => items.find(i => i.id === id);
function notify(title, body) {
  if (!settings.notifications || !Notification.isSupported()) return;
  try { new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') }).show(); } catch { /* ignore */ }
}

// ---------- queue ----------
function pump() {
  const running = items.filter(i => i.status === 'DOWNLOADING' && !i.qbit && !i.bt).length;
  let slots = Math.max(1, settings.maxConcurrent) - running;
  for (const it of [...items].reverse()) { // oldest first
    if (slots <= 0) break;
    if (it.status === 'QUEUED' && !runners.has(it.id)) { run(it); slots--; }
  }
  push();
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});

function run(item) {
  const ac = new AbortController();
  item.status = 'DOWNLOADING'; item.error = null;
  const runner = { ac };
  runner.done = (async () => {
    let attempt = 0, best = item.downloadedBytes || 0;
    const maxRetry = Math.min(Math.max(settings.retryAttempts | 0, 0), 10);
    const onProgress = p => {
      if (p.speed < 0) { Object.assign(item, { downloadedBytes: p.downloaded, speed: -1, eta: -1 }); push(); return; }
      item.downloadedBytes = p.downloaded;
      if (p.total > 0) item.totalBytes = p.total;
      item.speed = p.speed;
      item.speedHistory = [...(item.speedHistory || []), p.speed].slice(-60);
      item.eta = item.totalBytes > p.downloaded && p.speed > 0 ? Math.round((item.totalBytes - p.downloaded) / p.speed) : -1;
      if (p.downloaded > best + 2_000_000) { best = p.downloaded; attempt = 0; } // real progress gives retry budget back
      push();
    };
    try {
      while (true) {
        try {
          await engine.download(item, { signal: ac.signal, onProgress });
          item.status = 'COMPLETED'; item.speed = 0; item.eta = -1; item.error = null; item.completedAt = Date.now();
          if (item.totalBytes > 0) item.downloadedBytes = item.totalBytes;
          else item.totalBytes = item.downloadedBytes;
          notify('Download complete', item.fileName);
          return;
        } catch (e) {
          if (ac.signal.aborted) return; // paused / removed: state set by caller
          if (attempt < maxRetry && engine.isRetryable(e)) {
            attempt++;
            item.error = `Connection problem — retrying (${attempt}/${maxRetry})…`; item.speed = 0; push();
            await sleep(2000 * attempt, ac.signal);
            item.error = null;
            continue;
          }
          item.status = 'FAILED'; item.speed = 0; item.eta = -1; item.error = engine.friendly(e);
          notify('Download failed', `${item.fileName}\n${item.error}`);
          return;
        }
      }
    } catch (e) { /* aborted during backoff */ }
    finally { runners.delete(item.id); pump(); }
  })();
  runners.set(item.id, runner);
  push();
}

async function stop(id) {
  const r = runners.get(id);
  if (r) { r.ac.abort(); await r.done.catch(() => {}); }
}

async function uniqueName(folder, base, url, ignoreId) {
  const taken = n => items.some(i => i.id !== ignoreId && i.folder === folder && i.fileName.toLowerCase() === n.toLowerCase() && i.url.toLowerCase() !== url.toLowerCase());
  const exists = async n => fsp.stat(path.join(folder, n)).then(() => true, () => false);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
  let n = base, c = 0;
  while (taken(n) || await exists(n)) { c++; n = `${stem} (${c})${ext}`; }
  return n;
}


// ---------- qBittorrent ----------
const qbitErr = e => (e && e.qbit) ? e.message : engine.friendly(e);

// engine for magnets / .torrent files: qBittorrent Web UI > built-in (WebTorrent) > legacy shortcut
const torrentMode = () => settings.qbitEnabled ? 'qbit' : (settings.btEnabled !== false ? 'bt' : null);
const tdir = () => path.join(app.getPath('userData'), 'torrents');
const tfile = hash => path.join(tdir(), String(hash).toLowerCase() + '.torrent');
async function saveTorrentFile(hash, data) { try { await fsp.mkdir(tdir(), { recursive: true }); await fsp.writeFile(tfile(hash), data); } catch { /* best effort */ } }
const loadTorrentFile = hash => fsp.readFile(tfile(hash)).catch(() => null);
const btTorrents = new Map(); // item id -> WebTorrent torrent

function btFail(item, e) {
  item.status = 'FAILED'; item.speed = 0; item.eta = -1; item.error = engine.friendly(e);
  btTorrents.delete(item.id); bt.stop(item.magnetHash, false).catch(() => {});
  notify('Download failed', `${item.fileName}\n${item.error}`); push();
}

// (re)add an item to its engine
async function torrentSend(item) {
  try {
    const data = item.isFile ? await loadTorrentFile(item.magnetHash) : null;
    const source = data || (engine.isMagnet(item.url) ? item.url : `magnet:?xt=urn:btih:${item.magnetHash}`);
    if (item.qbit) {
      if (data) await qb.addTorrentFile(item.fileName + '.torrent', data, item.folder); else await qb.addMagnet(source, item.folder);
      item.qbitAdded = true; item.qbitAddedAt = Date.now();
    } else {
      btTorrents.set(item.id, await bt.start(source, item.magnetHash, item.folder, e => btFail(item, e)));
    }
    item.error = null; item.status = 'DOWNLOADING'; item.speed = -1;
  } catch (e) {
    item.status = 'FAILED'; item.speed = 0; item.eta = -1; item.error = qbitErr(e);
    notify('Torrent error', item.error);
  }
  push();
}

function torrentItem(mode, id, url, folder, fileName, hash, size, o, isFile) {
  return {
    id, url, folder, fileName,
    totalBytes: size > 0 ? size : -1, downloadedBytes: 0,
    status: o.autoStart === false ? 'PAUSED' : 'DOWNLOADING',
    speed: o.autoStart === false ? 0 : -1, eta: -1, error: null,
    connections: 0, userAgent: null, referer: null, customHeaders: null,
    isTorrent: true, qbit: mode === 'qbit', bt: mode === 'bt', isFile: !!isFile, qbitAdded: false, magnetHash: hash,
    speedHistory: [], addedAt: Date.now(), segs: null
  };
}

function dupCheck(url) {
  const ex = items.find(i => i.url.toLowerCase() === url.toLowerCase());
  if (!ex) return null;
  if (ex.status === 'DOWNLOADING' || ex.status === 'QUEUED') return { skipped: 'duplicate' };
  if (ex.status === 'PAUSED' || ex.status === 'FAILED') { startItem(ex.id); return { skipped: 'resumed' }; }
  return null;
}

async function addMagnetTorrent(clean, o, folder, mode) {
  const info = engine.parseMagnetUri(clean);
  if (!info) return { skipped: 'invalid' };
  if (!o.force) { const d = dupCheck(clean); if (d) return d; }
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const name = engine.sanitizeName(info.displayName || `magnet-${info.infoHash.slice(0, 8)}`);
  const item = torrentItem(mode, id, clean, folder, name, info.infoHash, -1, o, false);
  items.unshift(item); push();
  if (o.autoStart !== false) await torrentSend(item);
  return { added: id };
}

// data: Buffer of a .torrent file
async function addTorrentData(fileName, data, o = {}) {
  let meta;
  try { meta = qbit.parseTorrent(data); } catch (e) { return { skipped: 'invalid', error: `${fileName}: ${e.message}` }; }
  const folder = o.folder || settings.folder;
  const url = 'torrent://' + meta.infoHash.toLowerCase();
  if (!o.force) { const d = dupCheck(url); if (d) return d; }
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const mode = torrentMode();
  const item = torrentItem(mode, id, url, folder, engine.sanitizeName(meta.name), meta.infoHash, meta.size, o, true);
  if (!mode) {
    // no engine enabled: save the .torrent and hand it to the default torrent app
    const bad = await checkWritable(folder);
    if (bad) return { skipped: 'folder', error: bad };
    const tname = await uniqueName(folder, engine.sanitizeName(/\.torrent$/i.test(fileName) ? fileName : fileName + '.torrent'), url, id);
    const tpath = path.join(folder, tname);
    await fsp.writeFile(tpath, data);
    const err = await shell.openPath(tpath);
    Object.assign(item, { fileName: tname, status: err ? 'FAILED' : 'COMPLETED', totalBytes: data.length, downloadedBytes: data.length, speed: 0, completedAt: Date.now(),
      error: err ? `No app opened the .torrent (${err}). Enable the built-in engine or qBittorrent in Settings.` : null });
    items.unshift(item); push();
    return { added: id };
  }
  if (mode === 'bt') { const bad = await checkWritable(folder); if (bad) return { skipped: 'folder', error: bad }; }
  await saveTorrentFile(meta.infoHash, data);
  items.unshift(item); push();
  if (o.autoStart !== false) await torrentSend(item);
  return { added: id };
}

function pollBt() {
  let changed = false;
  for (const it of items) {
    if (!it.bt || it.status !== 'DOWNLOADING') continue;
    const t = btTorrents.get(it.id); if (!t) continue;
    const s = bt.snapshot(t); changed = true;
    if (s.ready) { if (s.name) it.fileName = s.name; if (s.length > 0) it.totalBytes = s.length; }
    it.downloadedBytes = s.downloaded; it.speed = s.ready ? s.speed : -1; it.eta = s.ready ? s.eta : -1; it.connections = s.peers;
    if (it.speed >= 0) it.speedHistory = [...(it.speedHistory || []), it.speed].slice(-60);
    if (s.done) {
      it.status = 'COMPLETED'; it.speed = 0; it.eta = -1; it.completedAt = Date.now(); it.downloadedBytes = it.totalBytes > 0 ? it.totalBytes : it.downloadedBytes; it.error = null;
      btTorrents.delete(it.id); bt.stop(it.magnetHash, false).catch(() => {}); // stop seeding, keep files
      notify('Download complete', it.fileName);
    }
  }
  if (changed) push();
}

let qbitPolling = false;
async function pollQbit() {
  if (qbitPolling || !settings.qbitEnabled) return;
  const watch = items.filter(i => i.qbit && i.qbitAdded && i.status !== 'COMPLETED');
  if (!watch.length) return;
  qbitPolling = true;
  try {
    const list = await qb.info(watch.map(i => i.magnetHash));
    const by = new Map(list.map(t => [String(t.hash).toLowerCase(), t]));
    for (const it of watch) {
      const t = by.get(String(it.magnetHash).toLowerCase());
      if (!t) {
        if (Date.now() - (it.qbitAddedAt || 0) > 15000 && it.status !== 'PAUSED') { it.status = 'FAILED'; it.speed = 0; it.eta = -1; it.error = 'Torrent is no longer in qBittorrent (removed there?). Click Retry to add again.'; it.qbitAdded = false; }
        continue;
      }
      const prev = it.status;
      it.status = qbit.mapState(t.state);
      it.error = it.status === 'FAILED' ? `qBittorrent: ${t.state}` : null;
      const size = t.size > 0 ? t.size : (t.total_size || -1);
      if (size > 0) it.totalBytes = size;
      it.downloadedBytes = typeof t.downloaded === 'number' && t.downloaded > 0 ? t.downloaded : Math.round((t.progress || 0) * (it.totalBytes > 0 ? it.totalBytes : 0));
      it.speed = it.status === 'DOWNLOADING' ? (t.state === 'metaDL' ? -1 : t.dlspeed || 0) : 0;
      it.eta = it.status === 'DOWNLOADING' && t.eta > 0 && t.eta < 8640000 ? t.eta : -1;
      if (it.speed >= 0) it.speedHistory = [...(it.speedHistory || []), it.speed].slice(-60);
      if (t.state !== 'metaDL' && t.name) it.fileName = engine.sanitizeName(t.name);
      if (t.save_path) it.folder = t.save_path;
      if (it.status === 'COMPLETED') { it.completedAt = Date.now(); if (it.totalBytes > 0) it.downloadedBytes = it.totalBytes; it.speed = 0; it.eta = -1; if (prev !== 'COMPLETED') notify('Download complete', it.fileName); }
      if (it.status === 'FAILED' && prev !== 'FAILED') notify('Download failed', `${it.fileName}\n${it.error}`);
    }
    push();
  } catch (e) {
    const msg = qbitErr(e);
    for (const it of watch) if (it.status === 'DOWNLOADING') it.error = msg;
    push();
  } finally { qbitPolling = false; }
}

async function addOne(url, o) {
  const clean = url.trim();
  const magnet = engine.isMagnet(clean);
  if (!magnet && !/^https?:\/\//i.test(clean)) return { skipped: 'invalid' };
  const folder = o.folder || settings.folder;
  if (magnet && torrentMode()) return addMagnetTorrent(clean, o, folder, torrentMode());

  if (!o.force) {
    const ex = items.find(i => i.url.toLowerCase() === clean.toLowerCase());
    if (ex) {
      if (ex.status === 'DOWNLOADING' || ex.status === 'QUEUED') return { skipped: 'duplicate' };
      if (ex.status === 'PAUSED' || ex.status === 'FAILED') { if (o.autoStart !== false) startItem(ex.id); return { skipped: 'resumed' }; }
      if (ex.status === 'COMPLETED') {
        const st = await fsp.stat(path.join(ex.folder, ex.fileName)).catch(() => null);
        if (st && (ex.totalBytes <= 0 || st.size === ex.totalBytes)) return { skipped: 'exists' };
      }
    }
  }
  const info = magnet ? engine.parseMagnetUri(clean) : null;
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const requested = o.fileName && o.fileName.trim() ? engine.sanitizeName(o.fileName) : null;
  const item = {
    id, url: clean, folder,
    fileName: requested || (magnet ? await engine.resolveFileName(clean) : engine.guessNameFromUrl(clean)),
    totalBytes: -1, downloadedBytes: 0, status: o.autoStart === false ? 'PAUSED' : 'QUEUED',
    speed: 0, eta: -1, error: null,
    connections: magnet ? 1 : Math.min(Math.max(+o.connections || settings.connections, 1), 16),
    userAgent: (o.userAgent || '').trim() || null, referer: (o.referer || '').trim() || null, customHeaders: (o.customHeaders || '').trim() || null,
    isTorrent: magnet, magnetHash: info ? info.infoHash : null, speedHistory: [], addedAt: Date.now(), segs: null
  };
  items.unshift(item);
  push();
  // real name from server headers, then unique-ify, then start
  if (!requested && !magnet) {
    item.resolving = true;
    try { item.fileName = await engine.resolveFileName(clean, item); } catch { /* keep guess */ }
    item.resolving = false;
  }
  item.fileName = await uniqueName(folder, item.fileName, clean, id);
  if (o.autoStart !== false) startItem(id); else push();
  return { added: id };
}

function startItem(id) {
  const it = find(id); if (!it || runners.has(id) || it.status === 'COMPLETED') return;
  if (it.qbit || it.bt) {
    it.status = 'DOWNLOADING'; it.speed = -1; it.error = null; push();
    (async () => {
      if (it.qbit && it.qbitAdded) { try { await qb.resume(it.magnetHash); } catch (e) { it.status = 'FAILED'; it.speed = 0; it.error = qbitErr(e); push(); } return; }
      await torrentSend(it);
    })();
    return;
  }
  it.status = 'QUEUED'; it.error = null; pump();
}
async function pauseItem(id) {
  const it = find(id); if (!it) return;
  if (it.status === 'COMPLETED') return;
  it.status = 'PAUSED'; it.speed = 0; it.eta = -1;
  if (it.qbit) { if (it.qbitAdded) await qb.pause(it.magnetHash).catch(e => { it.error = qbitErr(e); }); push(); return; }
  if (it.bt) { btTorrents.delete(id); await bt.stop(it.magnetHash, false).catch(() => {}); push(); return; }
  await stop(id); pump();
}
async function removeItem(id, deleteFiles) {
  const it = find(id); if (!it) return;
  it.status = 'CANCELED';
  if (it.qbit && it.qbitAdded) await qb.remove(it.magnetHash, deleteFiles).catch(() => {});
  if (it.bt) { btTorrents.delete(id); await bt.stop(it.magnetHash, !!deleteFiles).catch(() => {}); }
  if (it.isFile) await fsp.rm(tfile(it.magnetHash), { force: true }).catch(() => {});
  await stop(id);
  items = items.filter(i => i.id !== id);
  const fp = path.join(it.folder, it.fileName);
  await fsp.rm(fp + '.f2l.part', { force: true }).catch(() => {});
  if (deleteFiles) await fsp.rm(fp, { force: true }).catch(() => {});
  push(); pump();
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 820, minHeight: 560,
    backgroundColor: settings.theme === 'light' ? '#F5F6F9' : '#0B0D12',
    title: 'F2L Downloader', icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
}

async function checkUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `F2LDownloaderDesktop/${VERSION}` } });
    if (r.status === 404) return { state: 'error', message: 'No release published yet' };
    if (!r.ok) return { state: 'error', message: `Update server error (HTTP ${r.status})` };
    const j = await r.json();
    const tag = String(j.tag_name || '');
    const parts = s => (s.match(/\d+/g) || []).map(Number);
    const a = parts(tag), b = parts(VERSION);
    let newer = false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) { newer = x > y; break; } }
    if (!tag || !newer) return { state: 'uptodate' };
    const exe = (j.assets || []).find(x => /\.exe$/i.test(x.name));
    return { state: 'available', version: tag.replace(/^v/i, ''), notes: (j.body || '').trim(), url: (exe && exe.browser_download_url) || j.html_url };
  } catch (e) { return { state: 'error', message: engine.friendly(e) }; }
}

async function checkWritable(dir) {
  try {
    await engine.ensureDir(dir);
    const t = path.join(dir, `.f2l-write-test-${process.pid}`);
    await fsp.writeFile(t, '');
    await fsp.rm(t, { force: true });
    return null;
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return `No write permission for "${dir}". Pick another folder (e.g. Downloads or Documents) — protected/system folders and Controlled Folder Access block writes.`;
    if (e.code === 'ENOENT') return `Folder not found: "${dir}"`;
    return `Cannot use "${dir}": ${e.code || e.message}`;
  }
}

function handle(ch, fn) { ipcMain.handle(ch, async (_e, ...a) => fn(...a)); }

function registerIpc() {
  handle('state', () => ({ items, settings, version: VERSION, platform: process.platform }));
  handle('add', async (o) => {
    const urls = [...new Set((o.urls || []).map(u => u.trim()).filter(Boolean))];
    const single = urls.length === 1;
    const folder = o.folder || settings.folder;
    const viaQbit = settings.qbitEnabled && urls.length && urls.every(u => engine.isMagnet(u));
    const bad = viaQbit ? null : await checkWritable(folder);
    if (bad) return [{ skipped: 'folder', error: bad }];
    const out = [];
    for (const u of urls) out.push(await addOne(u, { ...o, fileName: single ? o.fileName : null }));
    return out;
  });
  handle('start', id => startItem(id));
  handle('pause', id => pauseItem(id));
  handle('retry', id => { const it = find(id); if (it) { it.singleOnly = false; startItem(id); } });
  handle('remove', (id, del) => removeItem(id, !!del));
  handle('pauseAll', async () => { for (const it of items.filter(i => i.status === 'DOWNLOADING' || i.status === 'QUEUED')) await pauseItem(it.id); });
  handle('resumeAll', () => { for (const it of items.filter(i => i.status === 'PAUSED' || i.status === 'FAILED')) startItem(it.id); });
  handle('clearCompleted', () => { items = items.filter(i => i.status !== 'COMPLETED'); push(); });
  handle('open', async id => { const it = find(id); if (it) { const r = await shell.openPath(path.join(it.folder, it.fileName)); return r || null; } });
  handle('reveal', id => { const it = find(id); if (it) shell.showItemInFolder(path.join(it.folder, it.fileName)); });
  handle('openFolder', async () => shell.openPath(settings.folder));
  handle('fileExists', async id => { const it = find(id); return it ? fsp.stat(path.join(it.folder, it.fileName)).then(() => true, () => false) : false; });
  handle('setSettings', patch => {
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS())) if (k in patch) clean[k] = patch[k];
    clean.connections = Math.min(Math.max(+clean.connections || settings.connections, 1), 16);
    clean.retryAttempts = Math.min(Math.max(+(clean.retryAttempts ?? settings.retryAttempts), 0), 10);
    clean.maxConcurrent = Math.min(Math.max(+(clean.maxConcurrent ?? settings.maxConcurrent), 1), 10);
    for (const k of ['qbitUrl', 'qbitUser', 'qbitPass']) if (k in clean) clean[k] = String(clean[k] || '').trim();
    settings = { ...settings, ...clean }; qb.reset(); saveSoon(); pump(); return settings;
  });
  handle('pickFolder', async () => {
    try {
      const opts = { properties: ['openDirectory', 'createDirectory'] };
      if (settings.folder && fs.existsSync(settings.folder)) opts.defaultPath = settings.folder;
      const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { path: null };
      const p = r.filePaths[0];
      const err = await checkWritable(p);
      return err ? { path: null, error: err } : { path: p };
    } catch (e) { return { path: null, error: `Could not open folder picker: ${e.message}` }; }
  });
  handle('importFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Link lists', extensions: ['txt', 'm3u', 'm3u8', 'list', 'csv'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled) return [];
    const text = await fsp.readFile(r.filePaths[0], 'utf8');
    return engine.extractUrls(text);
  });
  handle('addTorrents', async (files, o) => {
    const out = [];
    for (const f of files || []) out.push(await addTorrentData(String(f.name || 'file.torrent'), Buffer.from(f.data), o || {}));
    return out;
  });
  handle('pickTorrents', async (o) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Torrent files', extensions: ['torrent'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const fp of r.filePaths) out.push(await addTorrentData(path.basename(fp), await fsp.readFile(fp), o || {}));
    return out;
  });
  handle('qbitTest', async (cfg) => {
    const prev = settings;
    try {
      settings = { ...settings, ...cfg }; qb.reset();
      const v = await qb.version();
      return { ok: true, version: v };
    } catch (e) { return { ok: false, error: qbitErr(e) }; }
    finally { settings = prev; qb.reset(); }
  });
  handle('clipboard', () => engine.extractUrls(clipboard.readText() || ''));
  handle('checkUpdate', () => checkUpdate());
  handle('openExternal', u => { if (/^https:\/\//i.test(u)) shell.openExternal(u); });
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const urls = engine.extractUrls(argv.join(' '));
  if (urls.length) addMany(urls);
  addTorrentPaths(argv);
});
function addMany(urls) { (async () => { for (const u of urls) await addOne(u, {}); })(); }
// .torrent paths passed on the command line (double-click / "open with")
function addTorrentPaths(argv) {
  const paths = argv.filter(a => /\.torrent$/i.test(a) && fs.existsSync(a));
  (async () => { for (const p of paths) { try { await addTorrentData(path.basename(p), await fsp.readFile(p), {}); } catch { /* ignore */ } } })();
}

app.whenReady().then(() => {
  settings = { ...DEFAULT_SETTINGS(), ...readJson('settings.json', {}) };
  items = readJson('downloads.json', []);
  const btResume = [];
  // unfinished work at last shutdown: resume or park
  for (const it of items) {
    it.speed = 0; it.eta = -1;
    if (it.qbit) continue; // qBittorrent owns these; the poller syncs state
    if (it.bt) { if (it.status === 'DOWNLOADING' || it.status === 'QUEUED') { if (settings.autoResume) btResume.push(it); else it.status = 'PAUSED'; } continue; }
    if (it.status === 'DOWNLOADING' || it.status === 'QUEUED') it.status = settings.autoResume ? 'QUEUED' : 'PAUSED';
  }
  registerIpc();
  createWindow();
  pump();
  setInterval(pollQbit, 2000);
  setInterval(pollBt, 1000);
  for (const it of btResume) startItem(it.id);
  const startUrls = engine.extractUrls(process.argv.slice(1).join(' '));
  if (startUrls.length) addMany(startUrls);
  addTorrentPaths(process.argv.slice(1));
});

app.on('before-quit', () => { bt.shutdown().catch(() => {}); for (const r of runners.values()) r.ac.abort(); saveNow(); });
app.on('window-all-closed', () => app.quit());
