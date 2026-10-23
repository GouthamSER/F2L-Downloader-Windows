'use strict';
// qBittorrent WebUI API v2 client + minimal .torrent (bencode) parser.
const crypto = require('crypto');

// ---------- .torrent parsing ----------
// Returns { infoHash (UPPER hex), name, size } or throws on invalid data.
function parseTorrent(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let p = 0, infoStart = -1, infoEnd = -1;
  const fail = () => { throw new Error('Not a valid .torrent file'); };
  function parse(depth, key) {
    if (p >= buf.length || depth > 32) fail();
    const c = buf[p];
    if (c === 0x69) { // i<int>e
      const e = buf.indexOf(0x65, p); if (e < 0) fail();
      const n = Number(buf.toString('latin1', p + 1, e)); p = e + 1; return n;
    }
    if (c === 0x6c) { // l...e
      p++; const a = [];
      while (buf[p] !== 0x65) { if (p >= buf.length) fail(); a.push(parse(depth + 1)); }
      p++; return a;
    }
    if (c === 0x64) { // d...e
      p++; const o = {};
      while (buf[p] !== 0x65) {
        if (p >= buf.length) fail();
        const k = parse(depth + 1).toString('latin1');
        const vs = p;
        const v = parse(depth + 1, k);
        if (depth === 0 && k === 'info') { infoStart = vs; infoEnd = p; }
        o[k] = v;
      }
      p++; return o;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, p); if (colon < 0) fail();
      const len = Number(buf.toString('latin1', p, colon));
      if (!Number.isInteger(len) || len < 0 || colon + 1 + len > buf.length) fail();
      const s = buf.subarray(colon + 1, colon + 1 + len); p = colon + 1 + len; return s;
    }
    return fail();
  }
  const root = parse(0);
  if (!root || typeof root !== 'object' || infoStart < 0 || !root.info || typeof root.info !== 'object') fail();
  const info = root.info;
  const infoHash = crypto.createHash('sha1').update(buf.subarray(infoStart, infoEnd)).digest('hex').toUpperCase();
  const name = info.name ? info.name.toString('utf8') : `torrent-${infoHash.slice(0, 8)}`;
  let size = typeof info.length === 'number' ? info.length : 0;
  if (!size && Array.isArray(info.files)) size = info.files.reduce((a, f) => a + (f && typeof f.length === 'number' ? f.length : 0), 0);
  return { infoHash, name, size };
}

// ---------- WebUI client ----------
class QbitError extends Error { constructor(msg, code) { super(msg); this.code = code; this.qbit = true; } }

function createClient(getCfg) {
  let sid = null, sidFor = '';

  const base = () => {
    const c = getCfg();
    let u = String(c.qbitUrl || '').trim() || 'http://127.0.0.1:8080';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  };

  async function raw(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const b = base();
    const h = { Referer: b + '/', Origin: b, ...headers };
    if (auth && sid) h.Cookie = sid;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
    try {
      return await fetch(b + path, { method, body, headers: h, signal: ac.signal, redirect: 'manual' });
    } catch (e) {
      throw new QbitError(`Can't reach qBittorrent at ${b}. Is it running with Web UI enabled (Tools → Options → Web UI)?`, 'QBIT_UNREACHABLE');
    } finally { clearTimeout(t); }
  }

  async function login() {
    const c = getCfg();
    const r = await raw('/api/v2/auth/login', {
      method: 'POST', auth: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: c.qbitUser || '', password: c.qbitPass || '' }).toString()
    });
    const text = (await r.text()).trim();
    if (r.status === 403) throw new QbitError('qBittorrent banned this IP after failed logins. Wait a few minutes or restart qBittorrent.', 'QBIT_BANNED');
    if (r.status >= 400 || !/^ok\.?$/i.test(text)) throw new QbitError('qBittorrent login failed. Check username / password in Settings.', 'QBIT_AUTH');
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    const m = sc.map(s => /SID=[^;]+/.exec(s)).find(Boolean);
    sid = m ? m[0] : null; sidFor = base() + '|' + (c.qbitUser || '');
  }

  // authenticated request with one automatic re-login
  async function api(path, opts) {
    const key = base() + '|' + (getCfg().qbitUser || '');
    if (sidFor !== key) { sid = null; }
    if (!sid) await login();
    let r = await raw(path, opts);
    if (r.status === 403 || r.status === 401) { sid = null; await login(); r = await raw(path, opts); }
    return r;
  }

  const form = obj => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() });

  return {
    async version() {
      const r = await api('/api/v2/app/version');
      if (!r.ok) throw new QbitError(`qBittorrent returned HTTP ${r.status}`, 'QBIT_HTTP');
      return (await r.text()).trim();
    },
    async addMagnet(magnet, savepath) {
      const fd = new FormData();
      fd.append('urls', magnet);
      if (savepath) fd.append('savepath', savepath);
      const r = await api('/api/v2/torrents/add', { method: 'POST', body: fd });
      const t = (await r.text()).trim();
      if (!r.ok || /fail/i.test(t)) throw new QbitError(`qBittorrent rejected the magnet (${t || 'HTTP ' + r.status})`, 'QBIT_ADD');
    },
    async addTorrentFile(name, data, savepath) {
      const fd = new FormData();
      fd.append('torrents', new Blob([data], { type: 'application/x-bittorrent' }), name.endsWith('.torrent') ? name : name + '.torrent');
      if (savepath) fd.append('savepath', savepath);
      const r = await api('/api/v2/torrents/add', { method: 'POST', body: fd });
      const t = (await r.text()).trim();
      if (!r.ok || /fail/i.test(t)) throw new QbitError(`qBittorrent rejected the torrent (${t || 'HTTP ' + r.status})`, 'QBIT_ADD');
    },
    // hashes: array of hex strings → array of qBittorrent torrent objects
    async info(hashes) {
      if (!hashes.length) return [];
      const r = await api('/api/v2/torrents/info?hashes=' + encodeURIComponent(hashes.map(h => h.toLowerCase()).join('|')));
      if (!r.ok) throw new QbitError(`qBittorrent returned HTTP ${r.status}`, 'QBIT_HTTP');
      return r.json();
    },
    // v5 renamed pause/resume → stop/start; try new name first, fall back on 404
    async pause(hash) { let r = await api('/api/v2/torrents/stop', form({ hashes: hash.toLowerCase() })); if (r.status === 404) r = await api('/api/v2/torrents/pause', form({ hashes: hash.toLowerCase() })); },
    async resume(hash) { let r = await api('/api/v2/torrents/start', form({ hashes: hash.toLowerCase() })); if (r.status === 404) r = await api('/api/v2/torrents/resume', form({ hashes: hash.toLowerCase() })); },
    async remove(hash, deleteFiles) { await api('/api/v2/torrents/delete', form({ hashes: hash.toLowerCase(), deleteFiles: deleteFiles ? 'true' : 'false' })); },
    reset() { sid = null; }
  };
}

// qBittorrent state → F2L status
function mapState(s) {
  switch (s) {
    case 'error': case 'missingFiles': return 'FAILED';
    case 'pausedDL': case 'stoppedDL': return 'PAUSED';
    case 'uploading': case 'stalledUP': case 'pausedUP': case 'stoppedUP': case 'queuedUP': case 'checkingUP': case 'forcedUP': return 'COMPLETED';
    default: return 'DOWNLOADING'; // downloading, metaDL, stalledDL, queuedDL, checkingDL, forcedDL, allocating, checkingResumeData, moving
  }
}

module.exports = { parseTorrent, createClient, mapState, QbitError };
