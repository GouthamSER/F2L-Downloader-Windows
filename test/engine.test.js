'use strict';
// Self-contained engine test: local HTTP server (with/without Range support), checks byte-exact output, resume, fallback, magnet parsing.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const E = require('../engine');

const DATA = crypto.randomBytes(5 * 1024 * 1024 + 123);
const HASH = crypto.createHash('sha256').update(DATA).digest('hex');
let rangeHits = 0;

const server = http.createServer((req, res) => {
  const url = req.url;
  const noRange = url.startsWith('/norange');
  const slow = url.startsWith('/slow');
  if (url.startsWith('/missing')) { res.writeHead(404); return res.end(); }
  const hdr = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="my file.bin"' };
  if (!noRange) hdr['Accept-Ranges'] = 'bytes';
  if (req.method === 'HEAD') { res.writeHead(200, { ...hdr, 'Content-Length': DATA.length }); return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m && !noRange) {
    rangeHits++;
    const s = +m[1], e = m[2] ? +m[2] : DATA.length - 1;
    res.writeHead(206, { ...hdr, 'Content-Range': `bytes ${s}-${e}/${DATA.length}`, 'Content-Length': e - s + 1 });
    if (slow) { // trickle so we can pause mid-way
      let p = s; const iv = setInterval(() => { if (p > e) { clearInterval(iv); return res.end(); } res.write(DATA.subarray(p, Math.min(p + 16 * 1024, e + 1))); p += 16 * 1024; }, 30);
      req.on('close', () => clearInterval(iv));
      return;
    }
    return res.end(DATA.subarray(s, e + 1));
  }
  res.writeHead(200, { ...hdr, 'Content-Length': DATA.length });
  res.end(DATA);
});

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2l-'));
  const mk = (p, extra = {}) => ({ url: base + p, fileName: 'out.bin', folder: dir, connections: 8, ...extra });
  const noop = () => {};

  // 1. segmented, 8 connections
  let it = mk('/file');
  await E.download(it, { signal: new AbortController().signal, onProgress: noop });
  assert.strictEqual(sha(path.join(dir, 'out.bin')), HASH); assert(rangeHits >= 8, 'used ranges');
  console.log('ok  segmented 8x, sha matches, range hits =', rangeHits);

  // 2. server without Range -> single connection
  fs.rmSync(path.join(dir, 'out.bin'));
  it = mk('/norange');
  await E.download(it, { signal: new AbortController().signal, onProgress: noop });
  assert.strictEqual(sha(path.join(dir, 'out.bin')), HASH);
  console.log('ok  single-connection fallback');

  // 3. pause mid-way then resume (segmented)
  fs.rmSync(path.join(dir, 'out.bin'));
  it = mk('/slow');
  const ac = new AbortController();
  const p = E.download(it, { signal: ac.signal, onProgress: noop });
  await new Promise(r => setTimeout(r, 300)); ac.abort();
  await p.then(() => assert.fail('should abort'), e => assert(e.name === 'AbortError' || /abort/i.test(e.message), 'abort err: ' + e.message));
  const partial = it.segs.reduce((a, s) => a + s.d, 0);
  assert(partial > 0 && partial < DATA.length, 'partial progress kept: ' + partial);
  await E.download(it, { signal: new AbortController().signal, onProgress: noop });
  assert.strictEqual(sha(path.join(dir, 'out.bin')), HASH);
  console.log('ok  pause + resume, kept', partial, 'bytes');

  // 4. HTTP error
  await assert.rejects(E.download(mk('/missing'), { signal: new AbortController().signal, onProgress: noop }), e => e.fatal && /404/.test(e.message));
  console.log('ok  404 fatal error');

  // 5. name resolution + magnet parsing + misc
  assert.strictEqual(await E.resolveFileName(base + '/file'), 'my file.bin');
  const m = E.parseMagnetUri('magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Test%20Movie&tr=udp%3A%2F%2Ft.example%3A80');
  assert.strictEqual(m.infoHash, 'C12FE1C06BBA254A9DC9F519B335AA7C1367A88A'); assert.strictEqual(m.displayName, 'Test Movie'); assert.strictEqual(m.trackers.length, 1);
  assert.strictEqual(E.parseMagnetUri('magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U').infoHash.length, 40);
  assert.deepStrictEqual(E.extractUrls('a https://x.com/a.zip b\nmagnet:?xt=urn:btih:abc ftp://no'), ['https://x.com/a.zip', 'magnet:?xt=urn:btih:abc']);
  assert.strictEqual(E.sanitizeName('a<b>:c?.txt'), 'a_b__c_.txt'); assert.strictEqual(E.sanitizeName('CON.txt'), '_CON.txt');
  console.log('ok  name/magnet/url helpers');

  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
