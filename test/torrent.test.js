'use strict';
// Built-in torrent engine test: local seeder (no DHT/trackers) → torrent.js leecher via .torrent buffer and via magnet.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const T = require('../torrent');

const wait = (cond, ms, label) => new Promise((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => { try { if (cond()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout: ' + label)); } } catch (e) { clearInterval(i); rej(e); } }, 100);
});

(async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, tracker: false });
  const data = crypto.randomBytes(3 * 1024 * 1024 + 77);
  const file = Object.assign(Buffer.from(data), { name: 'seed.bin' });
  const st = await new Promise(res => seeder.seed(file, { name: 'seed.bin', announce: [] }, res));
  await wait(() => seeder.torrentPort, 5000, 'seeder port');
  const peer = `127.0.0.1:${seeder.torrentPort}`;
  const want = crypto.createHash('sha256').update(data).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2lbt-'));

  for (const mode of ['torrent', 'magnet']) {
    const out = path.join(dir, mode); fs.mkdirSync(out);
    const source = mode === 'torrent' ? Buffer.from(st.torrentFile) : `magnet:?xt=urn:btih:${st.infoHash}`;
    let err = null;
    const t = await T.start(source, st.infoHash, out, e => { err = e; });
    await wait(() => t.infoHash, 5000, 'infohash'); t.addPeer(peer);
    await wait(() => { if (err) throw err; return T.snapshot(t).done; }, 30000, mode + ' download');
    const s = T.snapshot(t); assert.strictEqual(s.length, data.length); assert.strictEqual(s.name, 'seed.bin');
    await T.stop(st.infoHash, false);
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'seed.bin'))).digest('hex');
    assert.strictEqual(got, want); console.log(`ok  built-in engine downloads via ${mode}, byte-exact`);
  }
  // delete-files stop removes data
  const out = path.join(dir, 'del'); fs.mkdirSync(out);
  const t = await T.start(Buffer.from(st.torrentFile), st.infoHash, out, () => {});
  await wait(() => t.infoHash, 5000, 'infohash'); t.addPeer(peer);
  await wait(() => T.snapshot(t).done, 30000, 'del download');
  await T.stop(st.infoHash, true);
  assert(!fs.existsSync(path.join(out, 'seed.bin'))); console.log('ok  stop + delete files');
  await T.shutdown(); await new Promise(r => seeder.destroy(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL PASS'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
