# F2L Downloader — Windows

Desktop port of the F2L Downloader Android app (v3.4.1). Same logic, native Windows `.exe`.

- Multi-threaded segmented downloads (1–16 connections) over HTTP Range, auto fallback to a single connection
- Pause / resume (progress survives app restarts), auto-retry with back-off, stall detection (30 s)
- Batch import: paste many links, clipboard, `.txt` / `.m3u`, drag & drop
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
