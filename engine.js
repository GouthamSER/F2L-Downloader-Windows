'use strict';
/**
 * F2L download engine — Node port of the Android DownloadEngine.kt.
 *  - HTTP(S) segmented downloads (2–16 connections) over Range requests, with single-connection fallback
 *  - resume (segment progress is persisted by the caller via item.segs)
 *  - custom User-Agent / Referer / arbitrary headers & cookies
 *  - file name detection from Content-Disposition
 *  - magnet links: resolve .torrent from public caches, else write a .magnet shortcut
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class RangeRefusedError extends Error {}
class HttpError extends Error {
  constructor(code) { super(httpErrorMessage(code)); this.code = code; this.fatal = code >= 400 && code < 500 && code !== 408 && code !== 429; }
}

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
  let n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 200) || `download-${Date.now()}.bin`;
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
  const h = { 'Accept-Encoding': 'identity', 'User-Agent': 'F2LDownloader/3.4.1' };
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
  if (status && status >= 400 && status !== 405 && status !== 501 && status !== 403 && status !== 404) throw new HttpError(status);
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
async function streamBody(url, headers, signal, onData, expectStatus) {
  const rc = new AbortController(); linkSignal(signal, rc);
  let stalled = false, timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; rc.abort(); }, STALL_MS); };
  arm();
  try {
    const res = await fetch(url, { headers, signal: rc.signal, redirect: 'follow' });
    arm();
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } throw new HttpError(res.status); }
    if (expectStatus && res.status !== expectStatus.status) {
      try { await res.body?.cancel(); } catch { /* */ }
      if (expectStatus.refuse) throw new RangeRefusedError(`Server refused range request (HTTP ${res.status})`);
    }
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
  const partPath = finalPath + '.f2l.part';

  if (isMagnet(item.url)) return downloadMagnet(item, finalPath, onProgress, signal);

  const headers = buildHeaders(item);
  const info = await probe(item.url, headers, signal);
  if (info.total > 0) item.totalBytes = info.total;

  // Already fully downloaded?
  if (info.total > 0) {
    const st = await fsp.stat(finalPath).catch(() => null);
    if (st && st.size === info.total) { await cleanupParts(partPath); onProgress({ downloaded: info.total, total: info.total, speed: 0 }); return; }
  }

  const want = Math.min(Math.max(item.connections || 8, 1), 16);
  const canSegment = info.total > 0 && info.ranges && want > 1 && !item.singleOnly;
  if (canSegment) {
    try {
      await segmented(item, info.total, want, headers, partPath, finalPath, signal, onProgress);
      return;
    } catch (e) {
      if (signal.aborted) throw e;
      const got = (item.segs || []).reduce((a, s) => a + s.d, 0);
      // Server refuses parallel ranges / barely started → fall back to 1 connection. Real progress → rethrow so retry resumes.
      if (e instanceof RangeRefusedError || got < info.total / 20) {
        item.segs = null; item.singleOnly = true;
        await fsp.rm(partPath, { force: true });
      } else throw e;
    }
  }
  await single(item, info.total, headers, partPath, finalPath, signal, onProgress);
}

async function cleanupParts(partPath) { await fsp.rm(partPath, { force: true }).catch(() => {}); }

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

async function finalize(partPath, finalPath, total, onProgress, downloaded) {
  onProgress({ downloaded, total, speed: -1 }); // FINALIZING
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(partPath, finalPath);
  onProgress({ downloaded: total > 0 ? total : downloaded, total: total > 0 ? total : downloaded, speed: 0 });
}

async function segmented(item, total, count, headers, partPath, finalPath, signal, onProgress) {
  // (Re)build segment table unless a valid one exists for this exact size/count AND the part file is still there.
  const partStat = await fsp.stat(partPath).catch(() => null);
  const valid = Array.isArray(item.segs) && item.segs.length === count && item.segTotal === total && partStat && partStat.size === total;
  if (!valid) {
    const chunk = Math.ceil(total / count);
    item.segs = Array.from({ length: count }, (_, i) => {
      const s = i * chunk, e = Math.min(total - 1, s + chunk - 1);
      return { s, e, d: 0 };
    }).filter(sg => sg.s <= sg.e);
    item.segTotal = total;
    const fh0 = await fsp.open(partPath, 'w'); await fh0.truncate(total); await fh0.close();
  }
  const segs = item.segs;
  const fh = await fsp.open(partPath, 'r+');
  const inner = new AbortController(); linkSignal(signal, inner);
  const sum = () => segs.reduce((a, s) => a + s.d, 0);
  const stopReport = makeSpeedReporter(sum, total, onProgress);

  const runSeg = async (seg) => {
    const len = seg.e - seg.s + 1;
    if (seg.d >= len) return;
    let pos = seg.s + seg.d;
    await streamBody(item.url, { ...headers, Range: `bytes=${pos}-${seg.e}` }, inner.signal, async (chunk) => {
      let buf = chunk;
      const remaining = seg.e - pos + 1;
      if (buf.length > remaining) buf = buf.subarray(0, remaining);
      if (buf.length) { await fh.write(buf, 0, buf.length, pos); pos += buf.length; seg.d += buf.length; }
      return pos > seg.e; // stop once this segment is complete
    }, { status: 206, refuse: true });
    if (seg.d < len) throw new Error('unexpected end of stream');
  };

  let firstErr = null;
  try {
    await Promise.allSettled(segs.map(sg => runSeg(sg).catch(err => { if (!firstErr) firstErr = err; inner.abort(); throw err; })));
  } finally {
    stopReport();
    await fh.close().catch(() => {});
  }
  if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  if (firstErr) throw firstErr;
  if (sum() < total) throw new Error('unexpected end of stream');
  await finalize(partPath, finalPath, total, onProgress, total);
  item.segs = null;
}

async function single(item, total, headers, partPath, finalPath, signal, onProgress) {
  let existing = (await fsp.stat(partPath).catch(() => null))?.size || 0;
  if (total > 0 && existing > total) existing = 0;
  if (item.segs) { item.segs = null; existing = 0; }
  const h = { ...headers };
  if (existing > 0) h.Range = `bytes=${existing}-`;
  let pos = existing, fh = null;
  const stopReport = makeSpeedReporter(() => pos, total, onProgress);
  try {
    await streamBody(item.url, h, signal, async (chunk, status) => {
      if (!fh) {
        if (status !== 206 && existing > 0) { pos = 0; fh = await fsp.open(partPath, 'w'); }   // server ignored Range → restart
        else fh = await fsp.open(partPath, existing > 0 ? 'r+' : 'w');
      }
      await fh.write(chunk, 0, chunk.length, pos); pos += chunk.length;
    });
  } finally { stopReport(); if (fh) await fh.close().catch(() => {}); }
  if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  const size = (await fsp.stat(partPath).catch(() => null))?.size || 0;
  if (total > 0 && size < total) throw new Error('unexpected end of stream');
  if (!fh && size === 0) { await fsp.writeFile(partPath, ''); }
  await finalize(partPath, finalPath, total, onProgress, size);
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
        const r = await fetch(u, { headers: { 'User-Agent': 'F2LDownloader/3.4.1' }, signal: ac.signal, redirect: 'follow' });
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
  ensureDir, isMagnet, parseMagnetUri, httpErrorMessage, friendly, isRetryable, extractUrls, sanitizeName,
  guessNameFromUrl, resolveFileName, probe, download, buildHeaders, parseContentDisposition,
  HttpError, RangeRefusedError
};
