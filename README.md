# Resonance

A local-first, high-quality music player for Windows, built with Electron.

## Features

- Plays your local library (FLAC, WAV, AIFF, MP3, OGG, Opus, M4A, AAC) with
  full metadata, lossless/bit-depth/sample-rate info, and embedded artwork.
- Playlists, favorites, play history and stats.
- Drag-and-drop playlist reordering, and multi-select (bulk favorite, queue,
  add to playlist, remove, delete) across song lists, search, and
  album/artist/genre/playlist grids.
- Optional YouTube import (via `yt-dlp`) to pull in playlists you don't have
  locally.
- Synced lyrics, romanization for Japanese/Korean/Chinese lyrics, a
  detachable mini-player, media key support, and a system tray/notification
  integration.
- Auto-updates itself once installed (see "Publishing an update" below).

## Running it in development

```
npm install
npm start
```

## Building

- `build-exe.bat` — a portable single-file `.exe`. No install, no
  auto-update; good for quick testing or a USB copy.
- `build-installer.bat` — a proper Windows installer (`Setup.exe`). This is
  the one to use if you want the app to auto-update itself later.

Both scripts handle installing Node.js and downloading `yt-dlp` for you if
they're missing — just double-click and follow the prompts.

## Publishing an update (so installed copies auto-update)

One-time setup:

1. Push this repo to your own GitHub account.
2. In `package.json`, under `"build" → "publish"`, set `owner` and `repo` to
   your GitHub username and repo name.
3. Create a GitHub Personal Access Token with `repo` scope (GitHub →
   Settings → Developer settings → Personal access tokens). Don't commit
   this token anywhere — `release.bat` only asks for it at run time.
4. Install the app via `build-installer.bat`'s `Setup.exe` on every machine
   you want to keep in sync — auto-update only works for an installed copy,
   not the portable `.exe`.

From then on, whenever you want to ship a change: run `release.bat`, choose
a version bump (patch/minor/major), and paste your token when asked. It
builds the installer and uploads it as a new GitHub Release. Every
installed copy picks it up next time it's opened (or within a few hours if
left running) — no need for both machines to be online at the same time.

## License

MIT — see [LICENSE](LICENSE).
