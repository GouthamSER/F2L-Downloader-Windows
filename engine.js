'use strict';
/**
 * F2L download engine — Node port of the Android DownloadEngine.kt.
 *  - HTTP(S) downloads: ONE connection, ONE file (no .part files). Writes straight into the final file
 *    and resumes from its size with an HTTP Range request.
 *  - 429 / 503 ("server busy"): waits (Retry-After, else 2s,4s,8s,16s) and retries, never fails the download early
 *  - custom User-Agent / Referer / arbitrary headers & cookies
 *  - file name detection from Content-Disposition
 *  - magnet links: resolve .torrent from public caches, else write a .magnet shortcut
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class RangeRefusedError extends Error {}
class HttpError extends Error {
  constructor(code, retryAfter) {
    super(httpErrorMessage(code)); this.code = code;
    this.fatal = code >= 400 && code < 500 && code !== 408 && code !== 429;
    const n = parseInt(retryAfter, 10); this.retryAfterMs = n > 0 ? n * 1000 : 0;
  }
}
const isBusy = e => e instanceof HttpError && (e.code === 429 || e.code === 503);
/** 2s,4s,8s,16s (max 20s) unless the server sent Retry-After. */
const busyWaitMs = (e, tries) => Math.min(Math.max(e.retryAfterMs || (2000 << Math.min(tries, 3)), 1000), 20000);
const sleepSignal = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }, { once: true });
});

const STALL_MS = 30000;

function isMagnet(url) { return /^\s*magnet:/i.test(url || ''); }

function base32ToHex(b32) {
  const clean = b32.trim().toUpperCase();
  if (clean.length !== 32) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of clean) {
    const i = alphabet.indexOf(c);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 8 <= bits.length && hex.length < 40; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return hex.length === 40 ? hex.toUpperCase() : null;
}

function parseMagnetUri(uri) {
  const clean = (uri || '').trim();
  if (!isMagnet(clean)) return null;
  try {
    const q = clean.includes('?') ? clean.slice(clean.indexOf('?') + 1) : clean.replace(/^magnet:/i, '');
    let hash = null, dn = null; const trackers = [];
    for (const param of q.split('&')) {
      if (!param.trim()) continue;
      const eq = param.indexOf('=');
      const key = (eq >= 0 ? param.slice(0, eq) : param).trim().toLowerCase();
      const raw = eq >= 0 ? param.slice(eq + 1).trim() : '';
      let val = raw;
      try { val = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { /* keep raw */ }
      if (key === 'xt') {
        let cand = /^urn:bt(ih|mh):/i.test(val) ? val.slice(9).trim() : val.split(':').pop().trim();
        if (cand && !hash) hash = cand.length === 32 ? (base32ToHex(cand) || cand) : cand;
      } else if (key === 'dn') { if (val.trim() && !dn) dn = val; }
      else if (key === 'tr') { if (val.trim()) trackers.push(val); }
    }
    if (!hash) return null;
    return { infoHash: hash.toUpperCase(), displayName: dn, trackers };
  } catch { return null; }
}

function httpErrorMessage(code) {
  switch (code) {
    case 401: return 'Authentication required (HTTP 401)';
    case 403: return 'Access denied (HTTP 403) — check custom headers or cookies';
    case 404: return 'File not found (HTTP 404)';
    case 410: return 'File no longer available (HTTP 410)';
    case 416: return 'Range not satisfiable (file may have changed)';
    case 429: return 'Server busy (HTTP 429) - too many connections. Wait a moment, then retry.';
    case 503: return 'Server busy (HTTP 503). Wait a moment, then retry.';
    default: return code >= 500 && code <= 599 ? `Server error (HTTP ${code})` : `HTTP ${code}`;
  }
}

/** Plain-language errors, same wording as the Android app. */
function friendly(e) {
  const m = String((e && (e.message || e.cause && e.cause.message)) || e || '');
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|Unable to resolve host/i.test(m)) return "Can't reach the server. Check your internet connection, then click Retry.";
  if (/timed out|timeout/i.test(m) || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Connection timed out. The server or your network is slow — click Retry.';
  if (code === 'ENOSPC' || /no space left/i.test(m)) return 'Not enough disk space. Free up some space, then click Retry.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'F2L cannot write to the download folder. Pick another folder in Settings, then click Retry.';
  if (/certificate|SSL|TLS|CERT_/i.test(m) || /^(ERR_)?(SSL|CERT)/.test(String(code))) return 'Secure connection failed. The site certificate may be invalid, or your PC date/time is wrong.';
  if (code === 'ECONNREFUSED') return "Couldn't connect to the server. It may be down — try again later.";
  if (/unexpected end of stream|ECONNRESET|terminated|socket hang up|other side closed/i.test(m) || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'Connection dropped. Click Retry to continue where it stopped.';
  if (/fetch failed/i.test(m)) return "Can't reach the server. Check your internet connection, then click Retry.";
  return m || 'Something went wrong. Click Retry.';
}

function isRetryable(e) {
  if (e instanceof HttpError) return !e.fatal;
  const code = e && e.code;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') return false;
  return true;
}

function extractUrls(text) {
  const re = /(https?:\/\/[^\s<>"'{}|\\^`]+|magnet:[^\s<>"'{}|\\^`]+)/gi;
  return [...new Set((String(text).match(re) || []).map(s => s.trim()).filter(Boolean))];
}

function sanitizeName(name) {
  // illegal Windows chars -> space ("File Name : Movie" must not break file creation), collapse, cap length, keep extension
  let n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/\s+(\.[A-Za-z0-9]{1,8})$/, '$1').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 9 ? n.slice(dot) : '';
  let base = ext ? n.slice(0, dot) : n;
  if (base.length > 120) base = base.slice(0, 120).trim();
  return (base + ext) || `download-${Date.now()}.bin`;
}

function guessNameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return sanitizeName(last || `download-${Date.now()}.bin`);
  } catch { return `download-${Date.now()}.bin`; }
}

function parseContentDisposition(h) {
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(h);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  const raw = (star && star[1]) || (plain && plain[1]);
  if (!raw) return null;
  let v = raw.trim();
  try { v = decodeURIComponent(v); } catch { /* keep */ }
  return v || null;
}

function buildHeaders(item) {
  const h = { 'Accept-Encoding': 'identity', 'User-Agent': 'F2LDownloader/3.9.0' };
  if (item.userAgent && item.userAgent.trim()) h['User-Agent'] = item.userAgent.trim();
  if (item.referer && item.referer.trim()) h['Referer'] = item.referer.trim();
  if (item.customHeaders) {
    for (const line of String(item.customHeaders).split(/\r?\n/)) {
      const t = line.trim(); const i = t.indexOf(':');
      if (i > 0) { const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim(); if (k && v) h[k] = v; }
    }
  }
  return h;
}

function linkSignal(parent, child) {
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener('abort', () => child.abort(parent.reason), { once: true });
}

/** HEAD (fallback: GET bytes=0-0) to learn size, range support and header-provided file name. */
async function probe(url, headers, signal) {
  let total = -1, ranges = false, name = null, status = 0;
  try {
    const r = await fetch(url, { method: 'HEAD', headers, signal, redirect: 'follow' });
    status = r.status;
    if (r.ok) {
      total = parseInt(r.headers.get('content-length') || '-1', 10);
      if (!(total > 0)) total = -1;
      ranges = /bytes/i.test(r.headers.get('accept-ranges') || '');
      const cd = r.headers.get('content-disposition'); if (cd) name = parseContentDisposition(cd);
    }
  } catch (e) { if (signal && signal.aborted) throw e; status = 0; }
  if (status && status >= 400 && status !== 405 && status !== 501 && status !== 403 && status !== 404) throw new HttpError(status, null);
  if (!(status >= 200 && status < 300) || total <= 0 || !ranges) {
    // Many servers refuse HEAD or omit Accept-Ranges — a 1-byte ranged GET tells the truth.
    try {
      const r = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal, redirect: 'follow' });
      if (r.status === 206) {
        const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
        if (m) { total = parseInt(m[1], 10); ranges = true; }
        const cd = r.headers.get('content-disposition'); if (cd && !name) name = parseContentDisposition(cd);
      } else if (r.ok) {
        const len = parseInt(r.headers.get('content-length') || '-1', 10);
        if (len > 0) total = len;
        ranges = false;
        const cd = r.headers.get('content-disposition'); if (cd && !name) name = parseContentDisposition(cd);
      } else if (!(status >= 200 && status < 300)) throw new HttpError(r.status);
      try { await r.body?.cancel(); } catch { /* ignore */ }
    } catch (e) { if (e instanceof HttpError || (signal && signal.aborted)) throw e; if (!(status >= 200 && status < 300)) throw e; }
  }
  return { total, ranges, name };
}

async function resolveFileName(url, item = {}) {
  const clean = String(url).trim();
  if (isMagnet(clean)) {
    const m = parseMagnetUri(clean);
    const n = sanitizeName((m && m.displayName) || `torrent-${m ? m.infoHash.slice(0, 8) : Date.now()}`);
    return /\.(torrent|magnet)$/i.test(n) ? n : n + '.torrent';
  }
  const fallback = guessNameFromUrl(clean);
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(clean, { method: 'HEAD', headers: buildHeaders(item), signal: ac.signal, redirect: 'follow' });
    clearTimeout(t);
    const cd = r.headers.get('content-disposition');
    const fromHeader = cd && parseContentDisposition(cd);
    if (fromHeader) return sanitizeName(fromHeader);
    // fall back to the post-redirect URL name if the original had none
    if (r.url && r.url !== clean) { const n = guessNameFromUrl(r.url); if (/\.[a-z0-9]{1,6}$/i.test(n) && !/\.[a-z0-9]{1,6}$/i.test(fallback)) return n; }
  } catch { /* use fallback */ }
  return fallback;
}

/** Stream a ranged/plain response into `onData(chunk)`; aborts if no bytes arrive for STALL_MS. */
async function streamBody(url, headers, signal, onData) {
  const rc = new AbortController(); linkSignal(signal, rc);
  let stalled = false, timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; rc.abort(); }, STALL_MS); };
  arm();
  try {
    const res = await fetch(url, { headers, signal: rc.signal, redirect: 'follow' });
    arm();
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } throw new HttpError(res.status, res.headers.get('retry-after')); }
    const status = res.status;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      const stop = await onData(value, status);
      if (stop === true) { try { await reader.cancel(); } catch { /* */ } break; }
    }
    return status;
  } catch (e) {
    if (stalled && !signal.aborted) throw new Error('Connection timed out (no data for 30s)');
    throw e;
  } finally { clearTimeout(timer); }
}

// mkdir on an existing drive root (e.g. F:\) throws EPERM on Windows — only create when missing
async function ensureDir(dir) {
  const st = await fsp.stat(dir).catch(() => null);
  if (st && st.isDirectory()) return;
  await fsp.mkdir(dir, { recursive: true });
}

async function download(item, { signal, onProgress }) {
  await ensureDir(item.folder);
  const finalPath = path.join(item.folder, item.fileName);

  if (isMagnet(item.url)) return downloadMagnet(item, finalPath, onProgress, signal);

  const headers = buildHeaders(item);
  // server full (429/503)? wait and ask again - do not fail
  let info, busy = 0;
  for (;;) {
    try { info = await probe(item.url, headers, signal); break; }
    catch (e) {
      if (!isBusy(e) || signal.aborted || ++busy > 10) throw e;
      await waitBusy(item, e, busy, onProgress, signal, 0, -1);
    }
  }
  if (info.total > 0) item.totalBytes = info.total;

  await migrateLegacyParts(item, finalPath, info.total);

  // Already fully downloaded?
  if (info.total > 0) {
    const st = await fsp.stat(finalPath).catch(() => null);
    if (st && st.size === info.total) { onProgress({ downloaded: info.total, total: info.total, speed: 0 }); return; }
  }
  await single(item, info.total, headers, finalPath, signal, onProgress);
}

async function waitBusy(item, e, tries, onProgress, signal, pos, total) {
  const ms = busyWaitMs(e, tries);
  item.error = `Server busy - retrying in ${Math.ceil(ms / 1000)}s (${tries}/10)...`;
  onProgress({ downloaded: pos, total, speed: 0 });
  try { await sleepSignal(ms, signal); } finally { item.error = null; }
}

/**
 * Old versions wrote "<name>.f2l.part" (single, contiguous) or a pre-allocated part file (segmented, with holes).
 * Contiguous partial -> becomes the real file so the download resumes. Segmented / unknown -> deleted.
 */
async function migrateLegacyParts(item, finalPath, total) {
  const part = finalPath + '.f2l.part';
  const st = await fsp.stat(part).catch(() => null);
  if (!st) { item.segs = null; return; }
  const segmented = !!(item.segs || item.segTotal);
  const hasFinal = !!(await fsp.stat(finalPath).catch(() => null));
  if (!segmented && !hasFinal && st.size > 0 && (total <= 0 || st.size < total)) {
    try { await fsp.rename(part, finalPath); } catch { await fsp.rm(part, { force: true }).catch(() => {}); }
  } else {
    await fsp.rm(part, { force: true }).catch(() => {});
  }
  item.segs = null; item.segTotal = null; item.singleOnly = false;
}

function makeSpeedReporter(getDownloaded, total, onProgress) {
  let last = getDownloaded(), lastT = process.hrtime.bigint();
  const iv = setInterval(() => {
    const now = process.hrtime.bigint(); const sec = Number(now - lastT) / 1e9;
    const d = getDownloaded();
    const speed = sec > 0 ? Math.max(0, Math.round((d - last) / sec)) : 0;
    last = d; lastT = now;
    onProgress({ downloaded: d, total, speed });
  }, 500);
  return () => clearInterval(iv);
}

// Global speed limit (KB/s, 0 = unlimited). main.js keeps it in sync with Settings; read live so changes apply mid-download.
let limitKBps = 0;
const setLimit = v => { limitKBps = Math.max(0, +v || 0); };
function makeThrottle() {
  let t0 = Date.now(), sent = 0;
  return async (n, signal) => {
    const lim = limitKBps * 1024;
    if (lim <= 0) { t0 = Date.now(); sent = 0; return; }
    sent += n;
    const wait = Math.round(sent * 1000 / lim) - (Date.now() - t0);
    if (wait > 15) await sleepSignal(Math.min(wait, 2000), signal);
    if (Date.now() - t0 > 4000) { t0 = Date.now(); sent = 0; } // short window: limit changes take effect fast
  };
}

async function single(item, total, headers, finalPath, signal, onProgress) {
  // The download goes straight into the final file and resumes from its size. No temp / part files.
  let existing = (await fsp.stat(finalPath).catch(() => null))?.size || 0;
  if (total > 0 && existing > total) existing = 0;   // changed / corrupt file: start over
  const h = { ...headers };
  if (existing > 0) h.Range = `bytes=${existing}-`;
  let pos = existing, fh = null, busy = 0;
  const stopReport = makeSpeedReporter(() => pos, total, onProgress);
  const throttle = makeThrottle();
  try {
    for (;;) {
      try {
        await streamBody(item.url, h, signal, async (chunk, status) => {
          if (!fh) {
            if (status !== 206 && existing > 0) { pos = 0; fh = await fsp.open(finalPath, 'w'); }   // server ignored Range -> restart
            else fh = await fsp.open(finalPath, existing > 0 ? 'r+' : 'w');
          }
          await fh.write(chunk, 0, chunk.length, pos); pos += chunk.length;
          await throttle(chunk.length, signal);
        });
        break;
      } catch (e) {
        if (!isBusy(e) || signal.aborted || fh || ++busy > 10) throw e;   // busy only happens before any byte arrives
        await waitBusy(item, e, busy, onProgress, signal, pos, total);
      }
    }
  } finally { stopReport(); if (fh) await fh.close().catch(() => {}); }
  if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  const size = (await fsp.stat(finalPath).catch(() => null))?.size || 0;
  if (total > 0 && size < total) throw new Error('unexpected end of stream');   // retry loop resumes from this size
  if (!fh && size === 0) await fsp.writeFile(finalPath, '');
  onProgress({ downloaded: total > 0 ? total : size, total: total > 0 ? total : size, speed: 0 });
}

async function downloadMagnet(item, finalPath, onProgress, signal) {
  const magnet = parseMagnetUri(item.url);
  onProgress({ downloaded: 10, total: 100, speed: 0 });
  const base = item.fileName.replace(/\.(torrent|magnet)$/i, '');
  const dir = item.folder;
  if (magnet) {
    const caches = [
      `https://itorrents.org/torrent/${magnet.infoHash}.torrent`,
      `https://btcache.me/torrent/${magnet.infoHash}`
    ];
    for (const u of caches) {
      try {
        const ac = new AbortController(); linkSignal(signal, ac); const t = setTimeout(() => ac.abort(), 20000);
        const r = await fetch(u, { headers: { 'User-Agent': 'F2LDownloader/3.9.0' }, signal: ac.signal, redirect: 'follow' });
        if (r.ok) {
          const bytes = Buffer.from(await r.arrayBuffer()); clearTimeout(t);
          if (bytes.length > 50 && bytes[0] === 0x64) { // bencoded dict starts with 'd'
            const out = path.join(dir, base + '.torrent');
            await fsp.writeFile(out, bytes);
            item.fileName = base + '.torrent'; item.torrentFound = true;
            onProgress({ downloaded: 100, total: 100, speed: 0 });
            return;
          }
        } else clearTimeout(t);
      } catch (e) { if (signal.aborted) throw e; }
    }
  }
  const lines = ['[InternetShortcut]', `URL=${item.url}`];
  if (magnet) {
    lines.push('', '# Magnet Details', `# Hash: ${magnet.infoHash}`);
    if (magnet.displayName) lines.push(`# Name: ${magnet.displayName}`);
    magnet.trackers.forEach(t => lines.push(`# Tracker: ${t}`));
  }
  const out = path.join(dir, base + '.magnet');
  await fsp.writeFile(out, lines.join('\r\n') + '\r\n', 'utf8');
  item.fileName = base + '.magnet';
  onProgress({ downloaded: 100, total: 100, speed: 0 });
}

module.exports = {
  setLimit, ensureDir, isMagnet, parseMagnetUri, httpErrorMessage, friendly, isRetryable, extractUrls, sanitizeName,
  guessNameFromUrl, resolveFileName, probe, download, buildHeaders, parseContentDisposition,
  HttpError, RangeRefusedError, isBusy
};
