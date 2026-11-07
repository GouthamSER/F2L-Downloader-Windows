'use strict';
// YouTube module test with a fake yt-dlp (no network): URL cleanup, quality list, format args, info, progress, abort, errors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2lyt-'));
const fake = path.join(dir, process.platform === 'win32' ? 'fake-yt.cmd' : 'fake-yt');
const impl = path.join(dir, 'fake-impl.js');
fs.writeFileSync(impl, `
const fs = require('fs'); const a = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'fail') { console.error('ERROR: [youtube] abc: Private video. Sign in if you\\'ve been granted access to this video'); process.exit(1); }
if (a.includes('-J')) {
  const f = (id, h, v, ac, size, ext, extra) => Object.assign({ format_id: id, height: h, vcodec: v, acodec: ac, filesize: size, ext, tbr: size / 1000 }, extra || {});
  console.log(JSON.stringify({ id: 'abc', title: 'My: Test/Video', uploader: 'Chan', duration: 125, thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', formats: [
    f('sb0', 90, 'none', 'none', 0, 'mhtml', { format_note: 'storyboard', protocol: 'mhtml' }),
    f('136', 720, 'avc1', 'none', 5000000, 'mp4'), f('137', 1080, 'avc1', 'none', 9000000, 'mp4'), f('248', 1080, 'vp9', 'none', 7000000, 'webm'),
    f('313', 2160, 'vp9', 'none', 40000000, 'webm'), f('18', 360, 'avc1', 'mp4a', 3000000, 'mp4'),
    f('140', null, 'none', 'mp4a', 1000000, 'm4a', { abr: 128 }), f('251', null, 'none', 'opus', 900000, 'webm', { abr: 160 })
  ] }));
  process.exit(0);
}
const out = a[a.indexOf('-o') + 1].replace('%(ext)s', a.includes('mp3') ? 'mp3' : 'mp4');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  console.log('F2LP 0 1000 NA NA');
  console.log('F2LP 500 1000 NA 1000');
  console.log('F2LP 1000 1000 NA 1000');
  if (mode === 'slow') await sleep(60000);
  console.log('F2LP 100 400 NA 800');       // second stream: counter reset
  console.log('F2LP 400 400 NA 800');
  console.log('[Merger] Merging formats into "x"');
  fs.writeFileSync(out, Buffer.alloc(1400));
  console.log('F2LF ' + out);
})();
`);
if (process.platform === 'win32') fs.writeFileSync(fake, `@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\n"${process.execPath}" "${impl}" %*\r\n`);
else { fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`); fs.chmodSync(fake, 0o755); }
process.env.F2L_YTDLP = fake;
process.env.F2L_FFMPEG = path.join(dir, 'ffmpeg-missing');
const yt = require('../youtube');

(async () => {
  // URL helpers
  assert.ok(yt.isYoutube('https://www.youtube.com/watch?v=abc'));
  assert.ok(yt.isYoutube('https://youtu.be/abc'));
  assert.ok(yt.isYoutube('https://music.youtube.com/watch?v=abc'));
  assert.ok(!yt.isYoutube('https://example.com/watch?v=abc'));
  assert.ok(!yt.isYoutube('https://notyoutube.com/x'));
  assert.strictEqual(yt.cleanUrl('https://www.youtube.com/watch?v=abc&list=PL123&index=2'), 'https://www.youtube.com/watch?v=abc');
  assert.strictEqual(yt.cleanUrl('https://youtu.be/abc?si=zzz'), 'https://www.youtube.com/watch?v=abc');
  assert.strictEqual(yt.cleanUrl('https://www.youtube.com/shorts/abcdefghij1'), 'https://www.youtube.com/watch?v=abcdefghij1');

  // format args
  assert.ok(yt.formatArgs('720').join(' ').includes('bv*[height<=720]+ba/b[height<=720]'));
  assert.ok(yt.formatArgs('720').join(' ').includes('res,vcodec:h264,acodec:aac'));
  assert.deepStrictEqual(yt.formatArgs('mp3-192').slice(-2), ['--audio-quality', '192K']);
  assert.ok(yt.formatArgs('mp3').includes('320K'), 'legacy mp3 id');
  assert.ok(yt.formatArgs('m4a').includes('m4a'));
  assert.ok(yt.isAudioQ('mp3-128') && yt.isAudioQ('m4a') && !yt.isAudioQ('1080'));
  assert.strictEqual(yt.audioExt('mp3-320'), 'mp3');

  // info + quality list
  const info = await yt.getInfo('https://www.youtube.com/watch?v=abc&list=x');
  assert.strictEqual(info.title, 'My: Test/Video');
  assert.strictEqual(info.url, 'https://www.youtube.com/watch?v=abc');
  assert.deepStrictEqual(info.options.map(o => o.id), ['2160', '1080', '720', '360', 'mp3-320', 'mp3-192', 'mp3-128', 'm4a']);
  const o1080 = info.options.find(o => o.id === '1080');
  assert.strictEqual(o1080.bytes, 9000000 + 1000000, 'largest stream at that height + best audio');
  assert.strictEqual(info.options.find(o => o.id === 'm4a').bytes, 1000000, 'm4a option uses the m4a stream');
  assert.strictEqual(info.options.find(o => o.id === 'mp3-320').bytes, 5000000, 'mp3 size = duration × bitrate (125 s × 320 kbps)');

  // download progress, stream offset, finalizing, final path
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'f2lytout-'));
  const seen = [];
  const item = { url: info.url, folder, ytStem: 'My_ Test_Video', ytQuality: '1080', ytExpected: 1400, connections: 4 };
  const ac = new AbortController();
  const fp = await yt.run(item, { signal: ac.signal, onProgress: p => seen.push(p) });
  assert.strictEqual(fp, path.join(folder, 'My_ Test_Video.mp4'));
  assert.strictEqual(fs.statSync(fp).size, 1400);
  assert.ok(seen.some(p => p.downloaded === 1000 && p.total === 1400), 'first stream complete');
  assert.ok(seen.some(p => p.downloaded === 1400), 'offset applied for second stream: ' + JSON.stringify(seen));
  assert.ok(seen.some(p => p.speed === -1), 'finalizing state');

  // abort kills process and rejects "aborted"
  process.env.FAKE_MODE = 'slow';
  const ac2 = new AbortController();
  const t0 = Date.now();
  const pr = yt.run({ ...item, ytStem: 'slow' }, { signal: ac2.signal, onProgress: () => {} });
  setTimeout(() => ac2.abort(), 500);
  await assert.rejects(pr, /aborted/);
  assert.ok(Date.now() - t0 < 8000, 'abort is fast');

  // friendly + fatal error
  process.env.FAKE_MODE = 'fail';
  await assert.rejects(yt.getInfo('https://www.youtube.com/watch?v=abc'), e => e.yt && e.fatal && /private/i.test(e.message));
  delete process.env.FAKE_MODE;

  // partial cleanup
  fs.writeFileSync(path.join(folder, 'vid.f137.mp4.part'), 'x'); fs.writeFileSync(path.join(folder, 'vid.mp4.ytdl'), 'x'); fs.writeFileSync(path.join(folder, 'vid.mp4'), 'x');
  await yt.cleanPartials(folder, 'vid');
  assert.deepStrictEqual(fs.readdirSync(folder).filter(n => n.startsWith('vid')), ['vid.mp4']);

  console.log('youtube tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
