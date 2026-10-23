'use strict';
// qBittorrent client test against a mock Web UI server + .torrent parser check.
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const Q = require('../qbit');

const enc = (s) => Buffer.from(`${Buffer.byteLength(s)}:${s}`);
const infoDict = Buffer.concat([Buffer.from('d6:lengthi12345e4:name8:test.bin12:piece lengthi16384e6:pieces20:'), crypto.randomBytes(20), Buffer.from('e')]);
const torrent = Buffer.concat([Buffer.from('d8:announce'), enc('http://t/a'), Buffer.from('4:info'), infoDict, Buffer.from('e')]);
const wantHash = crypto.createHash('sha1').update(infoDict).digest('hex').toUpperCase();

const meta = Q.parseTorrent(torrent);
assert.strictEqual(meta.infoHash, wantHash); assert.strictEqual(meta.name, 'test.bin'); assert.strictEqual(meta.size, 12345);
assert.throws(() => Q.parseTorrent(Buffer.from('not a torrent')));
console.log('ok  torrent parse + info-hash');

assert.strictEqual(Q.mapState('downloading'), 'DOWNLOADING');
assert.strictEqual(Q.mapState('metaDL'), 'DOWNLOADING');
assert.strictEqual(Q.mapState('stoppedDL'), 'PAUSED');
assert.strictEqual(Q.mapState('stalledUP'), 'COMPLETED');
assert.strictEqual(Q.mapState('error'), 'FAILED');
console.log('ok  state mapping');

const calls = [];
const srv = http.createServer((req, res) => {
  let body = []; req.on('data', c => body.push(c)); req.on('end', () => {
    const b = Buffer.concat(body); calls.push(`${req.method} ${req.url}`);
    if (req.url === '/api/v2/auth/login') {
      const ok = /password=secret/.test(b.toString());
      res.writeHead(200, ok ? { 'Set-Cookie': 'SID=abc123; HttpOnly; path=/' } : {}); return res.end(ok ? 'Ok.' : 'Fails.');
    }
    if (!/SID=abc123/.test(req.headers.cookie || '')) { res.writeHead(403); return res.end('Forbidden'); }
    if (req.url === '/api/v2/app/version') return res.end('v5.0.1');
    if (req.url === '/api/v2/torrents/add') {
      const t = b.toString('latin1'); calls.push(/name="urls"/.test(t) ? 'ADD magnet' : /name="torrents"/.test(t) ? 'ADD file' : 'ADD ?');
      return res.end(/savepath/.test(t) ? 'Ok.' : 'Fails.');
    }
    if (req.url.startsWith('/api/v2/torrents/info')) return res.end(JSON.stringify([{ hash: 'abc', state: 'downloading', size: 100, downloaded: 40, dlspeed: 5, eta: 12, name: 'x' }]));
    if (req.url === '/api/v2/torrents/stop') { res.writeHead(404); return res.end(); } // v4 server: falls back to pause
    if (req.url === '/api/v2/torrents/pause') return res.end();
    res.writeHead(404); res.end();
  });
});

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const cfg = { qbitUrl: url, qbitUser: 'admin', qbitPass: 'secret' };
  const c = Q.createClient(() => cfg);
  assert.strictEqual(await c.version(), 'v5.0.1'); console.log('ok  login + version');
  await c.addMagnet('magnet:?xt=urn:btih:' + 'a'.repeat(40), 'D:\\dl');
  await c.addTorrentFile('x.torrent', torrent, 'D:\\dl');
  assert(calls.includes('ADD magnet') && calls.includes('ADD file')); console.log('ok  add magnet + .torrent upload');
  const info = await c.info(['ABC']); assert.strictEqual(info[0].downloaded, 40); console.log('ok  info');
  await c.pause('ABC'); assert(calls.includes('POST /api/v2/torrents/pause')); console.log('ok  pause fallback (stop→pause)');
  const bad = Q.createClient(() => ({ ...cfg, qbitPass: 'wrong' }));
  await assert.rejects(() => bad.version(), e => e.code === 'QBIT_AUTH'); console.log('ok  bad password');
  const down = Q.createClient(() => ({ ...cfg, qbitUrl: 'http://127.0.0.1:1' }));
  await assert.rejects(() => down.version(), e => e.code === 'QBIT_UNREACHABLE'); console.log('ok  unreachable');
  srv.close(); console.log('ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
