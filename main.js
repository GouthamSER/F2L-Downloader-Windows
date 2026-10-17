'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const engine = require('./engine');

const VERSION = require('./package.json').version;
const REPO = 'GouthamSER/F2L-Downloader-App';

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let items = [];
let settings = {};
const runners = new Map(); // id -> { ac, done }

const DEFAULT_SETTINGS = () => ({
  folder: app.getPath('downloads'),
  connections: 8,
  retryAttempts: 3,
  maxConcurrent: 3,
  autoResume: true,
  notifications: true,
  theme: 'dark',
  autoUpdateCheck: true
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
  const running = items.filter(i => i.status === 'DOWNLOADING').length;
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

async function addOne(url, o) {
  const clean = url.trim();
  const magnet = engine.isMagnet(clean);
  if (!magnet && !/^https?:\/\//i.test(clean)) return { skipped: 'invalid' };
  const folder = o.folder || settings.folder;

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
  it.status = 'QUEUED'; it.error = null; pump();
}
async function pauseItem(id) {
  const it = find(id); if (!it) return;
  if (it.status === 'COMPLETED') return;
  it.status = 'PAUSED'; it.speed = 0; it.eta = -1;
  await stop(id); pump();
}
async function removeItem(id, deleteFiles) {
  const it = find(id); if (!it) return;
  it.status = 'CANCELED';
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

function handle(ch, fn) { ipcMain.handle(ch, async (_e, ...a) => fn(...a)); }

function registerIpc() {
  handle('state', () => ({ items, settings, version: VERSION, platform: process.platform }));
  handle('add', async (o) => {
    const urls = [...new Set((o.urls || []).map(u => u.trim()).filter(Boolean))];
    const single = urls.length === 1;
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
    settings = { ...settings, ...clean }; saveSoon(); pump(); return settings;
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.folder });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('importFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Link lists', extensions: ['txt', 'm3u', 'm3u8', 'list', 'csv'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled) return [];
    const text = await fsp.readFile(r.filePaths[0], 'utf8');
    return engine.extractUrls(text);
  });
  handle('clipboard', () => engine.extractUrls(clipboard.readText() || ''));
  handle('checkUpdate', () => checkUpdate());
  handle('openExternal', u => { if (/^https:\/\//i.test(u)) shell.openExternal(u); });
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const urls = engine.extractUrls(argv.join(' '));
  if (urls.length) addMany(urls);
});
function addMany(urls) { (async () => { for (const u of urls) await addOne(u, {}); })(); }

app.whenReady().then(() => {
  settings = { ...DEFAULT_SETTINGS(), ...readJson('settings.json', {}) };
  items = readJson('downloads.json', []);
  // unfinished work at last shutdown: resume or park
  for (const it of items) {
    it.speed = 0; it.eta = -1;
    if (it.status === 'DOWNLOADING' || it.status === 'QUEUED') it.status = settings.autoResume ? 'QUEUED' : 'PAUSED';
  }
  registerIpc();
  createWindow();
  pump();
  const startUrls = engine.extractUrls(process.argv.slice(1).join(' '));
  if (startUrls.length) addMany(startUrls);
});

app.on('before-quit', () => { for (const r of runners.values()) r.ac.abort(); saveNow(); });
app.on('window-all-closed', () => app.quit());
