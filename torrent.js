'use strict';
// Built-in torrent engine (WebTorrent). Loaded lazily; webtorrent is ESM-only so it is imported dynamically.
let client = null, loading = null;

async function getClient() {
  if (client) return client;
  if (!loading) {
    loading = import('webtorrent').then(m => {
      const WebTorrent = m.default || m.WebTorrent;
      const c = new WebTorrent({ utp: false });
      c.on('error', e => console.error('webtorrent:', e && e.message));
      client = c; return c;
    }).catch(e => { loading = null; throw new Error(`Built-in torrent engine failed to load (${e.message}). Reinstall F2L or enable qBittorrent in Settings.`); });
  }
  return loading;
}

// source: magnet string or .torrent Buffer. hash: info-hash (hex, any case).
async function start(source, hash, folder, onError) {
  const c = await getClient();
  const existing = await c.get(hash.toLowerCase());
  if (existing) return existing;
  const t = c.add(source, { path: folder });
  t.on('error', e => onError && onError(e));
  t.on('warning', () => {});
  return t;
}

async function stop(hash, deleteFiles) {
  if (!client) return;
  const t = await client.get(hash.toLowerCase());
  if (!t) return;
  await new Promise(res => t.destroy({ destroyStore: !!deleteFiles }, () => res()));
}

function snapshot(t) {
  const eta = Number.isFinite(t.timeRemaining) ? Math.round(t.timeRemaining / 1000) : -1;
  return { ready: !!t.ready, name: t.name, length: t.length || 0, downloaded: t.downloaded || 0, speed: t.downloadSpeed || 0, eta, peers: t.numPeers || 0, done: !!t.done, path: t.path };
}

async function shutdown() {
  if (!client) return;
  await new Promise(res => client.destroy(() => res()));
  client = null; loading = null;
}

module.exports = { start, stop, snapshot, shutdown };
