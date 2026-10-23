# F2L Downloader — Windows

Desktop port of the F2L Downloader Android app (v3.5.0). Same logic, native Windows `.exe`.

## Screenshots

<p align="center">
  <a href="https://ibb.co/s9P6MZ17"><img src="https://i.ibb.co/4RfY5HSk/f2lpc1.png" alt="F2L Downloader for Windows — downloads list" width="48%"></a>
  <a href="https://ibb.co/SDw1WX1v"><img src="https://i.ibb.co/rK2LTGLy/f2lpc2.png" alt="F2L Downloader for Windows — details view" width="48%"></a>
  <a href="https://ibb.co/wZqVSd5j"><img src="https://i.ibb.co/dsvFPf8x/f2lpc3.png" alt="f2lpc3" border="0" width="48%"></a>
</p>

## Features

- Multi-threaded segmented downloads (1–16 connections) over HTTP Range, auto fallback to a single connection
- Pause / resume (progress survives app restarts), auto-retry with back-off, stall detection (30 s)
- Batch import: paste many links, clipboard, `.txt` / `.m3u`, drag & drop
- qBittorrent: magnets and `.torrent` files (drag & drop, file picker, double-click) go to qBittorrent via its Web UI API, with live progress, pause/resume/remove synced. Without Web UI, `.torrent` files open in your default torrent app
- Magnet links: info-hash parsing (hex + base32), `.torrent` fetched from public caches, else a `.magnet` shortcut
- Custom User-Agent presets, Referer, arbitrary headers / cookies
- File name from `Content-Disposition`, Windows-safe names, duplicate-safe naming
- Queue with simultaneous-download limit, taskbar progress, notifications, light/dark theme
- Live speed sparkline + detail chart with per-connection progress

## Run / build
```
npm install
npm start          # run
npm test           # engine tests (local range server)
npm run dist       # needs Windows (or CI): installer + portable .exe in dist/
```
Push to GitHub: `.github/workflows/build-windows.yml` builds the installer and portable `.exe` on `windows-latest`; tag `v*` attaches them to a Release.
