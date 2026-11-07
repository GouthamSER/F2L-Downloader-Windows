'use strict';
// YouTube (and other yt-dlp supported sites) support.
// yt-dlp is fetched once into userData/bin and refreshed every few days (YouTube changes often).
// ffmpeg comes from the bundled ffmpeg-static package (merging video+audio, MP3 conversion).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WIN = process.platform === 'win32';
const ASSET = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const BIN_NAME = WIN ? 'yt-dlp.exe' : 'yt-dlp';
const DL_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;
const MAX_AGE = 3 * 24 * 3600 * 1000;

let binDir = null;
const init = dir => { binDir = dir; };
const binPath = () => process.env.F2L_YTDLP || path.join(binDir, BIN_NAME);

function ffmpegPath() {
  if (process.env.F2L_FFMPEG) return process.env.F2L_FFMPEG;
  try {
    const p = require('ffmpeg-static');
    return p ? p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : null;
  } catch { return null; }
}

// ---------- URL helpers ----------
const YT_RE = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;
const isYoutube = u => YT_RE.test(String(u || '').trim());

/** Reduce a YouTube URL to the single video (drops playlist / radio params). */
function cleanUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (/youtu\.be$/i.test(x.hostname)) return `https://www.youtube.com/watch?v=${x.pathname.slice(1).split('/')[0]}`;
    if (x.searchParams.get('v')) return `https://www.youtube.com/watch?v=${x.searchParams.get('v')}`;
    const m = x.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
    if (m) return `https://www.youtube.com/watch?v=${m[2]}`;
    return x.toString();
  } catch { return String(u).trim(); }
}

// ---------- yt-dlp binary ----------
let ensuring = null;
async function download(file, onPct) {
  const r = await fetch(DL_URL, { redirect: 'follow', headers: { 'User-Agent': 'F2LDownloaderDesktop' } });
  if (!r.ok) throw new Error(`Could not download the YouTube engine (HTTP ${r.status}).`);
  const total = +r.headers.get('content-length') || 0;
  const tmp = file + '.tmp';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      if (total && onPct) onPct(Math.round(got * 100 / total));
    }
    await new Promise((res, rej) => out.end(e => e ? rej(e) : res()));
  } catch (e) { out.destroy(); await fs.promises.rm(tmp, { force: true }); throw e; }
  if (got < 1_000_000) { await fs.promises.rm(tmp, { force: true }); throw new Error('YouTube engine download was incomplete.'); }
  await fs.promises.rename(tmp, file);
  if (!WIN) await fs.promises.chmod(file, 0o755);
}

/** Make sure yt-dlp exists and is fresh. Never throws if an older copy is usable. */
function ensure(onPct, force) {
  if (process.env.F2L_YTDLP) return Promise.resolve(binPath());
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const file = binPath();
    const st = await fs.promises.stat(file).catch(() => null);
    if (st && !force && Date.now() - st.mtimeMs < MAX_AGE) return file;
    try { await download(file, onPct); }
    catch (e) { if (!st) throw e; /* keep the old binary */ }
    return file;
  })().finally(() => { ensuring = null; });
  return ensuring;
}

// ---------- spawn ----------
function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--no-colors', '--newline', '--ignore-config', '--encoding', 'utf-8'];
  const ff = ffmpegPath(); if (ff) a.push('--ffmpeg-location', ff);
  if (!process.env.F2L_YTDLP) a.push('--js-runtimes', `node:${process.execPath}`); // YouTube signature solving via Electron's Node
  return a;
}
const env = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' });

function ytError(stderr, code) {
  const t = String(stderr || '').trim().split(/\r?\n/).filter(l => /ERROR/i.test(l)).pop() || String(stderr || '').trim().split(/\r?\n/).pop() || `yt-dlp exited with code ${code}`;
  const m = t.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').trim();
  let msg = m;
  if (/Sign in to confirm|not a bot/i.test(m)) msg = 'YouTube asked to confirm you are not a bot. Try again later, or switch networks / VPN.';
  else if (/Private video|members-only|Join this channel/i.test(m)) msg = 'This video is private or members-only.';
  else if (/Video unavailable|has been removed|no longer available/i.test(m)) msg = 'This video is unavailable or was removed.';
  else if (/age|confirm your age/i.test(m) && /restrict|inappropriate|confirm/i.test(m)) msg = 'This video is age-restricted and cannot be downloaded without signing in.';
  else if (/not available in your country|blocked it in your country|geo/i.test(m)) msg = 'This video is blocked in your country.';
  else if (/Unsupported URL/i.test(m)) msg = 'This link is not a supported video page.';
  else if (/Requested format is not available/i.test(m)) msg = 'That quality is not available for this video. Pick another quality.';
  const e = new Error(msg); e.yt = true; e.fatal = /private|members|removed|unavailable|age-restricted|blocked|not a supported|quality is not/i.test(msg);
  return e;
}

// Most YouTube errors are fixed by a newer yt-dlp: on a non-fatal failure refresh once and retry (like the Android app).
let lastForce = 0;
async function withUpdate(fn, signal) {
  try { return await fn(); }
  catch (e) {
    if ((signal && signal.aborted) || (e && e.fatal) || Date.now() - lastForce < 10 * 60 * 1000 || process.env.F2L_YTDLP && !process.env.F2L_FORCE_UPDATE_TEST) throw e;
    lastForce = Date.now();
    try { await ensure(null, true); } catch { throw e; }
    return fn();
  }
}

// ---------- info ----------
const pickBest = (fmts, pred, key) => fmts.filter(pred).sort(key)[0];

/** Quality list like the Android app: every video height + MP3 320/192/128 + M4A. */
function buildOptions(info) {
  const dur = info.duration || 0;
  const size = f => {
    let n = f.filesize || f.filesize_approx || 0;
    if (!n && dur && f.tbr) n = Math.round(f.tbr * 1000 / 8 * dur);
    return n;
  };
  const fmts = (info.formats || []).filter(f => f && f.format_id && f.protocol !== 'mhtml' && !/storyboard/i.test(f.format_note || ''));
  const byH = new Map();
  let bestAudio = 0, m4aAudio = 0;
  for (const f of fmts) {
    const hasV = f.vcodec && f.vcodec !== 'none', hasA = f.acodec && f.acodec !== 'none';
    if (hasV && f.height > 0) byH.set(f.height, Math.max(byH.get(f.height) || 0, size(f)));
    else if (!hasV && hasA) { bestAudio = Math.max(bestAudio, size(f)); if (f.ext === 'm4a') m4aAudio = Math.max(m4aAudio, size(f)); }
  }
  const out = [...byH.entries()].sort((x, y) => y[0] - x[0]).map(([h, sz]) => ({
    id: String(h), kind: 'video', height: h, label: `${h}p${h >= 2160 ? ' 4K' : h >= 1440 ? ' 2K' : h >= 1080 ? ' HD' : ''}`, bytes: sz > 0 ? sz + bestAudio : 0
  }));
  if (!out.length) out.push({ id: 'best', kind: 'video', height: 0, label: 'Best available', bytes: 0 });
  const abase = bestAudio || (dur ? dur * 16000 : 0);
  for (const k of [320, 192, 128]) out.push({ id: `mp3-${k}`, kind: 'audio', ext: 'mp3', label: `MP3 ${k} kbps`, bytes: dur ? Math.round(dur * k * 1000 / 8) : abase });
  out.push({ id: 'm4a', kind: 'audio', ext: 'm4a', label: 'M4A (original, no re-encode)', bytes: m4aAudio || abase });
  return out;
}

async function getInfo(url, onPct) {
  const args = [...baseArgs(), '-J', '--skip-download', cleanUrl(url)];
  const j = await withUpdate(async () => {
    const bin = await ensure(onPct);
    const { stdout, stderr, code } = await collect(bin, args, 90_000);
    if (code !== 0) throw ytError(stderr, code);
    try { return JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { throw new Error('Could not read video info from YouTube.'); }
  });
  return {
    url: cleanUrl(url), id: j.id, title: j.title || 'video', channel: j.uploader || j.channel || '',
    duration: j.duration || 0, thumbnail: j.thumbnail || '', live: !!j.is_live,
    options: buildOptions(j)
  };
}

// Test hook: F2L_YTDLP_SCRIPT runs a fake yt-dlp through node (Windows cannot spawn .cmd files directly).
function launch(bin, args, opts) {
  const script = process.env.F2L_YTDLP_SCRIPT;
  return script ? spawn(process.execPath, [script, ...args], opts) : spawn(bin, args, opts);
}

function collect(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = launch(bin, args, { env: env(), windowsHide: true });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('Timed out while contacting YouTube. Check your connection and try again.')); }, timeoutMs);
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); resolve({ stdout, stderr, code }); });
  });
}

// ---------- download ----------
/** yt-dlp args for an option id from buildOptions(): <height> | best | mp3-<kbps> | m4a (same selectors as the Android app). */
function formatArgs(q) {
  q = String(q || 'best');
  if (q === 'mp3') q = 'mp3-320'; // settings saved by v3.7.0 test builds
  const mp3 = q.match(/^mp3-(\d+)$/);
  if (mp3) return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', `${mp3[1]}K`];
  if (q === 'm4a') return ['-f', 'ba[ext=m4a]/bestaudio/best', '-x', '--audio-format', 'm4a'];
  const h = parseInt(q, 10);
  const sel = h ? `bv*[height<=${h}]+ba/b[height<=${h}]` : 'bv*+ba/b';
  return ['-f', sel, '-S', 'res,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4'];
}

const isAudioQ = q => /^(mp3|m4a)/.test(String(q || ''));
const audioExt = q => String(q).startsWith('mp3') ? 'mp3' : 'm4a';

const PREFIX = 'F2LP';
const PROGRESS_TPL = `download:${PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s`;

/**
 * item: { url, folder, ytStem, ytQuality, ytExpected }
 * Resolves with the final absolute file path. Rejects on failure; abort via signal kills yt-dlp (partials stay for resume).
 */
function run(item, o) { return withUpdate(() => runOnce(item, o), o.signal); }

async function runOnce(item, { signal, onProgress }) {
  const bin = await ensure();
  const args = [
    ...baseArgs(), ...formatArgs(item.ytQuality),
    '--continue', '--no-overwrites', '--no-mtime', '--concurrent-fragments', String(Math.min(Math.max(item.connections || 4, 1), 16)),
    '--progress', '--progress-template', PROGRESS_TPL, '--print', 'after_move:F2LF %(filepath)s',
    '-o', path.join(item.folder, item.ytStem + '.%(ext)s'),
    item.url
  ];
  return new Promise((resolve, reject) => {
    const p = launch(bin, args, { env: env(), windowsHide: true, cwd: item.folder });
    let stderr = '', final = null, buf = '', offset = 0, lastDl = 0, lastTotal = 0, post = false;
    const onAbort = () => { try { p.kill(); } catch { /* gone */ } };
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    const line = l => {
      l = l.trim(); if (!l) return;
      if (l.startsWith(PREFIX + ' ')) {
        const [, d, t, te, s] = l.split(/\s+/);
        const dl = +d || 0, tot = +t || +te || 0, speed = +s || 0;
        if (dl < lastDl) offset += lastTotal || lastDl; // next stream (audio after video) started
        lastDl = dl; lastTotal = tot || dl;
        const total = item.ytExpected > 0 ? Math.max(item.ytExpected, offset + tot) : 0;
        post = false;
        onProgress({ downloaded: offset + dl, total, speed });
      } else if (l.startsWith('F2LF ')) final = l.slice(5).trim();
      else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup\w*|MoveFiles)\]/.test(l) && !post) { post = true; onProgress({ downloaded: offset + lastDl, total: 0, speed: -1 }); }
    };
    p.stdout.on('data', d => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(line); });
    p.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    p.on('error', e => { signal.removeEventListener('abort', onAbort); reject(e); });
    p.on('close', code => {
      signal.removeEventListener('abort', onAbort);
      if (buf) line(buf);
      if (signal.aborted) return reject(new Error('aborted'));
      if (code === 0 && final) return resolve(final);
      if (code === 0) return reject(new Error('Download finished but the file was not found.'));
      reject(ytError(stderr, code));
    });
  });
}

/** Remove yt-dlp leftovers (.part, .ytdl, fragments) for a stem in a folder. */
async function cleanPartials(folder, stem) {
  let names = [];
  try { names = await fs.promises.readdir(folder); } catch { return; }
  await Promise.all(names.filter(n => n.startsWith(stem + '.') && /\.(part|ytdl|temp)(\b|$)|\.part-Frag\d+|\.f\d+\.\w+(\.part)?$/i.test(n))
    .map(n => fs.promises.rm(path.join(folder, n), { force: true }).catch(() => {})));
}

module.exports = { isAudioQ, audioExt, init, isYoutube, cleanUrl, ensure, getInfo, run, formatArgs, buildOptions, cleanPartials, ytError, binPath, ffmpegPath };
