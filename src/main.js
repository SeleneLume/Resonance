const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, globalShortcut, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const http = require('http');
const mm = require('music-metadata');
const taglib = require('node-taglib-sharp');

const SUPPORTED_EXT = new Set(['.flac', '.wav', '.aiff', '.aif', '.mp3', '.ogg', '.opus', '.m4a', '.aac']);

const userDataPath = () => app.getPath('userData');
const libraryFile = () => path.join(userDataPath(), 'library.json');
const settingsFile = () => path.join(userDataPath(), 'settings.json');

// yt-dlp ships bundled with the packaged app (see "extraResources" in
// package.json + build-exe.bat, which downloads it into tools/ before
// building) so end users never need it installed themselves.
function getYtDlpPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'yt-dlp.exe');
  }
  // Dev mode: use the local copy build-exe.bat downloads into tools/,
  // falling back to a system PATH install if that's what you're using.
  const localCopy = path.join(__dirname, '..', 'tools', 'yt-dlp.exe');
  return fs.existsSync(localCopy) ? localCopy : 'yt-dlp';
}

let mainWindow;
let miniWindow = null;
let rendererServerPort = null;

// Serves src/renderer/* over http://localhost instead of file://. YouTube's
// IFrame Player API rejects embeds whose page origin is file:// (shows up as
// "Video player configuration error" / Error 153), so the app needs a real
// http origin for the YouTube widget to work at all. It must be the hostname
// 'localhost', not the IP literal 127.0.0.1 — YouTube's origin/referrer check
// treats the two differently and rejects the IP form (shows up as error 150).
// Local files themselves are unaffected — audio/tracks are still loaded via
// file:// URLs in <audio>.
function startRendererServer() {
  const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const rendererDir = path.join(__dirname, 'renderer');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const resolved = path.normalize(path.join(rendererDir, reqPath));
      if (!resolved.startsWith(rendererDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(resolved, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    // Bind to the 'localhost' hostname rather than the bare IP literal
    // 127.0.0.1. YouTube's IFrame API origin/referer check appears to
    // distrust IP-literal hosts even on loopback, but accepts 'localhost'.
    server.listen(0, 'localhost', () => {
      rendererServerPort = server.address().port;
      resolve(rendererServerPort);
    });
  });
}

function createMiniWindow() {
  if (miniWindow) { miniWindow.show(); miniWindow.focus(); return; }
  miniWindow = new BrowserWindow({
    width: 360,
    height: 120,
    minWidth: 280,
    minHeight: 100,
    resizable: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0b10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Plain alwaysOnTop:true only puts the window in the "floating" z-order
  // band, which fullscreen apps/games and some other always-on-top windows
  // can still cover. 'screen-saver' is the highest band Electron exposes and
  // is what keeps the mini-player visible over literally anything else,
  // including other apps running in exclusive fullscreen.
  miniWindow.setAlwaysOnTop(true, 'screen-saver');
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  miniWindow.loadURL(`http://localhost:${rendererServerPort}/miniplayer.html`);
  miniWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) mainWindow.webContents.send('miniplayer:requestState');
  });
  miniWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[mini-renderer] ${message} (${sourceId}:${line})`);
  });
  miniWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('[mini-did-fail-load]', code, desc);
  });

  // Windows can occasionally hide a frameless always-on-top window on a
  // click inside its drag region (an OS/DWM quirk with HTCAPTION handling)
  // without ever firing a real close. Since the mini-player is never
  // intentionally hidden — only explicitly closed via the IPC handler below,
  // which nulls out `miniWindow` first — any 'hide' we see while the
  // reference is still live is that glitch, not a real close. Show it right
  // back instead of leaving the user wondering where it went. Same idea for
  // an accidental minimize.
  miniWindow.on('hide', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.show();
  });
  miniWindow.on('minimize', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.restore();
  });
  miniWindow.on('blur', () => {
    // Re-assert the top-most level after losing focus — some window
    // managers quietly demote a floating window's z-order on blur even
    // though alwaysOnTop technically never changed.
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  miniWindow.on('closed', () => {
    miniWindow = null;
    if (mainWindow) mainWindow.webContents.send('miniplayer:closed');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // The page now loads over http://localhost (needed for the YouTube embed's
      // origin check), but local tracks are still served as file:// URLs to the
      // <audio> elements. Chromium blocks file:// access from an http:// origin
      // by default, so it has to be relaxed here. The app never browses arbitrary
      // remote sites — the only remote content is the official youtube.com embed —
      // so the security trade-off is limited to that.
      webSecurity: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(`http://localhost:${rendererServerPort}/index.html`);
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('[did-fail-load]', code, desc);
  });

  // F11 = true OS-level fullscreen (same as a browser), toggled directly on the
  // BrowserWindow rather than via an application menu accelerator, since the
  // menu is removed above. Scoped to this window's own input rather than
  // globalShortcut so it only fires while Resonance is focused.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Let the renderer know whenever native fullscreen is entered/exited, no
  // matter what triggered it (our own IPC call, F11, or the OS), so it can
  // keep the immersive lyrics/now-playing overlays in sync with the real
  // window state instead of assuming they're the only way in or out.
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow) mainWindow.webContents.send('app:fullscreenChanged', true);
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow) mainWindow.webContents.send('app:fullscreenChanged', false);
  });
}

app.whenReady().then(async () => {
  await startRendererServer();
  createWindow();
  registerMediaKeys();
  if (app.isPackaged) setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- Auto-update ----------
// Lets a version you publish as a GitHub Release reach every installed copy
// automatically — like a Windows Store app updating itself — instead of
// having to manually rebuild and reinstall on each PC. Only runs in a
// packaged (installed) build: electron-updater has nothing to check
// against when running via `npm start`, and would just error there.
//
// One-time setup to actually turn this on:
//   1. Push this project to a GitHub repo.
//   2. In package.json's "build.publish", set "owner" and "repo" to yours.
//   3. Switch the Windows build target to "nsis" (an installer) instead of
//      "portable" — electron-updater's silent background updates only work
//      for an installed app, not a portable single-file exe.
//   4. To ship an update: bump "version" in package.json, then run
//      `npm run release:win` with a GH_TOKEN env var set (a GitHub
//      Personal Access Token with "repo" scope) — that builds the
//      installer and uploads it as a new GitHub Release. Every PC with the
//      app already installed will pick it up next time it's opened (or
//      within a few hours if left running).
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', info.version);
  });
  autoUpdater.on('error', (err) => {
    console.error('Auto-update check failed:', err == null ? 'unknown error' : (err.stack || err.message));
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // Long-running sessions (this is a music player, people leave it open)
  // won't otherwise notice a release that came out after launch.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

ipcMain.on('update:installNow', () => {
  autoUpdater.quitAndInstall();
});

// ---------- Persistence ----------
async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // No pretty-print indentation: for a library.json with thousands of
  // tracks this meaningfully cuts file size and serialize/write time.
  await fsp.writeFile(file, JSON.stringify(data), 'utf-8');
}

// ---------- Artwork dedup for storage ----------
// Every track on an album embeds the identical cover image. The renderer
// keeps that on each in-memory track object (harmless there — V8 shares one
// string instance across objects that got it from the same source), but
// writing it out that way is not harmless: library.json for a real local
// library balloons into hundreds of MB of literally repeated base64 text.
// That's what actually made the app "extremely laggy" — every save (a
// heart click, a playlist edit) blocks the main process on
// JSON.stringify-ing and writing that huge string, and startup blocks on
// parsing it back. Storing artwork once per album and hydrating it back
// onto tracks on load fixes this without the renderer needing to know the
// difference (it still just reads track.artworkDataUrl, same as before).
// This also happens to make library.json small enough to realistically
// sync between machines via Syncthing/Dropbox/etc.
function artworkKeyFor(t) {
  return `${t.albumArtist || t.artist || 'Unknown Artist'}||${t.album || 'Unknown Album'}`;
}

function dedupeArtworkForWrite(data) {
  if (!Array.isArray(data.tracks)) return data;
  const artwork = {};
  const tracks = data.tracks.map((t) => {
    if (!t.artworkDataUrl) return t;
    const key = artworkKeyFor(t);
    const { artworkDataUrl, ...rest } = t;
    if (!(key in artwork)) {
      artwork[key] = artworkDataUrl;
      rest.artworkKey = key;
    } else if (artwork[key] === artworkDataUrl) {
      rest.artworkKey = key;
    } else {
      // This track's art differs from the rest of its album (e.g. a
      // one-off metadata edit) — give it its own key rather than losing
      // the distinct image or overwriting the shared album entry.
      const ownKey = key + '#' + t.id;
      artwork[ownKey] = artworkDataUrl;
      rest.artworkKey = ownKey;
    }
    return rest;
  });
  return { ...data, tracks, artwork };
}

function hydrateArtworkForRead(data) {
  if (!data || !Array.isArray(data.tracks)) return data;
  const artwork = data.artwork || {};
  const tracks = data.tracks.map((t) => {
    if (t.artworkDataUrl || !t.artworkKey) return t; // already hydrated, or never had art
    const { artworkKey, ...rest } = t;
    return { ...rest, artworkDataUrl: artwork[artworkKey] || null };
  });
  return { ...data, tracks };
}

ipcMain.handle('store:loadLibrary', async () => {
  const data = await readJson(libraryFile(), { folders: [], tracks: [], playlists: [], favorites: { songs: [], albums: [], artists: [] }, stats: { playCounts: {}, history: [], totalMs: 0 } });
  return hydrateArtworkForRead(data);
});

ipcMain.handle('store:saveLibrary', async (evt, data) => {
  await writeJson(libraryFile(), dedupeArtworkForWrite(data));
  return true;
});

ipcMain.handle('store:loadSettings', async () => {
  return readJson(settingsFile(), { theme: 'dark', accent: '#8b5cf6', volume: 0.8, crossfadeMs: 0, gapless: true });
});

ipcMain.handle('store:saveSettings', async (evt, data) => {
  await writeJson(settingsFile(), data);
  return true;
});

// ---------- Folder picking & scanning ----------
ipcMain.handle('library:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXT.has(ext)) out.push(full);
    }
  }
}

function fmtBitDepth(format) {
  if (format.bitsPerSample) return format.bitsPerSample;
  return null;
}

// Embedded cover art comes straight off disk at whatever resolution the
// file was tagged with — often several MB per track for FLACs pulled from
// a CD rip. Storing that at full size, once per track, is what made
// library.json (and every IPC message and <img> carrying it) balloon for
// a big local library. Downscaling to a sane max dimension and
// re-encoding as JPEG cuts that down drastically with no visible loss for
// how the art is actually displayed (card thumbnails, the now-playing
// bar). Uses Electron's built-in nativeImage so no extra image library is
// needed.
function resizeArtwork(picture, maxDim = 500) {
  try {
    const buf = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width > maxDim || height > maxDim) {
      img = width >= height ? img.resize({ width: maxDim }) : img.resize({ height: maxDim });
    }
    return `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// Parses one file's tags into the track object the renderer expects.
// albumArtCache, when passed, is keyed by "albumArtist||album" — nearly
// every track on an album embeds the identical cover image, so without
// this a library scan would resize/re-encode the same picture once per
// track instead of once per album (the biggest single cost in a scan of
// a large library). Pass null for one-off re-reads (e.g. after editing a
// single track's metadata) where there's no batch to share a cache across.
async function buildTrackObject(filePath, albumArtCache) {
  const stat = await fsp.stat(filePath);
  const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
  const common = meta.common || {};
  const format = meta.format || {};
  const albumArtist = common.albumartist || common.artist || 'Unknown Artist';
  const album = common.album || 'Unknown Album';
  let artworkDataUrl = null;
  if (common.picture && common.picture.length > 0) {
    const cacheKey = `${albumArtist}||${album}`;
    if (albumArtCache && albumArtCache.has(cacheKey)) {
      artworkDataUrl = albumArtCache.get(cacheKey);
    } else {
      artworkDataUrl = resizeArtwork(common.picture[0]);
      if (albumArtCache) albumArtCache.set(cacheKey, artworkDataUrl);
    }
  }
  return {
    id: filePath,
    path: filePath,
    title: common.title || path.basename(filePath, path.extname(filePath)),
    artist: common.artist || 'Unknown Artist',
    albumArtist,
    album,
    genre: (common.genre && common.genre[0]) || null,
    year: common.year || null,
    track: (common.track && common.track.no) || null,
    disk: (common.disk && common.disk.no) || null,
    composer: (common.composer && common.composer[0]) || null,
    duration: format.duration || 0,
    format: (format.container || path.extname(filePath).slice(1)).toUpperCase(),
    codec: format.codec || null,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    sampleRate: format.sampleRate || null,
    bitDepth: fmtBitDepth(format),
    channels: format.numberOfChannels || null,
    lossless: format.lossless || ['FLAC', 'WAV', 'AIFF', 'AIF'].includes((format.container || '').toUpperCase()),
    fileSize: stat.size,
    artworkDataUrl,
    replayGainTrackDb: (common.replaygain_track_gain && typeof common.replaygain_track_gain.dB === 'number') ? common.replaygain_track_gain.dB : null,
    replayGainAlbumDb: (common.replaygain_album_gain && typeof common.replaygain_album_gain.dB === 'number') ? common.replaygain_album_gain.dB : null,
  };
}

// Runs `worker` over `items` with at most `limit` in flight at once —
// reading+decoding tags is mostly waiting on disk, not CPU, so a strict
// one-at-a-time loop left cores idle, while firing every file off at once
// (unbounded Promise.all) is exactly what made a big library scan feel
// like it froze the app, hammering disk I/O and CPU simultaneously. A
// small fixed pool keeps things moving without either extreme.
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function runNext() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

ipcMain.handle('library:scanFolders', async (evt, folders) => {
  const files = [];
  for (const folder of folders) {
    await walk(folder, files);
  }
  const tracks = new Array(files.length);
  const albumArtCache = new Map();
  let done = 0;
  await runWithConcurrency(files, 6, async (filePath, i) => {
    try {
      tracks[i] = await buildTrackObject(filePath, albumArtCache);
    } catch (e) {
      // skip unreadable file
    }
    done++;
    if (done % 10 === 0 || done === files.length) {
      mainWindow.webContents.send('library:scanProgress', { done, total: files.length });
    }
  });
  return tracks.filter(Boolean);
});

// ---------- Lyrics romanization (Japanese / Korean / Chinese) ----------
// Lets the person see romanized text under the original when the lyrics
// panel's romanization toggle is on. Japanese and Chinese need an actual
// dictionary/analyzer, since the same kanji/hanzi read differently depending
// on the word, so those go through bundled libraries; Korean's Hangul is
// regular enough that a plain algorithmic conversion works without one.
const HANGUL_RE = /[\uac00-\ud7a3]/;
const KANA_RE = /[\u3040-\u30ff]/;
const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

// kuromoji's dictionary ships inside its own npm package (node_modules/kuromoji/dict),
// so no separate download step is needed — it just has to be copied out of the
// asar archive for a packaged build to read it (see extraResources in package.json).
function getKuromojiDictPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'kuromoji-dict');
  return path.join(__dirname, '..', 'node_modules', 'kuromoji', 'dict');
}

let kuroshiroInstance = null;
let kuroshiroInitPromise = null;
async function getKuroshiro() {
  if (kuroshiroInstance) return kuroshiroInstance;
  if (!kuroshiroInitPromise) {
    kuroshiroInitPromise = (async () => {
      const KuroshiroMod = require('kuroshiro');
      const Kuroshiro = KuroshiroMod.default || KuroshiroMod;
      const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
      const kuroshiro = new Kuroshiro();
      await kuroshiro.init(new KuromojiAnalyzer({ dictPath: getKuromojiDictPath() }));
      kuroshiroInstance = kuroshiro;
      return kuroshiro;
    })();
  }
  return kuroshiroInitPromise;
}

// Revised Romanization of Korean. Simplified: only a single-consonant batchim
// carrying into a following silent-ㅇ syllable is resolved (e.g. 한국어 ->
// "hangugeo") — compound/double batchim just use their plain coda sound
// rather than fully resyllabifying, which covers the large majority of lyric
// text without needing a full pronunciation-rule engine.
const KO_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const KO_MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const KO_FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const KO_LINK = { 1: 'g', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 24: 'k', 25: 't', 26: 'p' };

function romanizeKorean(text) {
  const syll = Array.from(text).map((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0xac00 || code > 0xd7a3) return { raw: ch };
    const off = code - 0xac00;
    return { init: Math.floor(off / 588), med: Math.floor((off % 588) / 28), fin: off % 28 };
  });
  for (let i = 0; i < syll.length - 1; i++) {
    const a = syll[i], b = syll[i + 1];
    if (a.raw !== undefined || b.raw !== undefined) continue;
    if (a.fin && KO_LINK[a.fin] && b.init === 11) {
      b.linkedInitial = KO_LINK[a.fin];
      a.fin = 0;
    }
  }
  return syll.map((s) => {
    if (s.raw !== undefined) return s.raw;
    return (s.linkedInitial || KO_INITIALS[s.init]) + KO_MEDIALS[s.med] + KO_FINALS[s.fin];
  }).join('');
}

// A line with kanji but no kana at all is treated as Chinese; Japanese lyric
// lines almost always mix in hiragana/katakana particles even when
// kanji-heavy, so that presence/absence is a reliable enough signal.
async function romanizeLine(text) {
  if (!text || !text.trim()) return text;
  if (HANGUL_RE.test(text)) return romanizeKorean(text);
  if (KANA_RE.test(text)) {
    try {
      const kuroshiro = await getKuroshiro();
      return await kuroshiro.convert(text, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' });
    } catch (e) {
      return text;
    }
  }
  if (HAN_RE.test(text)) {
    try {
      const { pinyin } = require('pinyin-pro');
      return pinyin(text, { toneType: 'symbol', type: 'string', nonZh: 'consecutive' });
    } catch (e) {
      return text;
    }
  }
  return text;
}

ipcMain.handle('lyrics:romanize', async (evt, lines) => {
  const out = [];
  for (const line of (lines || [])) {
    try { out.push(await romanizeLine(line)); } catch (e) { out.push(line); }
  }
  return out;
});

// Read a sibling .lrc file for a track, if present
ipcMain.handle('lyrics:loadForTrack', async (evt, trackPath) => {
  const lrcPath = trackPath.replace(/\.[^.]+$/, '.lrc');
  try {
    const raw = await fsp.readFile(lrcPath, 'utf-8');
    return { found: true, raw };
  } catch (e) {
    return { found: false, raw: null };
  }
});

ipcMain.handle('app:getFileUrl', async (evt, filePath) => {
  return 'file://' + filePath.split(path.sep).join('/');
});

// ---------- Music videos for local tracks ----------
// A local track "has a music video" when a video file sits next to it under
// the same base name (Song.flac -> Song.mp4), or under that same base name
// inside a sibling Videos/ folder — the two conventions people actually use
// when they keep videos alongside a music library. Nothing is scanned ahead
// of time: the renderer asks for one track at a time, only when that track is
// the one being shown, so adding videos to a folder never needs a rescan.
const VIDEO_EXT = ['.mp4', '.webm', '.m4v', '.mov', '.mkv'];

async function fileExists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

ipcMain.handle('video:findForTrack', async (evt, audioPath) => {
  if (!audioPath) return null;
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const candidateDirs = [dir, path.join(dir, 'Videos'), path.join(dir, 'videos'), path.join(dir, 'Video')];
  for (const d of candidateDirs) {
    for (const ext of VIDEO_EXT) {
      const candidate = path.join(d, base + ext);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
});

ipcMain.handle('video:pickFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a music video for this track',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT.map((e) => e.slice(1)) }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('app:showInFolder', async (evt, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('app:openExternal', async (evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle('app:setFullScreen', (evt, flag) => {
  if (mainWindow) mainWindow.setFullScreen(!!flag);
  return true;
});

ipcMain.handle('app:isFullScreen', () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

// ---------- YouTube search via yt-dlp (no API key, no quota) ----------
// Uses the bundled yt-dlp.exe (see getYtDlpPath above); no separate install needed.
// https://github.com/yt-dlp/yt-dlp#installation
ipcMain.handle('ytdlp:search', async (evt, query) => {
  return new Promise((resolve, reject) => {
    const args = [`ytsearch10:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--skip-download'];
    let proc;
    try {
      proc = spawn(getYtDlpPath(), args);
    } catch (err) {
      reject(new Error('Could not start yt-dlp: ' + err.message));
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error("yt-dlp is missing. If you're running from source, run build-exe.bat once to fetch it, or reinstall the app if this is a packaged build."));
      } else {
        reject(new Error('yt-dlp failed to run: ' + err.message));
      }
    });

    proc.on('close', (code) => {
      if (!stdout.trim()) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code} and returned nothing.`));
        return;
      }
      const results = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (!item.id) continue;
          results.push({
            videoId: item.id,
            title: item.title || 'Untitled',
            channel: item.channel || item.uploader || '',
            duration: item.duration || null,
            thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          });
        } catch (e) { /* skip a malformed line rather than failing the whole search */ }
      }
      resolve(results);
    });
  });
});

// ---------- YouTube playlist fetch via yt-dlp (no API key, no quota) ----------
// Accepts a full playlist URL. --flat-playlist skips per-video extraction
// (fast, no download) and --dump-single-json returns one JSON object with
// the playlist title plus an `entries` array, instead of one line per video.
ipcMain.handle('ytdlp:fetchPlaylist', async (evt, url) => {
  return new Promise((resolve, reject) => {
    const args = [url, '--dump-single-json', '--flat-playlist', '--no-warnings', '--skip-download'];
    let proc;
    try {
      proc = spawn(getYtDlpPath(), args);
    } catch (err) {
      reject(new Error('Could not start yt-dlp: ' + err.message));
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error("yt-dlp is missing. If you're running from source, run build-exe.bat once to fetch it, or reinstall the app if this is a packaged build."));
      } else {
        reject(new Error('yt-dlp failed to run: ' + err.message));
      }
    });

    proc.on('close', (code) => {
      if (!stdout.trim()) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code} and returned nothing.`));
        return;
      }
      let data;
      try {
        data = JSON.parse(stdout);
      } catch (e) {
        reject(new Error('Could not parse yt-dlp output for that playlist.'));
        return;
      }
      const entries = (data.entries || []).filter((e) => e && e.id);
      if (entries.length === 0) {
        reject(new Error('No importable songs found in that playlist.'));
        return;
      }
      const items = entries.map((e) => ({
        videoId: e.id,
        title: e.title || 'Untitled',
        channel: e.channel || e.uploader || '',
        duration: (typeof e.duration === 'number') ? e.duration : null,
        thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      }));
      resolve({ title: data.title || 'Imported Playlist', items });
    });
  });
});

// ---------- Full metadata fetch for a single YouTube video ----------
// Unlike --flat-playlist (used for search/playlist listing, which never
// downloads per-video info), a plain --dump-json on a watch URL runs yt-dlp's
// full extractor, which for YouTube Music / Content-ID-backed uploads picks
// up real `album`/`track`/`artist`/`release_year` fields parsed out of the
// video's structured metadata. Used so imported tracks get their actual
// album name instead of a hardcoded placeholder like "YouTube".
ipcMain.handle('ytdlp:fetchTrackInfo', async (evt, videoId) => {
  return new Promise((resolve) => {
    const args = [`https://www.youtube.com/watch?v=${videoId}`, '--dump-json', '--no-warnings', '--skip-download'];
    let proc;
    try {
      proc = spawn(getYtDlpPath(), args);
    } catch (err) {
      resolve(null);
      return;
    }
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (!stdout.trim()) { resolve(null); return; }
      try {
        const data = JSON.parse(stdout);
        resolve({
          album: data.album || null,
          artist: data.artist || null,
          track: data.track || null,
          year: data.release_year || (data.release_date ? Number(String(data.release_date).slice(0, 4)) : null) || null,
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
});

// ---------- Mini player ----------
ipcMain.handle('miniplayer:open', () => {
  createMiniWindow();
  return true;
});

ipcMain.handle('miniplayer:close', () => {
  if (miniWindow) { miniWindow.close(); miniWindow = null; }
  return true;
});

ipcMain.on('miniplayer:pushState', (evt, state) => {
  if (miniWindow) miniWindow.webContents.send('miniplayer:state', state);
});

ipcMain.on('miniplayer:command', (evt, cmd) => {
  if (mainWindow) mainWindow.webContents.send('miniplayer:command', cmd);
});

// ---------- Metadata editor ----------
// A single re-read after editing one track's tags — no album-wide cache
// needed here, see buildTrackObject above.
async function reparseTrack(filePath) {
  return buildTrackObject(filePath, null);
}

ipcMain.handle('metadata:write', async (evt, { filePath, fields, newArtworkPath }) => {
  const f = taglib.File.createFromPath(filePath);
  try {
    if ('title' in fields) f.tag.title = fields.title || undefined;
    if ('artist' in fields) f.tag.performers = fields.artist ? [fields.artist] : [];
    if ('album' in fields) f.tag.album = fields.album || undefined;
    if ('albumArtist' in fields) f.tag.albumArtists = fields.albumArtist ? [fields.albumArtist] : [];
    if ('genre' in fields) f.tag.genres = fields.genre ? [fields.genre] : [];
    if ('year' in fields) f.tag.year = fields.year ? Number(fields.year) : 0;
    if ('track' in fields) f.tag.track = fields.track ? Number(fields.track) : 0;
    if ('disk' in fields) f.tag.disc = fields.disk ? Number(fields.disk) : 0;
    if ('composer' in fields) f.tag.composers = fields.composer ? [fields.composer] : [];
    if ('copyright' in fields) f.tag.copyright = fields.copyright || undefined;
    if ('lyrics' in fields) f.tag.lyrics = fields.lyrics || undefined;

    if (newArtworkPath) {
      const buf = await fsp.readFile(newArtworkPath);
      const ext = path.extname(newArtworkPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      const pic = taglib.Picture.fromData(taglib.ByteVector.fromByteArray(buf));
      pic.type = taglib.PictureType.FrontCover;
      pic.mimeType = mime;
      f.tag.pictures = [pic];
    }
    f.save();
  } finally {
    f.dispose();
  }
  return reparseTrack(filePath);
});

ipcMain.handle('metadata:pickArtwork', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ---------- System notifications ----------
ipcMain.on('notify:trackChange', (evt, { title, artist, album, qualityLine, artworkDataUrl }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || 'Unknown title',
    body: `${artist || 'Unknown artist'} — ${album || ''}\n${qualityLine || ''}`,
    silent: true,
  });
  n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  n.show();
});

// ---------- Media keys ----------
function registerMediaKeys() {
  try { globalShortcut.register('MediaPlayPause', () => mainWindow && mainWindow.webContents.send('mediakey:playPause')); } catch (e) {}
  try { globalShortcut.register('MediaNextTrack', () => mainWindow && mainWindow.webContents.send('mediakey:next')); } catch (e) {}
  try { globalShortcut.register('MediaPreviousTrack', () => mainWindow && mainWindow.webContents.send('mediakey:prev')); } catch (e) {}
  try { globalShortcut.register('MediaStop', () => mainWindow && mainWindow.webContents.send('mediakey:stop')); } catch (e) {}
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
