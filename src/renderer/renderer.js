// ---------- State ----------
let library = { folders: [], tracks: [], playlists: [], favorites: { songs: [], albums: [], artists: [] }, stats: { playCounts: {}, history: [], totalMs: 0 }, lastSession: null };
let settings = {
  theme: 'dark', accent: '#8b5cf6', volume: 0.8, crossfadeMs: 0, gapless: true,
  outputDeviceId: 'default', replayGainEnabled: false, dynamicColor: false, notificationsEnabled: true,
  balance: 0, monoMode: false, resumeOnLaunch: true, confirmDestructive: true,
  rowDensity: 'comfortable', defaultView: 'home', youtubeApiKey: '', romanizeLyrics: false,
  eq: { enabled: true, preset: 'Flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};

function mergeSettingsDefaults(loaded) {
  const base = {
    theme: 'dark', accent: '#8b5cf6', volume: 0.8, crossfadeMs: 0, gapless: true,
    outputDeviceId: 'default', replayGainEnabled: false, dynamicColor: false, notificationsEnabled: true,
    balance: 0, monoMode: false, resumeOnLaunch: true, confirmDestructive: true,
    rowDensity: 'comfortable', defaultView: 'home', youtubeApiKey: '', romanizeLyrics: false,
    eq: { enabled: true, preset: 'Flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  };
  const merged = { ...base, ...loaded };
  merged.eq = { ...base.eq, ...(loaded.eq || {}) };
  if (!Array.isArray(merged.eq.bands) || merged.eq.bands.length !== 10) merged.eq.bands = [...base.eq.bands];
  return merged;
}

let queue = [];          // array of track objects, in play order
let queueIndex = -1;
let shuffleMode = 'off'; // 'off' | 'random' | 'smart'
let preShuffleQueue = null; // snapshot of the queue's order before shuffle was turned on
let repeatMode = 'off';  // off | one | all
let currentView = 'home';
let sessionStart = Date.now();
let sessionMs = 0;

const viewport = document.getElementById('viewport');

// ---------- Screen painting (scroll-preserving re-renders) ----------
// `activeRerender` always points at a zero-argument function that can redraw
// exactly what's currently on screen — whether that's a top-level nav view or
// a drill-down (an album/playlist detail). Anything that mutates data and
// wants the visible screen to reflect the change should call
// refreshCurrentScreen() rather than reaching for renderView() directly, so
// the user's scroll position and drill-down are preserved instead of
// snapping back to the top of the corresponding grid.
let activeRerender = null;

// Long track lists (trackTable) virtualize their rows and attach a scroll
// listener directly to the persistent #viewport element (see trackTable()
// below). Since paintScreen only clears viewport's *children* — the
// listener itself lives on viewport, not on the removed nodes — each
// virtualized table registers a cleanup function here so paintScreen can
// tear old listeners down before the next screen renders. Without this,
// navigating between Songs/Playlists/etc repeatedly would pile up scroll
// listeners forever.
let virtualizedTableCleanups = [];

function paintScreen(renderFn, { preserveScroll = false } = {}) {
  const scrollPos = preserveScroll ? viewport.scrollTop : 0;
  virtualizedTableCleanups.forEach((fn) => fn());
  virtualizedTableCleanups = [];
  if (!preserveScroll) {
    document.getElementById('searchInput').value = '';
    viewport.classList.remove('view-anim');
    // A real navigation always starts selection fresh; an in-place refresh
    // (preserveScroll:true, used after e.g. favoriting one of several
    // selected tracks) keeps it so bulk actions can be chained.
    clearSelection();
  }
  viewport.innerHTML = '';
  renderFn();
  activeRerender = () => paintScreen(renderFn, { preserveScroll: true });
  if (!preserveScroll) {
    void viewport.offsetWidth;
    viewport.classList.add('view-anim');
    viewport.scrollTop = 0;
  } else {
    // Set it now, and again on the next frame — artwork/images finishing
    // layout a tick later can otherwise nudge scrollHeight and undo it.
    viewport.scrollTop = scrollPos;
    requestAnimationFrame(() => { viewport.scrollTop = scrollPos; });
  }
}

// Re-draws whatever's currently on screen in place: same scroll position,
// same drill-down, no fade-in replay. Use this after any data mutation
// (favorite, playlist edit, metadata save, library change) instead of
// renderView(currentView).
function refreshCurrentScreen() {
  if (activeRerender) activeRerender();
  else renderView(currentView);
}

// ---------- Multi-select ----------
// A "Select" toggle appears on every track list and card grid. Once on,
// clicking an item (or its checkbox) selects it instead of playing/opening
// it, Shift-click extends a range, and a floating action bar shows bulk
// actions for whatever's currently selected. Selection is intentionally
// global rather than per-list — simpler to reason about, and there's only
// ever one list visible at a time anyway — and gets wiped on any real
// navigation (see paintScreen above) so it never lingers into an unrelated
// screen.
let selectMode = false;
let selectedIds = new Set();
let lastSelectedId = null;

function clearSelection() {
  selectMode = false;
  selectedIds = new Set();
  lastSelectedId = null;
  removeBulkBar();
}

function isSelected(id) { return selectedIds.has(id); }

// Shared click handler for both track rows and grid cards. `orderedIds` is
// the id list in on-screen order, used to resolve a Shift-click range.
function applySelectClick(e, id, orderedIds) {
  if (e.shiftKey && lastSelectedId && orderedIds.includes(lastSelectedId)) {
    const a = orderedIds.indexOf(lastSelectedId);
    const b = orderedIds.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selectedIds.add(orderedIds[i]);
  } else if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  lastSelectedId = id;
}

function removeBulkBar() {
  const el = document.getElementById('bulkBar');
  if (el) el.remove();
}

// Renders (or updates) the floating action bar. `actions` is
// [{label, onClick}]; onClick receives nothing and is responsible for its
// own refresh/toast. The bar rebuilds itself on every call rather than
// diffing, since it's small and only changes on user action anyway.
function showBulkBar(count, actions) {
  removeBulkBar();
  const bar = document.createElement('div');
  bar.id = 'bulkBar';
  bar.className = 'bulk-bar';
  const countEl = document.createElement('span');
  countEl.className = 'bulk-count';
  countEl.textContent = `${count} selected`;
  bar.appendChild(countEl);
  actions.forEach(({ label, onClick }) => {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    bar.appendChild(btn);
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ghost-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    selectMode = false;
    selectedIds = new Set();
    lastSelectedId = null;
    refreshCurrentScreen();
  });
  bar.appendChild(cancelBtn);
  document.body.appendChild(bar);
}

// Small "choose a playlist" picker used by bulk-add actions. Resolves to a
// playlist object, a special 'new' request, or null if cancelled.
function choosePlaylistModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#17171f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:20px;min-width:320px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,0.5);';
    const label = document.createElement('div');
    label.textContent = 'Add to playlist:';
    label.style.cssText = 'margin-bottom:10px;font-size:14px;color:#eee;';
    box.appendChild(label);

    const list = document.createElement('div');
    list.style.cssText = 'max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:12px;';
    function finish(value) { document.removeEventListener('keydown', onKeydown); overlay.remove(); resolve(value); }
    function onKeydown(e) { if (e.key === 'Escape') { e.preventDefault(); finish(null); } }
    document.addEventListener('keydown', onKeydown);

    library.playlists.forEach((pl) => {
      const item = document.createElement('button');
      item.textContent = `${pl.name} (${pl.trackIds.length})`;
      item.style.cssText = 'text-align:left;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#eee;font-size:13.5px;cursor:pointer;';
      item.addEventListener('click', () => finish(pl));
      list.appendChild(item);
    });
    if (library.playlists.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No playlists yet.';
      empty.style.cssText = 'color:#888;font-size:13px;margin-bottom:8px;';
      list.appendChild(empty);
    }
    box.appendChild(list);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;';
    const newBtn = document.createElement('button');
    newBtn.className = 'ghost-btn';
    newBtn.textContent = '+ New playlist';
    newBtn.addEventListener('click', () => finish('new'));
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#ccc;font-size:14px;cursor:pointer;';
    cancelBtn.addEventListener('click', () => finish(null));
    btnRow.appendChild(newBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// Adds `trackIds` (deduped against what's already in the target playlist)
// to an existing or brand-new playlist, chosen via choosePlaylistModal.
async function bulkAddToPlaylist(trackIds) {
  const choice = await choosePlaylistModal();
  if (!choice) return;
  let pl = choice;
  if (choice === 'new') {
    const name = await promptModal('Playlist name:');
    if (!name) return;
    pl = { id: 'pl_' + Date.now(), name, trackIds: [] };
    library.playlists.push(pl);
  }
  const existing = new Set(pl.trackIds);
  let added = 0;
  trackIds.forEach((id) => { if (!existing.has(id)) { pl.trackIds.push(id); existing.add(id); added++; } });
  await persistLibrary();
  showToast(`Added ${added} song${added === 1 ? '' : 's'} to "${pl.name}"`, '📂');
  refreshCurrentScreen();
}

// Updates only the "now playing" highlight on visible track rows, without
// touching the rest of the DOM. Used on every track change so playback
// progressing doesn't cause a full-page rebuild/scroll-jump.
function updatePlayingHighlight() {
  const current = queue[queueIndex];
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', !!current && row.dataset.trackId === current.id);
  });
}

const ACCENTS = ['#8b5cf6', '#3b82f6', '#ef4444', '#ec4899', '#22c55e', '#f97316'];

const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  Flat:           [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock:           [4, 3, -2, -3, -1, 2, 4, 5, 5, 4],
  Pop:            [-1, 2, 4, 4, 1, -1, -2, -2, -1, -1],
  Electronic:     [5, 4, 1, 0, -2, 2, 1, 1, 4, 5],
  Classical:      [3, 2, 1, 0, 0, 0, 0, -1, -2, -3],
  Vocal:          [-3, -2, 0, 2, 4, 4, 3, 1, 0, -2],
  'Bass Boost':   [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 4, 5, 6],
  'Extreme Bass': [12, 11, 8, 4, 0, -1, -2, -2, -1, 0],
  'Dubstep':      [11, 10, 5, -2, -4, -2, 3, 6, 4, 2],
  'Deep House':   [7, 6, 3, 1, 0, 0, 1, 2, 2, 1],
  'Hip-Hop':      [8, 7, 3, 1, -1, 0, 2, 3, 2, 1],
  'EDM':          [8, 6, 2, -1, -2, 0, 2, 4, 5, 5],
  'Acoustic':     [2, 1, 0, 0, 1, 2, 2, 3, 3, 2],
  'Jazz':         [3, 2, 1, 1, 0, 0, 1, 2, 2, 3],
  'Podcast':      [-5, -4, -1, 1, 4, 4, 3, 2, 0, -2],
  'Lounge':       [2, 2, 1, 0, 0, -1, -1, -2, -2, -3],
  'Party':        [6, 5, 2, -1, -3, -3, -1, 2, 5, 6],
  'Live':         [1, 1, 0, -1, -2, -1, 1, 2, 2, 1],
};

// ---------- Web Audio engine (dual-buffer for gapless/crossfade) ----------
let audioCtx = null;
let preampGain = null;
let eqFilters = [];
let replayGainNode = null;
let monoNode = null;
let balancerNode = null;
let analyser = null;
let analyserData = null;
let players = {}; // { A: {el, source, trackGain}, B: {...} }
let activeKey = 'A';
let crossfading = false;
let outputDevices = [];

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  preampGain = audioCtx.createGain();
  preampGain.gain.value = dbToGain(settings.eq.preamp);

  eqFilters = EQ_FREQS.map((freq, i) => {
    const f = audioCtx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = 1.4;
    f.gain.value = settings.eq.enabled ? (settings.eq.bands[i] || 0) : 0;
    return f;
  });

  replayGainNode = audioCtx.createGain();
  replayGainNode.gain.value = 1;

  monoNode = audioCtx.createGain();
  monoNode.channelCount = settings.monoMode ? 1 : 2;
  monoNode.channelCountMode = 'explicit';
  monoNode.channelInterpretation = 'speakers';

  balancerNode = audioCtx.createStereoPanner();
  balancerNode.pan.value = settings.balance || 0;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.82;
  analyserData = new Uint8Array(analyser.frequencyBinCount);

  preampGain.connect(eqFilters[0]);
  for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
  eqFilters[eqFilters.length - 1].connect(replayGainNode);
  replayGainNode.connect(monoNode);
  monoNode.connect(balancerNode);
  balancerNode.connect(audioCtx.destination);
  balancerNode.connect(analyser);

  players.A = createPlayer('A');
  players.B = createPlayer('B');
  players.A.el.volume = settings.volume;
  players.B.el.volume = settings.volume;

  applyOutputDevice(settings.outputDeviceId);
}

// Keeps the YouTube embed's own (separate) volume control in sync with the
// app's volume slider, so users only ever have to touch one control.
function applyVolumeToYtPlayer(v) {
  if (ytPlayer && ytPlayerReady && typeof ytPlayer.setVolume === 'function') {
    ytPlayer.setVolume(Math.round(v * 100));
  }
}

// Electron doesn't implement window.prompt() at all — calling it throws
// "prompt() is and will not be supported." (alert/confirm do work, prompt
// never has, by Electron's own design). This is a small in-page replacement
// with the same call signature/behavior as prompt(): resolves to the
// trimmed string, or null if cancelled / left empty.
function promptModal(labelText, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#17171f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:20px;min-width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.5);';

    const label = document.createElement('div');
    label.textContent = labelText;
    label.style.cssText = 'margin-bottom:10px;font-size:14px;color:#eee;';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:#0e0e14;color:#fff;font-size:14px;margin-bottom:14px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#ccc;font-size:14px;cursor:pointer;';

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.className = 'primary-btn';

    function finish(value) {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    }

    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', () => finish(input.value.trim() || null));
    document.addEventListener('keydown', onKeydown);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function createPlayer(key) {
  const el = document.createElement('audio');
  el.id = 'audio' + key;
  el.preload = 'auto';
  el.style.display = 'none';
  document.body.appendChild(el);
  const source = audioCtx.createMediaElementSource(el);
  const trackGain = audioCtx.createGain();
  trackGain.gain.value = 1;
  source.connect(trackGain);
  trackGain.connect(preampGain);

  el.addEventListener('timeupdate', () => onTimeUpdate(key));
  el.addEventListener('ended', () => onEnded(key));
  return { el, source, trackGain };
}

function dbToGain(db) { return Math.pow(10, (db || 0) / 20); }

function applyEqToGraph() {
  if (!audioCtx) return;
  preampGain.gain.setTargetAtTime(settings.eq.enabled ? dbToGain(settings.eq.preamp) : 1, audioCtx.currentTime, 0.02);
  eqFilters.forEach((f, i) => {
    f.gain.setTargetAtTime(settings.eq.enabled ? (settings.eq.bands[i] || 0) : 0, audioCtx.currentTime, 0.02);
  });
}

function applyBalance() {
  if (!balancerNode) return;
  balancerNode.pan.setTargetAtTime(settings.balance || 0, audioCtx.currentTime, 0.02);
}

function applyMono() {
  if (!monoNode) return;
  monoNode.channelCount = settings.monoMode ? 1 : 2;
}

function activePlayer() { return players[activeKey]; }

// ======================================================================
// YouTube provider — plays videos through YouTube's official IFrame
// Player API (the same embed mechanism any website uses). This keeps
// playback within YouTube's terms: the player stays visible, nothing is
// downloaded or extracted, ads may play. Because the audio lives inside
// a cross-origin iframe, it cannot be routed through the local Web Audio
// graph — EQ, the visualizer, ReplayGain, and crossfade only apply to
// local files. Everything else (queue, favorites, playlists, search,
// shuffle, transport controls, mini player, lyrics) treats a YouTube
// track as a normal track via the dispatch helpers below.
// ======================================================================
let ytApiReadyPromise = null;
let ytPlayer = null;
let ytPlayerReady = false;

function loadYouTubeIframeAPI() {
  if (ytApiReadyPromise) return ytApiReadyPromise;
  ytApiReadyPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => { ytApiReadyPromise = null; reject(new Error('Could not reach YouTube — check your internet connection.')); };
    document.head.appendChild(tag);
    const timeoutId = setTimeout(() => { ytApiReadyPromise = null; reject(new Error('Timed out loading YouTube player.')); }, 15000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeoutId); resolve(); };
  });
  return ytApiReadyPromise;
}

function ensureYtPlayer() {
  if (ytPlayer && ytPlayerReady) return Promise.resolve(ytPlayer);
  return loadYouTubeIframeAPI().then(() => new Promise((resolve, reject) => {
    if (ytPlayer) { // API loaded but player not ready yet from a previous call
      const check = setInterval(() => { if (ytPlayerReady) { clearInterval(check); resolve(ytPlayer); } }, 100);
      return;
    }
    ytPlayer = new YT.Player('ytPlayerHost', {
      height: '146',
      width: '260',
      // This must match the page's REAL origin (a lie here causes its own
      // failures). The app now serves over http://localhost:PORT instead of
      // the bare IP http://127.0.0.1:PORT, which is what actually fixes the
      // origin/referrer check — window.location.origin now naturally
      // reflects that.
      playerVars: { controls: 1, modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin },
      events: {
        onReady: () => { ytPlayerReady = true; applyVolumeToYtPlayer(settings.volume); resolve(ytPlayer); },
        onStateChange: onYtPlayerStateChange,
        onError: (e) => {
          const code = e && e.data;
          console.error('YouTube player onError, code:', code);
          const messages = {
            2: 'Invalid video ID.',
            5: 'This video can\'t be played in the HTML5 player.',
            100: 'This video was removed or is private.',
            101: 'The video owner disabled embedding for this video.',
            150: 'The video owner disabled embedding for this video.',
            153: 'YouTube rejected the embed (referrer/origin check failed).',
          };
          showToast(messages[code] || `YouTube playback error (code ${code}).`, '⚠️', 5000);
          reject(new Error('YouTube playback error, code ' + code));
        },
      },
    });
  }));
}

function onYtPlayerStateChange(e) {
  if (!window.YT) return;
  if (e.data === YT.PlayerState.ENDED) onYoutubeEnded();
}

function onYoutubeEnded() {
  const justFinished = queue[queueIndex];
  const nextIdx = computeNextIndex();
  if (repeatMode === 'one') {
    if (checkSleepTimerOnTrackEnd(justFinished, justFinished)) return;
    hardLoadAndPlay(activeKey, queueIndex);
    return;
  }
  const nextForSleep = nextIdx === -1 ? null : queue[nextIdx];
  if (checkSleepTimerOnTrackEnd(justFinished, nextForSleep)) return;
  if (nextIdx === -1) { updatePlayButtonsUI(); return; }
  queueIndex = nextIdx;
  hardLoadAndPlay(activeKey, queueIndex);
}

async function loadAndPlayYoutubeTrack(track, { autoplay = true, seekTo = null } = {}) {
  stopLocalPlayback();
  const widget = document.getElementById('ytPlayerWidget');
  widget.classList.remove('hidden');
  document.getElementById('ytWidgetTitle').textContent = track.title;
  try {
    const player = await ensureYtPlayer();
    if (autoplay) player.loadVideoById({ videoId: track.videoId, startSeconds: seekTo || 0 });
    else player.cueVideoById({ videoId: track.videoId, startSeconds: seekTo || 0 });
  } catch (e) {
    showToast('Could not load YouTube video: ' + e.message, '⚠️', 5000);
  }
}

function stopYoutubePlayback() {
  if (ytPlayer && ytPlayerReady) { try { ytPlayer.pauseVideo(); } catch (e) {} }
  document.getElementById('ytPlayerWidget').classList.add('hidden');
}

function stopLocalPlayback() {
  if (players.A) players.A.el.pause();
  if (players.B) players.B.el.pause();
}

function isCurrentYoutube() {
  const t = queue[queueIndex];
  return !!(t && t.source === 'youtube');
}

// ---- Unified playback dispatch: every transport control goes through these ----
function getPlaybackCurrentTime() {
  if (isCurrentYoutube()) {
    try { return ytPlayer && ytPlayerReady ? ytPlayer.getCurrentTime() || 0 : 0; } catch (e) { return 0; }
  }
  const p = activePlayer();
  return p ? p.el.currentTime : 0;
}

function getPlaybackDuration() {
  if (isCurrentYoutube()) {
    const t = queue[queueIndex];
    try { return (ytPlayer && ytPlayerReady && ytPlayer.getDuration()) || (t && t.duration) || 0; } catch (e) { return (t && t.duration) || 0; }
  }
  const p = activePlayer();
  return p ? p.el.duration : 0;
}

function isPlaybackPaused() {
  if (isCurrentYoutube()) {
    try { return !ytPlayer || !ytPlayerReady || ytPlayer.getPlayerState() !== 1; } catch (e) { return true; }
  }
  const p = activePlayer();
  return p ? p.el.paused : true;
}

function seekPlaybackTo(t) {
  if (isCurrentYoutube()) {
    try { ytPlayer.seekTo(t, true); } catch (e) {}
    return;
  }
  const p = activePlayer();
  if (p) p.el.currentTime = t;
}

function togglePlayPause() {
  if (isCurrentYoutube()) {
    try { if (isPlaybackPaused()) ytPlayer.playVideo(); else ytPlayer.pauseVideo(); } catch (e) {}
    return;
  }
  const p = activePlayer();
  if (!p) return;
  if (p.el.paused) p.el.play(); else p.el.pause();
}

function extractYoutubeVideoId(input) {
  input = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
}

function wireYoutubeAdd() {
  document.getElementById('addYoutubeBtn').addEventListener('click', addYoutubeTrackFlow);
  document.getElementById('ytWidgetClose').addEventListener('click', () => {
    pausePlayback();
    document.getElementById('ytPlayerWidget').classList.add('hidden');
  });
}

async function addYoutubeTrackFlow() {
  const input = await promptModal('Paste a YouTube video URL:');
  if (!input) return;
  const videoId = extractYoutubeVideoId(input);
  if (!videoId) { showToast('That doesn\'t look like a valid YouTube URL', '⚠️'); return; }

  const existingId = 'yt:' + videoId;
  if (library.tracks.some((t) => t.id === existingId)) {
    showToast('That video is already in your library', 'ℹ️');
    return;
  }

  showToast('Fetching video info…', '⏳', 4000);
  try {
    const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`);
    if (!resp.ok) throw new Error('video not found or embedding disabled');
    const meta = await resp.json();
    // oEmbed never carries album info, so fetch full metadata via yt-dlp too —
    // for YouTube Music / Content-ID uploads this recovers the real album
    // name instead of falling back to a placeholder. Best-effort: if yt-dlp
    // can't find anything (or fails), the track still gets added.
    const info = await window.api.ytdlpFetchTrackInfo(videoId).catch(() => null);
    const track = {
      id: existingId,
      source: 'youtube',
      videoId,
      path: null,
      title: meta.title || 'Untitled',
      artist: (info && info.artist) || meta.author_name || 'Unknown Artist',
      albumArtist: (info && info.artist) || meta.author_name || 'Unknown Artist',
      album: (info && info.album) || 'Unknown Album',
      genre: null,
      year: (info && info.year) || null,
      track: null,
      disk: null,
      composer: null,
      duration: null,
      format: 'YouTube',
      codec: null,
      bitrate: null,
      sampleRate: null,
      bitDepth: null,
      channels: null,
      lossless: false,
      fileSize: null,
      artworkDataUrl: meta.thumbnail_url || null,
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
    };
    library.tracks.push(track);
    await persistLibrary();
    refreshCurrentScreen();
    showToast(`Added "${track.title}"`, '▶️');
  } catch (e) {
    showToast('Could not add that video — ' + e.message, '⚠️', 5000);
  }
}

// ---------- YouTube (Music) playlist import ----------
// Accepts a youtube.com/playlist, music.youtube.com/playlist, or a
// watch?v=...&list=... URL (or a bare playlist ID) and pulls out the `list`
// value. YouTube Music playlist IDs are the same IDs the regular Data API
// understands, so no separate "music" endpoint is needed.
function extractYoutubePlaylistId(input) {
  input = (input || '').trim();
  const m = input.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input; // bare ID pasted directly
  return null;
}

function setActiveNavItem(view) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

async function fetchYoutubeJson(url) {
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = (data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || '';
    if (reason === 'quotaExceeded') throw new Error('YouTube API quota exceeded for today.');
    if (resp.status === 400 || resp.status === 403) throw new Error('Invalid or unauthorized YouTube API key — check it in Settings.');
    if (resp.status === 404) throw new Error('Playlist not found.');
    throw new Error('YouTube request failed (' + (reason || resp.status) + ').');
  }
  return data;
}

// Builds library tracks + a new playlist from a normalized item list
// ({videoId, title, channel, duration, thumbnail}) and saves/renders it.
// Shared by both the yt-dlp path and the Data API fallback below.
async function finishPlaylistImport(playlistTitle, items, truncated) {
  const trackIds = [];
  for (const it of items) {
    const id = 'yt:' + it.videoId;
    let track = library.tracks.find((t) => t.id === id);
    if (!track) {
      track = {
        id, source: 'youtube', videoId: it.videoId, path: null,
        title: it.title || 'Untitled',
        artist: it.channel || 'Unknown Artist',
        albumArtist: it.channel || 'Unknown Artist',
        // A playlist import is very often literally someone's album, so use
        // its title as the album rather than a placeholder like "YouTube" —
        // far closer to what the songs are actually named.
        album: playlistTitle || 'Unknown Album', genre: null, year: null, track: null, disk: null, composer: null,
        duration: it.duration || null, format: 'YouTube', codec: null, bitrate: null,
        sampleRate: null, bitDepth: null, channels: null, lossless: false, fileSize: null,
        artworkDataUrl: it.thumbnail || null,
        replayGainTrackDb: null, replayGainAlbumDb: null,
      };
      library.tracks.push(track);
    }
    trackIds.push(id);
  }

  const newPlaylist = {
    id: 'pl_' + Date.now(),
    name: playlistTitle,
    trackIds,
    coverImageDataUrl: null,
  };
  library.playlists.push(newPlaylist);
  await persistLibrary();

  setActiveNavItem('playlists');
  currentView = 'playlists';
  renderPlaylistDetail(newPlaylist);
  showToast(
    `Imported "${playlistTitle}" — ${trackIds.length} song${trackIds.length === 1 ? '' : 's'}${truncated ? ' (playlist has more — first 1000 imported)' : ''}`,
    '📂', 5000
  );
}

// Fetches a playlist via yt-dlp: no API key, no quota. Preferred path.
async function importPlaylistViaYtdlp(playlistId) {
  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  const result = await window.api.ytdlpFetchPlaylist(playlistUrl);
  const items = result.items.map((it) => ({
    videoId: it.videoId, title: decodeHtmlEntities(it.title), channel: it.channel,
    duration: it.duration, thumbnail: it.thumbnail,
  }));
  await finishPlaylistImport(decodeHtmlEntities(result.title), items, false);
}

// Fetches a playlist via the YouTube Data API v3. Only used when yt-dlp
// isn't available/fails and the user has a key set in Settings — this is
// the quota-burning path, kept as a fallback rather than the default.
async function importPlaylistViaDataApi(playlistId) {
  const key = settings.youtubeApiKey;
  // Playlist title, so the imported playlist isn't just named after a URL.
  const plData = await fetchYoutubeJson(
    `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}`
  );
  const plInfo = (plData.items || [])[0];
  if (!plInfo) throw new Error('Playlist not found or is private — make it Public or Unlisted to import it.');
  const playlistTitle = decodeHtmlEntities(plInfo.snippet.title || 'Imported Playlist');

  // Page through playlistItems (max 50/page) until exhausted. Note this is
  // the quota-burning fallback path — a playlist this size will eat through
  // the Data API's free daily quota fast, which is exactly why yt-dlp (no
  // paging cap, no quota) is tried first in importYoutubePlaylistFlow.
  let pageToken = '';
  const rawItems = [];
  for (;;) {
    const pageUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}` + (pageToken ? `&pageToken=${pageToken}` : '');
    const pageData = await fetchYoutubeJson(pageUrl);
    rawItems.push(...(pageData.items || []));
    pageToken = pageData.nextPageToken;
    if (!pageToken) break;
  }
  const truncated = false;

  // Videos that were deleted or made private since being added to the
  // playlist come back with a placeholder title and no real videoId to play.
  const usable = rawItems.filter((it) => {
    const t = it.snippet && it.snippet.title;
    return t && t !== 'Deleted video' && t !== 'Private video' && it.snippet.resourceId && it.snippet.resourceId.videoId;
  });
  if (usable.length === 0) throw new Error('No importable songs found in that playlist.');

  // Batch-fetch durations (videos.list allows up to 50 IDs per call).
  const allIds = usable.map((it) => it.snippet.resourceId.videoId);
  const durationById = {};
  for (let i = 0; i < allIds.length; i += 50) {
    const chunk = allIds.slice(i, i + 50);
    try {
      const detailsData = await fetchYoutubeJson(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${chunk.join(',')}&key=${encodeURIComponent(key)}`
      );
      (detailsData.items || []).forEach((v) => { durationById[v.id] = parseIso8601Duration(v.contentDetails.duration); });
    } catch (e) { /* duration is a nice-to-have; degrade gracefully without it */ }
  }

  const items = usable.map((it) => {
    const videoId = it.snippet.resourceId.videoId;
    const thumb = it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || it.snippet.thumbnails.high);
    return {
      videoId,
      title: decodeHtmlEntities(it.snippet.title) || 'Untitled',
      channel: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle || 'Unknown Artist',
      duration: durationById[videoId] || null,
      thumbnail: (thumb && thumb.url) || null,
    };
  });
  await finishPlaylistImport(playlistTitle, items, truncated);
}

async function importYoutubePlaylistFlow() {
  const input = await promptModal('Paste a YouTube Music (or YouTube) playlist link:');
  if (!input) return;
  const playlistId = extractYoutubePlaylistId(input);
  if (!playlistId) { showToast('That doesn\'t look like a valid playlist link', '⚠️'); return; }

  showToast('Importing playlist…', '⏳', 6000);
  try {
    // yt-dlp first — no API key, no quota. Only fall back to the Data API
    // (if a key is set) when yt-dlp itself isn't available or errors out.
    await importPlaylistViaYtdlp(playlistId);
  } catch (ytdlpErr) {
    if (!settings.youtubeApiKey) {
      showToast('Could not import that playlist — ' + ytdlpErr.message, '⚠️', 6000);
      return;
    }
    try {
      await importPlaylistViaDataApi(playlistId);
    } catch (e) {
      showToast('Could not import that playlist — ' + e.message, '⚠️', 6000);
    }
  }
}


function standbyKey() { return activeKey === 'A' ? 'B' : 'A'; }
function standbyPlayer() { return players[standbyKey()]; }

async function applyOutputDevice(deviceId) {
  try {
    if (audioCtx && typeof audioCtx.setSinkId === 'function' && deviceId && deviceId !== 'default') {
      await audioCtx.setSinkId(deviceId);
    }
  } catch (e) { /* device may be unavailable; ignore */ }
}

async function refreshOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputDevices = devices.filter((d) => d.kind === 'audiooutput');
  } catch (e) {
    outputDevices = [];
  }
  return outputDevices;
}

// ---------- Boot ----------
(async function init() {
  library = await window.api.loadLibrary();
  if (!library.lastSession) library.lastSession = null;
  settings = mergeSettingsDefaults(await window.api.loadSettings());
  romanizationEnabled = !!settings.romanizeLyrics;
  applyAccent(settings.accent);
  document.body.classList.toggle('density-compact', settings.rowDensity === 'compact');
  document.getElementById('volBar').value = Math.round(settings.volume * 100);
  syncMuteIconUI(settings.volume);

  wireNav();
  wireTransport();
  wireSearch();
  wirePanels();
  wireFolderAdd();
  wireYoutubeAdd();
  wireOverlay();
  wireMiniPlayer();
  wireMetaEditor();
  wireSleepTimer();
  wireAbLoop();
  wireExtraShortcuts();
  wireTooltips();
  wireRippleEffect();
  wireLyricsFullscreen();
  wireLyricsFixButton();
  wireLyricsRomanizeButton();
  wireContextMenu();
  wireShortcutsModal();
  startUiLoop();
  setInterval(pushMiniPlayerState, 350); // fallback so mini-player stays live even if rAF is throttled while minimized
  setInterval(persistSessionState, 5000); // periodic checkpoint for resume-on-launch

  window.api.onScanProgress(({ done, total }) => {
    document.getElementById('scanStatus').textContent = `Scanning… ${done}/${total}`;
    if (done === total) {
      setTimeout(() => (document.getElementById('scanStatus').textContent = ''), 1500);
    }
  });

  const startView = settings.defaultView || 'home';
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === startView));
  renderView(startView);

  if (settings.resumeOnLaunch) restoreLastSession();
})();

function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft', hexToSoft(hex));
}
function hexToSoft(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.18)`;
}

// Writing library.json means serializing every track, playlist, and stat —
// which gets expensive once the library holds thousands of songs. Most
// calls to persistLibrary() happen right after an in-memory mutation the UI
// already reflects, so the disk write itself doesn't need to block anyone:
// debounce it so a burst of changes (spamming a heart button, an importing
// playlist adding hundreds of tracks) collapses into a single write instead
// of one per change.
let libraryDirty = false;
let libraryPersistTimer = null;

async function persistLibrary() {
  libraryDirty = true;
  clearTimeout(libraryPersistTimer);
  libraryPersistTimer = setTimeout(flushLibraryToDisk, 400);
}

async function flushLibraryToDisk() {
  if (!libraryDirty) return;
  libraryDirty = false;
  try {
    await window.api.saveLibrary(library);
  } catch (e) {
    console.error('Failed to save library:', e);
  }
}

// Best-effort: if the window closes while a write is still debounced, flush
// right away rather than losing the last change. Not guaranteed to finish
// before the process exits, but better than doing nothing.
window.addEventListener('beforeunload', () => {
  if (libraryDirty) {
    clearTimeout(libraryPersistTimer);
    flushLibraryToDisk();
  }
});

async function persistSettings() { await window.api.saveSettings(settings); }

// ---------- Nav ----------
function wireNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderView(btn.dataset.view);
    });
  });
}

function wireFolderAdd() {
  document.getElementById('addFolderBtn').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (!folder) return;
    if (!library.folders.includes(folder)) library.folders.push(folder);
    await persistLibrary();
    await rescan();
  });
}

async function rescan() {
  document.getElementById('scanStatus').textContent = 'Scanning…';
  const tracks = await window.api.scanFolders(library.folders);
  // A rescan rebuilds every track from its tags, which knows nothing about a
  // music video the user attached by hand — carry those over by path.
  const videosByPath = new Map();
  library.tracks.forEach((t) => { if (t.path && t.videoPath) videosByPath.set(t.path, t.videoPath); });
  tracks.forEach((t) => { if (videosByPath.has(t.path)) { t.videoPath = videosByPath.get(t.path); t.videoChecked = true; } });
  library.tracks = tracks;
  await persistLibrary();
  refreshCurrentScreen();
  showToast(`Library scanned: ${tracks.length} track${tracks.length === 1 ? '' : 's'}`, '🎵');
}

// ---------- Search ----------
let searchDebounceTimer = null;
let searchToken = 0;

function wireSearch() {
  document.getElementById('searchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchDebounceTimer);
    searchToken++;
    if (q.length === 0) { renderView(currentView); return; }
    renderSearchResults(q);
    if (q.length >= 2) {
      const myToken = searchToken;
      searchDebounceTimer = setTimeout(() => fetchAndRenderYoutubeSearch(q, myToken), 450);
    }
  });
}

function renderSearchResults(q) {
  const ql = q.toLowerCase();
  const matches = library.tracks.filter((t) =>
    [t.title, t.artist, t.album, t.genre].filter(Boolean).some((f) => f.toLowerCase().includes(ql))
  );
  // Bypasses paintScreen (keeps the search box focused while typing), so it
  // has to clear stale virtualized-table scroll listeners itself — same as
  // paintScreen does — or retyping a search would leak one per keystroke.
  // Selection is cleared too, since the match set changes on every
  // keystroke and a stale selection from a previous query would be
  // misleading.
  virtualizedTableCleanups.forEach((fn) => fn());
  virtualizedTableCleanups = [];
  clearSelection();
  viewport.innerHTML = '';
  const titleWrap = sectionTitle(`Search results for "${q}"`, `${matches.length} in your library`);
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;';
  titleRow.appendChild(titleWrap);
  if (matches.length) {
    const selectBtn = document.createElement('button');
    selectBtn.className = 'ghost-btn';
    selectBtn.textContent = '☑ Select';
    selectBtn.addEventListener('click', () => {
      selectMode = true;
      renderSearchResultsTable(matches);
    });
    titleRow.appendChild(selectBtn);
  }
  viewport.appendChild(titleRow);
  const tableHost = document.createElement('div');
  viewport.appendChild(tableHost);
  function renderSearchResultsTable(list) {
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    const opts = selectMode
      ? { selectable: true, orderedIds: list.map((t) => t.id), onSelectChange: () => renderSearchResultsTable(list) }
      : {};
    tableHost.replaceChildren(trackTable(list, opts));
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selected = list.filter((t) => selectedIds.has(t.id));
    showBulkBar(selected.length, [
      { label: '▶ Play', onClick: () => playFromList(selected, 0) },
      { label: '➕ Add to playlist…', onClick: () => bulkAddToPlaylist(selected.map((t) => t.id)) },
      { label: '❤️ Favorite', onClick: () => {
        selected.forEach((t) => { if (!library.favorites.songs.includes(t.id)) library.favorites.songs.push(t.id); });
        persistLibrary();
        renderSearchResultsTable(list);
      } },
    ]);
  }
  renderSearchResultsTable(matches);

  const ytHeader = document.createElement('div');
  ytHeader.className = 'section-title';
  ytHeader.style.marginTop = '26px';
  ytHeader.textContent = 'YouTube';
  viewport.appendChild(ytHeader);
  const ytContainer = document.createElement('div');
  ytContainer.id = 'ytSearchResults';
  ytContainer.innerHTML = '<div class="yt-search-hint">Keep typing to search YouTube…</div>';
  viewport.appendChild(ytContainer);
}

async function fetchAndRenderYoutubeSearch(q, myToken) {
  const container = document.getElementById('ytSearchResults');
  if (!container || myToken !== searchToken) return;

  container.innerHTML = '<div class="yt-search-loading">🔎 Searching YouTube…</div>';
  try {
    const results = await youtubeSearch(q);
    if (myToken !== searchToken) return; // a newer search superseded this one
    const freshContainer = document.getElementById('ytSearchResults');
    if (!freshContainer) return;
    if (results.length === 0) {
      freshContainer.innerHTML = '<div class="yt-search-hint">No YouTube results found.</div>';
      return;
    }
    renderYoutubeResultCards(freshContainer, results);
  } catch (e) {
    if (myToken !== searchToken) return;
    const freshContainer = document.getElementById('ytSearchResults');
    if (freshContainer) freshContainer.innerHTML = `<div class="yt-search-hint">⚠️ ${esc(e.message)}</div>`;
  }
}

// Tries yt-dlp first (no key, no quota). Falls back to the YouTube Data API
// key in Settings, if one is set, when yt-dlp isn't installed or errors out.
async function youtubeSearch(query) {
  try {
    return await window.api.ytdlpSearch(query);
  } catch (e) {
    if (!settings.youtubeApiKey) throw e;
    return youtubeSearchViaDataApi(query);
  }
}

async function youtubeSearchViaDataApi(query) {
  const key = settings.youtubeApiKey;
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  const searchResp = await fetch(searchUrl);
  const searchData = await searchResp.json().catch(() => ({}));
  if (!searchResp.ok) {
    const reason = (searchData.error && searchData.error.errors && searchData.error.errors[0] && searchData.error.errors[0].reason) || '';
    if (reason === 'quotaExceeded') throw new Error('YouTube search quota exceeded for today.');
    if (searchResp.status === 400 || searchResp.status === 403) throw new Error('Invalid or unauthorized YouTube API key — check it in Settings.');
    throw new Error('YouTube search failed (' + (reason || searchResp.status) + ').');
  }
  const items = (searchData.items || []).filter((it) => it.id && it.id.videoId);
  if (items.length === 0) return [];

  const ids = items.map((it) => it.id.videoId).join(',');
  let durationById = {};
  try {
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${encodeURIComponent(key)}`;
    const detailsResp = await fetch(detailsUrl);
    const detailsData = await detailsResp.json().catch(() => ({}));
    if (detailsResp.ok) {
      (detailsData.items || []).forEach((v) => { durationById[v.id] = parseIso8601Duration(v.contentDetails.duration); });
    }
  } catch (e) { /* duration is a nice-to-have; degrade gracefully without it */ }

  return items.map((it) => ({
    videoId: it.id.videoId,
    title: decodeHtmlEntities(it.snippet.title),
    channel: it.snippet.channelTitle,
    thumbnail: (it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default) || {}).url || '',
    duration: durationById[it.id.videoId] || null,
  }));
}

function parseIso8601Duration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10), mi = parseInt(m[2] || 0, 10), s = parseInt(m[3] || 0, 10);
  return h * 3600 + mi * 60 + s;
}

function decodeHtmlEntities(str) {
  const el = document.createElement('textarea');
  el.innerHTML = str;
  return el.value;
}

function renderYoutubeResultCards(container, results) {
  container.innerHTML = '';
  container.className = 'yt-search-grid';
  results.forEach((r) => {
    const id = 'yt:' + r.videoId;
    const isFav = library.favorites.songs.includes(id);
    const card = document.createElement('div');
    card.className = 'yt-result-card stagger-enter';
    card.dataset.videoId = r.videoId;
    card.innerHTML = `
      <img class="yt-result-thumb" loading="lazy" src="${r.thumbnail}" />
      <div class="yt-result-meta">
        <div class="yt-result-title">${esc(r.title)}</div>
        <div class="yt-result-channel">${esc(r.channel)}</div>
      </div>
      <div class="yt-result-duration">${r.duration ? fmtTime(r.duration) : '—'}</div>
      <button class="icon-btn yt-result-fav" data-tooltip="${isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${isFav ? '❤️' : '🤍'}</button>
      <button class="icon-btn yt-result-play" data-tooltip="Play now">▶️</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.yt-result-fav')) return;
      playYoutubeSearchResult(r);
    });
    card.querySelector('.yt-result-fav').addEventListener('click', async (e) => {
      e.stopPropagation();
      const track = await materializeYoutubeTrack(r);
      toggleFavoriteSong(track.id);
    });
    // Right-click gets the full context menu (play next, add to queue, add
    // to playlist, etc) same as any other track — see wireContextMenu().
    card.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const track = await materializeYoutubeTrack(r);
      buildContextMenu(track, e.clientX, e.clientY);
    });
    container.appendChild(card);
  });
}

// Turns a raw YouTube search result into a real library track, reusing the
// existing one if this video was already added. Shared by "Play now", the
// like button, and the right-click menu on not-yet-imported search results.
async function materializeYoutubeTrack(r) {
  const id = 'yt:' + r.videoId;
  let track = library.tracks.find((t) => t.id === id);
  if (!track) {
    track = {
      id, source: 'youtube', videoId: r.videoId, path: null,
      title: r.title, artist: r.channel, albumArtist: r.channel, album: 'Unknown Album',
      genre: null, year: null, track: null, disk: null, composer: null,
      duration: r.duration || null, format: 'YouTube', codec: null, bitrate: null,
      sampleRate: null, bitDepth: null, channels: null, lossless: false, fileSize: null,
      artworkDataUrl: r.thumbnail, replayGainTrackDb: null, replayGainAlbumDb: null,
    };
    library.tracks.push(track);
    await persistLibrary();
    // Best-effort enrichment: fill in the real album (and artist/year, if
    // yt-dlp's full extractor found any) once it comes back, rather than
    // blocking the track's addition on it.
    window.api.ytdlpFetchTrackInfo(r.videoId).then(async (info) => {
      if (!info) return;
      let changed = false;
      if (info.album) { track.album = info.album; changed = true; }
      if (info.artist) { track.artist = info.artist; track.albumArtist = info.artist; changed = true; }
      if (info.year) { track.year = info.year; changed = true; }
      if (changed) { await persistLibrary(); refreshCurrentScreen(); }
    }).catch(() => {});
  }
  return track;
}

async function playYoutubeSearchResult(r) {
  const track = await materializeYoutubeTrack(r);
  playFromList([track], 0);
  showToast(`Playing "${track.title}"`, '▶️');
}

// ---------- View rendering ----------
function renderView(view) {
  currentView = view;
  paintScreen(() => {
    if (library.tracks.length === 0 && view !== 'settings' && view !== 'folders') {
      viewport.appendChild(emptyLibraryState());
      return;
    }
    switch (view) {
      case 'home': return renderHome();
      case 'songs': return renderSongs();
      case 'albums': return renderAlbums();
      case 'artists': return renderArtists();
      case 'genres': return renderGenres();
      case 'folders': return renderFolders();
      case 'playlists': return renderPlaylists();
      case 'favorites': return renderFavorites();
      case 'stats': return renderStats();
      case 'settings': return renderSettings();
    }
  });
}

function emptyLibraryState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="big">Your library is empty</div>
    <div>Add a folder of music files (FLAC, WAV, MP3, OGG, M4A, AIFF, OPUS) or a YouTube video to get started.</div>
    <button class="primary-btn" id="emptyAddFolder">+ Add Music Folder</button>
    <button class="ghost-btn" id="emptyAddYoutube" style="margin-top:12px;margin-left:10px">▶ Add YouTube Video</button>
  `;
  setTimeout(() => {
    const btn = document.getElementById('emptyAddFolder');
    if (btn) btn.addEventListener('click', () => document.getElementById('addFolderBtn').click());
    const ytBtn = document.getElementById('emptyAddYoutube');
    if (ytBtn) ytBtn.addEventListener('click', () => document.getElementById('addYoutubeBtn').click());
  });
  return div;
}

function sectionTitle(title, sub) {
  const wrap = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'view-title';
  h.textContent = title;
  wrap.appendChild(h);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'view-sub';
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

// ---- Home ----
function renderHome() {
  const recent = [...library.tracks].slice(-10).reverse();
  const mostPlayed = [...library.tracks]
    .sort((a, b) => (library.stats.playCounts[b.id] || 0) - (library.stats.playCounts[a.id] || 0))
    .slice(0, 10);
  const favSongs = library.tracks.filter((t) => library.favorites.songs.includes(t.id));

  const hero = library.tracks[Math.floor(Math.random() * library.tracks.length)];
  if (hero) {
    const heroEl = document.createElement('div');
    heroEl.className = 'hero';
    heroEl.innerHTML = `
      <div class="hero-info">
        <div class="hero-label">Random pick</div>
        <div class="hero-title">${esc(hero.title)}</div>
        <div class="hero-sub">${esc(hero.artist)} • ${esc(hero.album)} ${hero.lossless ? '• Lossless' : ''}</div>
        <button class="primary-btn" id="heroPlay">▶ Play now</button>
      </div>
      <img class="hero-art" src="${hero.artworkDataUrl || ''}" />
    `;
    viewport.appendChild(heroEl);
    setTimeout(() => document.getElementById('heroPlay').addEventListener('click', () => playFromList(library.tracks, library.tracks.indexOf(hero))));
  }

  if (recent.length) {
    viewport.appendChild(sectionTitle('Recently Added'));
    viewport.appendChild(cardGrid(recent, 'album'));
  }
  if (mostPlayed.some((t) => library.stats.playCounts[t.id])) {
    viewport.appendChild(sectionTitle('Most Played'));
    viewport.appendChild(cardGrid(mostPlayed.filter((t) => library.stats.playCounts[t.id]), 'song'));
  }
  if (favSongs.length) {
    viewport.appendChild(sectionTitle('Liked Songs'));
    viewport.appendChild(cardGrid(favSongs.slice(0, 10), 'song'));
  }
}

function cardGrid(tracks, mode) {
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  tracks.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'card stagger-enter';
    card.style.animationDelay = Math.min(i * 25, 400) + 'ms';
    card.dataset.trackId = t.id;
    const isFav = library.favorites.songs.includes(t.id);
    card.innerHTML = `
      <img class="card-art" loading="lazy" src="${t.artworkDataUrl || ''}" />
      <button class="cfav" data-tooltip="${isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${isFav ? '❤️' : '🤍'}</button>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist)}</div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.cfav')) return;
      playFromList(library.tracks, library.tracks.indexOf(t));
    });
    card.querySelector('.cfav').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoriteSong(t.id);
    });
    // Right-click gets the full context menu — see wireContextMenu().
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      buildContextMenu(t, e.clientX, e.clientY);
    });
    grid.appendChild(card);
  });
  return grid;
}

// ---- Songs ----
function renderSongs() {
  viewport.appendChild(sectionTitle('Songs', `${library.tracks.length} tracks`));
  renderFilterableTrackList(viewport, library.tracks, 'Search songs…');
}

// Column layout for a track row/header. Grows on the left to fit a drag
// handle (playlist reordering) and/or a selection checkbox — both opt-in —
// without disturbing the base 7-column layout everywhere else.
function trackRowColumns(opts) {
  let cols = '';
  if (opts && opts.reorder) cols += '18px ';
  if (opts && opts.selectable) cols += '22px ';
  return cols + '34px 1fr 1fr 150px 90px 40px 40px';
}

// Builds a single track row. `animate` controls the stagger fade-in — used
// for the initial render of a screen, but turned off for rows that appear
// because of virtualized-scroll re-renders (see trackTable), where
// replaying the animation on every scroll tick would look like flicker.
// `opts.selectable` turns on checkbox multi-select (see "Multi-select"
// above); `opts.reorder = { onReorder(draggedId, targetId, after) }` turns
// on drag-to-reorder, used by the playlist detail view.
function buildTrackRow(t, i, tracks, animate, opts = {}) {
  const row = document.createElement('div');
  row.className = animate ? 'track-row stagger-enter' : 'track-row';
  if (animate) row.style.animationDelay = Math.min(i * 15, 300) + 'ms';
  row.dataset.trackId = t.id;
  row.style.gridTemplateColumns = trackRowColumns(opts);
  if (queue[queueIndex] && queue[queueIndex].id === t.id) row.classList.add('playing');
  if (opts.selectable && isSelected(t.id)) row.classList.add('row-selected');
  const isFav = library.favorites.songs.includes(t.id);
  const handleHtml = opts.reorder ? `<div class="drag-handle" title="Drag to reorder">⠿</div>` : '';
  const checkHtml = opts.selectable ? `<input type="checkbox" class="tcheck" ${isSelected(t.id) ? 'checked' : ''} />` : '';
  row.innerHTML = `
    ${handleHtml}${checkHtml}
    <div class="idx">${i + 1}</div>
    <div class="ttitle" title="${esc(t.artist)} - ${esc(t.title)}">${esc(t.title)}<br><span class="tartist">${esc(t.artist)}</span></div>
    <div class="talbum">${esc(t.album)}</div>
    <div class="tfmt">${t.format}${t.lossless ? ' • Lossless' : ''}${t.bitDepth ? ` • ${t.bitDepth}-bit` : ''}${t.sampleRate ? ` • ${(t.sampleRate/1000).toFixed(1)}kHz` : ''}</div>
    <div class="tdur">${fmtTime(t.duration)}</div>
    <button class="tfav" data-tooltip="${isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${isFav ? '❤️' : '🤍'}</button>
    <button class="tedit" data-tooltip="Edit track info">✏️</button>
  `;
  row.addEventListener('click', (e) => {
    if (e.target.classList.contains('tfav') || e.target.classList.contains('tedit')) return;
    if (opts.selectable) {
      applySelectClick(e, t.id, opts.orderedIds || tracks.map((x) => x.id));
      opts.onSelectChange();
      return;
    }
    playFromList(tracks, i);
  });
  const checkEl = row.querySelector('.tcheck');
  if (checkEl) {
    checkEl.addEventListener('click', (e) => {
      e.stopPropagation();
      applySelectClick(e, t.id, opts.orderedIds || tracks.map((x) => x.id));
      opts.onSelectChange();
    });
  }
  row.querySelector('.tfav').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavoriteSong(t.id);
  });
  row.querySelector('.tedit').addEventListener('click', (e) => {
    e.stopPropagation();
    openMetaEditor(t);
  });

  if (opts.reorder) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = (e.clientY - row.getBoundingClientRect().top) > row.offsetHeight / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-before', 'drop-after');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === t.id) return;
      const after = (e.clientY - row.getBoundingClientRect().top) > row.offsetHeight / 2;
      opts.reorder.onReorder(draggedId, t.id, after);
    });
  }
  return row;
}

// Track lists can run into the thousands (a big imported YouTube playlist,
// a large local library), and building/laying out that many DOM rows up
// front is what actually makes the app feel sluggish — not the underlying
// data. Below the threshold we just render normally, since virtualizing a
// short list adds overhead for no benefit. Above it, only the rows near the
// visible area are ever in the DOM; the rest is represented by two spacer
// divs sized to hold their place, and the visible slice is recomputed as
// the (single, app-wide) #viewport scrolls.
const VIRTUALIZE_THRESHOLD = 150;

function trackTable(tracks, opts = {}) {
  const wrap = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'track-header';
  header.style.gridTemplateColumns = trackRowColumns(opts);
  const leadCells = (opts.reorder ? '<div></div>' : '') + (opts.selectable ? '<div></div>' : '');
  header.innerHTML = `${leadCells}<div>#</div><div>Title</div><div>Album</div><div>Format</div><div style="text-align:right">Duration</div><div></div><div></div>`;
  wrap.appendChild(header);

  if (tracks.length <= VIRTUALIZE_THRESHOLD) {
    tracks.forEach((t, i) => wrap.appendChild(buildTrackRow(t, i, tracks, true, opts)));
    return wrap;
  }

  const topSpacer = document.createElement('div');
  const body = document.createElement('div');
  const bottomSpacer = document.createElement('div');
  wrap.appendChild(topSpacer);
  wrap.appendChild(body);
  wrap.appendChild(bottomSpacer);

  const BUFFER_ROWS = 10;
  let rowHeight = 0;
  let renderedStart = -1;
  let renderedEnd = -1;

  function measureRowHeight() {
    if (rowHeight) return rowHeight;
    // Row height depends on font rendering and the compact-density setting,
    // so measure a real row instead of guessing a constant.
    const probe = buildTrackRow(tracks[0], 0, tracks, false, opts);
    probe.style.visibility = 'hidden';
    body.appendChild(probe);
    rowHeight = probe.getBoundingClientRect().height || 56;
    probe.remove();
    return rowHeight;
  }

  function update() {
    const rh = measureRowHeight();
    const rowsTop = wrap.getBoundingClientRect().top + header.getBoundingClientRect().height;
    const viewRect = viewport.getBoundingClientRect();

    let start = Math.floor((viewRect.top - rowsTop) / rh) - BUFFER_ROWS;
    let end = Math.ceil((viewRect.bottom - rowsTop) / rh) + BUFFER_ROWS;
    start = Math.max(0, Math.min(start, tracks.length));
    end = Math.max(0, Math.min(end, tracks.length));
    if (end <= start) { start = 0; end = Math.min(tracks.length, 50); }
    if (start === renderedStart && end === renderedEnd) return;
    renderedStart = start;
    renderedEnd = end;

    topSpacer.style.height = (start * rh) + 'px';
    bottomSpacer.style.height = ((tracks.length - end) * rh) + 'px';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(buildTrackRow(tracks[i], i, tracks, false, opts));
    // replaceChildren swaps the old rows for the new ones in one step,
    // instead of a separate clear-then-append that briefly leaves body
    // empty — that momentary empty state was shrinking the scrollable
    // area mid-scroll, which is what made Chromium's scroll-anchoring
    // "helpfully" yank scrollTop around (the runaway fast-scroll bug).
    // Disabling overflow-anchor on .viewport (styles.css) is the main
    // fix; this avoids handing anchoring anything to react to at all.
    body.replaceChildren(frag);
  }

  // The native 'scroll' event can fire dozens of times per second during
  // a fling — recomputing and mutating the DOM on every single one is
  // both wasteful and, combined with layout changes mid-scroll, exactly
  // what invites scroll-anchoring feedback loops. Collapse bursts down to
  // at most once per animation frame.
  let updateQueued = false;
  function scheduleUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => { updateQueued = false; update(); });
  }

  viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
  const ro = new ResizeObserver(scheduleUpdate);
  ro.observe(viewport);
  virtualizedTableCleanups.push(() => {
    viewport.removeEventListener('scroll', scheduleUpdate);
    ro.disconnect();
  });

  requestAnimationFrame(update);
  return wrap;
}

// A small "search within this view" input — filters an already-loaded
// in-memory list (a playlist's tracks, the artists grid) live as you type.
// Unlike the top #searchInput, this never touches YouTube and never calls
// paintScreen, so the input keeps focus while typing. onChange receives
// the lowercased, trimmed query string.
function localFilterBox(placeholder, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'local-filter';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'local-filter-input';
  input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value.trim().toLowerCase()));
  wrap.appendChild(input);
  return wrap;
}

// Builds the shared "search + Select toggle" row used above every card
// grid screen (Albums/Artists/Genres/Playlists). `renderFiltered(q)` must
// fully redraw the grid for query `q`, including re-evaluating selectMode.
function gridToolbar(placeholder, renderFiltered) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  let lastQuery = '';
  row.appendChild(localFilterBox(placeholder, (q) => { lastQuery = q; renderFiltered(q); }));
  const selectBtn = document.createElement('button');
  selectBtn.className = 'ghost-btn';
  selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
  selectBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    if (!selectMode) { selectedIds = new Set(); lastSelectedId = null; }
    selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
    renderFiltered(lastQuery);
  });
  row.appendChild(selectBtn);
  return row;
}

// Wraps a full track list with a live "search within this list" box (see
// localFilterBox above), a "Select" multi-select toggle, and the resulting
// trackTable, all appended to `host`. Used anywhere a whole track list is
// its own screen — Songs, Liked Songs, a playlist's contents, an
// artist/genre drill-down — so they all get the same filtering and
// selection instead of only the global top search bar reaching them.
//
// `listOpts`:
//   - reorderable: pass { onReorder(draggedId, targetId, after) } to turn on
//     drag-to-reorder (used by playlist detail — order there is meaningful).
//   - playlistContext: the playlist object, when this list IS a playlist's
//     contents — adds a "Remove from playlist" bulk action.
function renderFilterableTrackList(host, tracks, placeholder, listOpts = {}) {
  if (tracks.length === 0) {
    host.appendChild(trackTable(tracks));
    return;
  }
  const tracksHost = document.createElement('div');
  let lastQuery = '';

  function updateBulkBar(filteredTracks) {
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selected = tracks.filter((t) => selectedIds.has(t.id));
    const actions = [
      { label: '▶ Play', onClick: () => { playFromList(selected, 0); } },
      { label: '➕ Queue', onClick: () => {
        if (queue.length === 0) { playFromList(selected, 0); return; }
        queue.push(...selected);
        showToast(`Added ${selected.length} to queue`, '📑');
      } },
      { label: '❤️ Favorite', onClick: () => {
        selected.forEach((t) => { if (!library.favorites.songs.includes(t.id)) library.favorites.songs.push(t.id); });
        persistLibrary();
        refreshCurrentScreen();
      } },
      { label: '➕ Add to playlist…', onClick: () => bulkAddToPlaylist(selected.map((t) => t.id)) },
    ];
    if (listOpts.playlistContext) {
      actions.push({ label: '➖ Remove from playlist', onClick: () => {
        const pl = listOpts.playlistContext;
        pl.trackIds = pl.trackIds.filter((id) => !selectedIds.has(id));
        persistLibrary();
        selectedIds = new Set();
        refreshCurrentScreen();
      } });
    }
    showBulkBar(selected.length, actions);
  }

  function renderFiltered(q) {
    lastQuery = q;
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    const filtered = q
      ? tracks.filter((t) => [t.title, t.artist, t.album].filter(Boolean).some((f) => f.toLowerCase().includes(q)))
      : tracks;
    const opts = {};
    if (listOpts.reorderable) opts.reorder = listOpts.reorderable;
    if (selectMode) {
      opts.selectable = true;
      opts.orderedIds = filtered.map((t) => t.id);
      opts.onSelectChange = () => renderFiltered(lastQuery);
    }
    tracksHost.replaceChildren(trackTable(filtered, opts));
    updateBulkBar(filtered);
  }

  const toolbarRow = document.createElement('div');
  toolbarRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  toolbarRow.appendChild(localFilterBox(placeholder, renderFiltered));
  const selectBtn = document.createElement('button');
  selectBtn.className = 'ghost-btn';
  selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
  selectBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    if (!selectMode) { selectedIds = new Set(); lastSelectedId = null; }
    selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
    renderFiltered(lastQuery);
  });
  toolbarRow.appendChild(selectBtn);
  host.appendChild(toolbarRow);
  host.appendChild(tracksHost);
  renderFiltered('');
}

// Some tracks tag the very same album/artist under near-identical but not
// identical strings — most commonly one track's artist field is "Artist A"
// and another's is "Artist A feat. Artist B" for what is really the same
// album (or the same artist). Grouping strictly by the raw string then
// splits one album/artist into two separate cards. Stripping a trailing
// "feat./ft./featuring …" credit (and any wrapping parenthesis) before
// grouping fixes that; the card itself still displays a real, unmodified
// artist string — the shortest one in the group, which is consistently
// the "plain" version without the extra credit tacked on.
function normalizeArtistForGrouping(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s*[\(\[]?\s*\b(feat\.?|ft\.?|featuring)\b.*$/i, '')
    .trim();
}

function groupByAlbum(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    const key = `${normalizeArtistForGrouping(t.albumArtist)}||${(t.album || '').trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()].map((groupTracks) => {
    const rep = groupTracks.reduce((a, b) => (b.albumArtist.length < a.albumArtist.length ? b : a));
    return { artist: rep.albumArtist, album: rep.album, tracks: groupTracks };
  });
}

function groupByArtist(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    const key = normalizeArtistForGrouping(t.albumArtist);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()].map((groupTracks) => {
    const rep = groupTracks.reduce((a, b) => (b.albumArtist.length < a.albumArtist.length ? b : a));
    return { artist: rep.albumArtist, tracks: groupTracks };
  });
}

// Card grids (Albums/Artists/Genres/Playlists) render one <div class="card">
// with an <img> per item, same as trackTable renders one row per track —
// but unlike trackTable they had no virtualization, so a library with
// thousands of local songs (and therefore hundreds+ of albums/artists)
// built and painted every single card in one go. That's the "loading
// everything at once" lag: a big, uninterrupted layout+paint of the whole
// grid before the user could see or scroll anything. This renders an
// initial batch immediately, then reveals more in batches as the user
// scrolls near the bottom, via a sentinel element and IntersectionObserver
// — the same idea as trackTable's virtualization, just append-only rather
// than windowed, since cards (with lazy-loaded <img>s) are cheap to leave
// in the DOM once rendered.
// `selectOpts`, when passed, turns on multi-select for the grid: a checkbox
// overlay on every card, and clicking a card toggles selection instead of
// triggering buildCard's own click handler (navigate to detail, etc). The
// interception uses a capture-phase listener added *after* buildCard's own
// bubble-phase one — capture always runs first regardless of registration
// order, so stopImmediatePropagation there reliably beats it.
// selectOpts: { getId(item) }.
function renderCardGridLazy(host, items, buildCard, batchSize = 60, selectOpts = null) {
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  host.appendChild(grid);

  if (items.length === 0) return grid;

  function wireSelectable(card, item) {
    if (!selectOpts) return card;
    const id = selectOpts.getId(item);
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = isSelected(id);
    if (isSelected(id)) card.classList.add('card-selected');
    card.style.position = card.style.position || 'relative';
    card.appendChild(check);
    const orderedIds = items.map((it) => selectOpts.getId(it));
    const onClick = (e) => {
      if (!selectMode) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      applySelectClick(e, id, orderedIds);
      selectOpts.onSelectChange();
    };
    card.addEventListener('click', onClick, { capture: true });
    check.addEventListener('click', onClick, { capture: true });
    return card;
  }

  let rendered = 0;
  function renderNextBatch() {
    const frag = document.createDocumentFragment();
    const end = Math.min(rendered + batchSize, items.length);
    for (let i = rendered; i < end; i++) frag.appendChild(wireSelectable(buildCard(items[i]), items[i]));
    grid.appendChild(frag);
    rendered = end;
    if (rendered >= items.length) {
      sentinel.remove();
      io.disconnect();
    }
  }

  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;';
  host.appendChild(sentinel);

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderNextBatch();
  }, { root: viewport, rootMargin: '600px' });

  renderNextBatch();
  if (rendered < items.length) io.observe(sentinel);
  else sentinel.remove();

  // Reuses the same cleanup registry paintScreen already drains on every
  // screen change, so navigating away disconnects this observer too.
  virtualizedTableCleanups.push(() => io.disconnect());
  return grid;
}

// ---- Albums ----
function renderAlbums() {
  const albums = groupByAlbum(library.tracks);
  viewport.appendChild(sectionTitle('Albums', `${albums.length} albums`));

  function buildCard({ artist, album, tracks }) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img class="card-art" loading="lazy" src="${tracks[0].artworkDataUrl || ''}" />
      <div class="card-title">${esc(album)}</div>
      <div class="card-sub">${esc(artist)}</div>
    `;
    card.addEventListener('click', () => renderAlbumDetail(album, artist, tracks));
    return card;
  }

  const groupId = (g) => `${g.artist}||${g.album}`;
  const gridHost = document.createElement('div');
  let currentFiltered = albums;
  function renderFiltered(q) {
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    gridHost.innerHTML = '';
    const filtered = q
      ? albums.filter((a) => a.album.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
      : albums;
    currentFiltered = filtered;
    const selectOpts = selectMode ? { getId: groupId, onSelectChange: () => renderFiltered(q) } : null;
    renderCardGridLazy(gridHost, filtered, buildCard, 60, selectOpts);
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selectedGroups = currentFiltered.filter((g) => selectedIds.has(groupId(g)));
    const allTracks = selectedGroups.flatMap((g) => g.tracks);
    showBulkBar(selectedGroups.length, [
      { label: '➕ Queue all', onClick: () => {
        if (queue.length === 0) { playFromList(allTracks, 0); return; }
        queue.push(...allTracks);
        showToast(`Added ${allTracks.length} songs to queue`, '📑');
      } },
      { label: '➕ Add to playlist…', onClick: () => bulkAddToPlaylist(allTracks.map((t) => t.id)) },
    ]);
  }

  viewport.appendChild(gridToolbar('Search albums…', renderFiltered));
  viewport.appendChild(gridHost);
  renderFiltered('');
}

function renderAlbumDetail(album, artist, tracks) {
  paintScreen(() => renderAlbumDetailContent(album, artist, tracks));
}

function renderAlbumDetailContent(album, artist, tracks) {
  const sorted = [...tracks].sort((a, b) => (a.track || 0) - (b.track || 0));
  const totalDur = sorted.reduce((s, t) => s + t.duration, 0);
  const heroEl = document.createElement('div');
  heroEl.className = 'hero';
  heroEl.innerHTML = `
    <div class="hero-info">
      <div class="hero-label">Album</div>
      <div class="hero-title">${esc(album)}</div>
      <div class="hero-sub">${esc(artist)} • ${sorted[0].year || ''} • ${sorted.length} tracks • ${fmtTime(totalDur)}</div>
      <button class="primary-btn" id="albumPlay">▶ Play album</button>
    </div>
    <img class="hero-art" src="${sorted[0].artworkDataUrl || ''}" />
  `;
  viewport.appendChild(heroEl);
  viewport.appendChild(trackTable(sorted));
  setTimeout(() => document.getElementById('albumPlay').addEventListener('click', () => playFromList(sorted, 0)));
}

// ---- Artists ----
function renderArtists() {
  const artists = groupByArtist(library.tracks);
  viewport.appendChild(sectionTitle('Artists', `${artists.length} artists`));

  function buildCard({ artist, tracks }) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img class="card-art" loading="lazy" src="${tracks[0].artworkDataUrl || ''}" style="border-radius:50%" />
      <div class="card-title">${esc(artist)}</div>
      <div class="card-sub">${tracks.length} songs</div>
    `;
    card.addEventListener('click', () => {
      paintScreen(() => {
        viewport.appendChild(sectionTitle(artist, `${tracks.length} songs`));
        renderFilterableTrackList(viewport, tracks, `Search ${artist}…`);
      });
    });
    return card;
  }

  const groupId = (g) => g.artist;
  const gridHost = document.createElement('div');
  let currentFiltered = artists;
  function renderFiltered(q) {
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    gridHost.innerHTML = '';
    const filtered = q ? artists.filter((a) => a.artist.toLowerCase().includes(q)) : artists;
    currentFiltered = filtered;
    const selectOpts = selectMode ? { getId: groupId, onSelectChange: () => renderFiltered(q) } : null;
    renderCardGridLazy(gridHost, filtered, buildCard, 60, selectOpts);
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selectedGroups = currentFiltered.filter((g) => selectedIds.has(groupId(g)));
    const allTracks = selectedGroups.flatMap((g) => g.tracks);
    showBulkBar(selectedGroups.length, [
      { label: '➕ Queue all', onClick: () => {
        if (queue.length === 0) { playFromList(allTracks, 0); return; }
        queue.push(...allTracks);
        showToast(`Added ${allTracks.length} songs to queue`, '📑');
      } },
      { label: '➕ Add to playlist…', onClick: () => bulkAddToPlaylist(allTracks.map((t) => t.id)) },
    ]);
  }

  viewport.appendChild(gridToolbar('Search artists…', renderFiltered));
  viewport.appendChild(gridHost);
  renderFiltered('');
}

// ---- Genres ----
function renderGenres() {
  const genres = [...groupBy(library.tracks, (t) => t.genre || 'Unknown')];
  viewport.appendChild(sectionTitle('Genres', `${genres.length} genres`));

  function buildCard([genre, tracks]) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<img class="card-art" loading="lazy" src="${tracks[0].artworkDataUrl || ''}" /><div class="card-title">${esc(genre)}</div><div class="card-sub">${tracks.length} songs</div>`;
    card.addEventListener('click', () => {
      paintScreen(() => {
        viewport.appendChild(sectionTitle(genre, `${tracks.length} songs`));
        renderFilterableTrackList(viewport, tracks, `Search ${genre}…`);
      });
    });
    return card;
  }

  const groupId = ([genre]) => genre;
  const gridHost = document.createElement('div');
  let currentFiltered = genres;
  function renderFiltered(q) {
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    gridHost.innerHTML = '';
    const filtered = q ? genres.filter(([genre]) => genre.toLowerCase().includes(q)) : genres;
    currentFiltered = filtered;
    const selectOpts = selectMode ? { getId: groupId, onSelectChange: () => renderFiltered(q) } : null;
    renderCardGridLazy(gridHost, filtered, buildCard, 60, selectOpts);
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selectedGroups = currentFiltered.filter((g) => selectedIds.has(groupId(g)));
    const allTracks = selectedGroups.flatMap(([, tracks]) => tracks);
    showBulkBar(selectedGroups.length, [
      { label: '➕ Queue all', onClick: () => {
        if (queue.length === 0) { playFromList(allTracks, 0); return; }
        queue.push(...allTracks);
        showToast(`Added ${allTracks.length} songs to queue`, '📑');
      } },
      { label: '➕ Add to playlist…', onClick: () => bulkAddToPlaylist(allTracks.map((t) => t.id)) },
    ]);
  }

  viewport.appendChild(gridToolbar('Search genres…', renderFiltered));
  viewport.appendChild(gridHost);
  renderFiltered('');
}

// ---- Folders ----
function renderFolders() {
  viewport.appendChild(sectionTitle('Music Folders'));
  library.folders.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span>${esc(f)}</span><button data-f="${esc(f)}">Remove</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      library.folders = library.folders.filter((x) => x !== f);
      await persistLibrary();
      await rescan();
    });
    viewport.appendChild(row);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'primary-btn';
  addBtn.textContent = '+ Add Folder';
  addBtn.addEventListener('click', () => document.getElementById('addFolderBtn').click());
  viewport.appendChild(addBtn);

  const rescanBtn = document.createElement('button');
  rescanBtn.className = 'primary-btn';
  rescanBtn.style.marginLeft = '10px';
  rescanBtn.textContent = '↻ Rescan Library';
  rescanBtn.addEventListener('click', () => rescan());
  viewport.appendChild(rescanBtn);
}

// Reads an image file the user picked and returns a resized JPEG data URL,
// so playlist covers don't bloat library.json with full-resolution photos.
function readImageFileAsResizedDataUrl(file, maxDim = 600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image file'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- Playlists ----
function renderPlaylists() {
  viewport.appendChild(sectionTitle('Playlists', `${library.playlists.length} playlists`));
  const createBtn = document.createElement('button');
  createBtn.className = 'primary-btn';
  createBtn.textContent = '+ New Playlist';
  createBtn.addEventListener('click', async () => {
    const name = await promptModal('Playlist name:');
    if (!name) return;
    library.playlists.push({ id: 'pl_' + Date.now(), name, trackIds: [] });
    await persistLibrary();
    renderView('playlists');
  });
  viewport.appendChild(createBtn);

  const importBtn = document.createElement('button');
  importBtn.className = 'ghost-btn';
  importBtn.style.cssText = 'margin-left:10px;display:inline-block;';
  importBtn.textContent = '▶ Import from YouTube';
  importBtn.title = 'Paste a YouTube (or YouTube Music) playlist link to bring all its songs in as a new playlist — uses yt-dlp, no API key needed';
  importBtn.addEventListener('click', importYoutubePlaylistFlow);
  viewport.appendChild(importBtn);

  function buildCard(pl) {
    const tracks = pl.trackIds.map((id) => library.tracks.find((t) => t.id === id)).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.position = 'relative';
    card.innerHTML = `
      <img class="card-art" loading="lazy" src="${pl.coverImageDataUrl || (tracks[0] ? tracks[0].artworkDataUrl || '' : '')}" />
      <div class="card-title">${esc(pl.name)}</div>
      <div class="card-sub">${tracks.length} songs</div>
    `;
    card.addEventListener('click', () => renderPlaylistDetail(pl));

    const delBtn = document.createElement('button');
    delBtn.className = 'card-del-btn';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete playlist';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${pl.name}"? This only removes the playlist — the songs stay in your library.`)) return;
      library.playlists = library.playlists.filter((p) => p.id !== pl.id);
      await persistLibrary();
      renderView('playlists');
      showToast(`Deleted "${pl.name}"`, '🗑');
    });
    card.appendChild(delBtn);

    return card;
  }

  const gridHost = document.createElement('div');
  gridHost.style.marginTop = '18px';
  let currentFiltered = library.playlists;
  function renderFiltered() {
    virtualizedTableCleanups.forEach((fn) => fn());
    virtualizedTableCleanups = [];
    gridHost.innerHTML = '';
    currentFiltered = library.playlists;
    const selectOpts = selectMode ? { getId: (pl) => pl.id, onSelectChange: () => renderFiltered() } : null;
    renderCardGridLazy(gridHost, currentFiltered, buildCard, 60, selectOpts);
    if (!selectMode || selectedIds.size === 0) { removeBulkBar(); return; }
    const selected = currentFiltered.filter((pl) => selectedIds.has(pl.id));
    showBulkBar(selected.length, [
      { label: '🗑 Delete selected', onClick: async () => {
        if (!confirm(`Delete ${selected.length} playlist${selected.length === 1 ? '' : 's'}? The songs stay in your library.`)) return;
        const ids = new Set(selected.map((pl) => pl.id));
        library.playlists = library.playlists.filter((p) => !ids.has(p.id));
        await persistLibrary();
        clearSelection();
        renderView('playlists');
        showToast(`Deleted ${selected.length} playlist${selected.length === 1 ? '' : 's'}`, '🗑');
      } },
    ]);
  }

  const selectBtn = document.createElement('button');
  selectBtn.className = 'ghost-btn';
  selectBtn.style.cssText = 'margin-left:10px;display:inline-block;';
  selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
  selectBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    if (!selectMode) { selectedIds = new Set(); lastSelectedId = null; }
    selectBtn.textContent = selectMode ? '✕ Cancel select' : '☑ Select';
    renderFiltered();
  });
  viewport.appendChild(selectBtn);

  viewport.appendChild(gridHost);
  renderFiltered();
}

function renderPlaylistDetail(pl) {
  paintScreen(() => renderPlaylistDetailContent(pl));
}

function renderPlaylistDetailContent(pl) {
  const tracks = pl.trackIds.map((id) => library.tracks.find((t) => t.id === id)).filter(Boolean);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:18px;margin-bottom:18px;';

  const coverWrap = document.createElement('div');
  coverWrap.style.cssText = 'position:relative;width:120px;height:120px;flex-shrink:0;cursor:pointer;border-radius:10px;overflow:hidden;';
  const coverImg = document.createElement('img');
  coverImg.src = pl.coverImageDataUrl || (tracks[0] && tracks[0].artworkDataUrl) || '';
  coverImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:var(--bg-elev-2);';
  const coverOverlay = document.createElement('div');
  coverOverlay.textContent = '✏️ Change cover';
  coverOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);color:#fff;font-size:12px;text-align:center;padding:6px;opacity:0;transition:opacity .15s;';
  coverWrap.addEventListener('mouseenter', () => { coverOverlay.style.opacity = '1'; });
  coverWrap.addEventListener('mouseleave', () => { coverOverlay.style.opacity = '0'; });
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.accept = 'image/*';
  coverInput.style.display = 'none';
  coverInput.addEventListener('change', async () => {
    const file = coverInput.files[0];
    if (!file) return;
    try {
      pl.coverImageDataUrl = await readImageFileAsResizedDataUrl(file);
      await persistLibrary();
      refreshCurrentScreen();
    } catch (e) {
      showToast('Could not set cover image: ' + e.message, '⚠️');
    }
  });
  coverWrap.addEventListener('click', () => coverInput.click());
  coverWrap.appendChild(coverImg);
  coverWrap.appendChild(coverOverlay);
  coverWrap.appendChild(coverInput);

  const titleBlock = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'view-title';
  titleEl.textContent = pl.name;
  const subEl = document.createElement('div');
  subEl.className = 'view-sub';
  subEl.textContent = `${tracks.length} songs`;
  titleBlock.appendChild(titleEl);
  titleBlock.appendChild(subEl);

  header.appendChild(coverWrap);
  header.appendChild(titleBlock);
  viewport.appendChild(header);

  const addRow = document.createElement('div');
  addRow.style.marginBottom = '14px';
  const select = document.createElement('select');
  select.style.cssText = 'padding:8px;border-radius:8px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border);margin-right:8px;max-width:280px';
  select.innerHTML = `<option value="">Add a song…</option>` + library.tracks.map((t) => `<option value="${t.id}">${esc(t.title)} — ${esc(t.artist)}</option>`).join('');
  const addBtn = document.createElement('button');
  addBtn.className = 'primary-btn';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', async () => {
    if (!select.value) return;
    pl.trackIds.push(select.value);
    await persistLibrary();
    refreshCurrentScreen();
    showToast('Added to playlist', '📂');
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  viewport.appendChild(addRow);

  if (tracks.length) {
    const playBtn = document.createElement('button');
    playBtn.className = 'primary-btn';
    playBtn.textContent = '▶ Play playlist';
    playBtn.style.marginBottom = '14px';
    playBtn.addEventListener('click', () => playFromList(tracks, 0));
    viewport.appendChild(playBtn);
  }

  const deletePlBtn = document.createElement('button');
  deletePlBtn.className = 'ghost-btn';
  deletePlBtn.style.cssText = 'margin-left:10px;margin-bottom:14px;';
  deletePlBtn.textContent = '🗑 Delete playlist';
  deletePlBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${pl.name}"? This only removes the playlist — the songs stay in your library.`)) return;
    library.playlists = library.playlists.filter((p) => p.id !== pl.id);
    await persistLibrary();
    setActiveNavItem('playlists');
    renderView('playlists');
    showToast(`Deleted "${pl.name}"`, '🗑');
  });
  viewport.appendChild(deletePlBtn);

  renderFilterableTrackList(viewport, tracks, `Search in "${pl.name}"…`, {
    playlistContext: pl,
    reorderable: { onReorder: (draggedId, targetId, after) => movePlaylistTrack(pl, draggedId, targetId, after) },
  });
}

// Reorders a playlist's trackIds by moving `draggedId` next to `targetId`
// (after it if `after`, otherwise before). Operates on ids rather than
// on-screen indices, so it stays correct even while the list is filtered —
// dragging within search-narrowed results still moves the track to the
// right place in the playlist's real, unfiltered order.
function movePlaylistTrack(pl, draggedId, targetId, after) {
  if (draggedId === targetId) return;
  const ids = pl.trackIds;
  const fromIdx = ids.indexOf(draggedId);
  if (fromIdx === -1) return;
  ids.splice(fromIdx, 1);
  let toIdx = ids.indexOf(targetId);
  if (toIdx === -1) toIdx = ids.length;
  else if (after) toIdx += 1;
  ids.splice(toIdx, 0, draggedId);
  persistLibrary();
  refreshCurrentScreen();
}

// ---- Favorites ----
function renderFavorites() {
  const favTracks = library.tracks.filter((t) => library.favorites.songs.includes(t.id));
  viewport.appendChild(sectionTitle('❤️ Liked Songs', `${favTracks.length} songs`));
  if (favTracks.length) {
    const playBtn = document.createElement('button');
    playBtn.className = 'primary-btn';
    playBtn.textContent = '▶ Play all';
    playBtn.style.marginBottom = '14px';
    playBtn.addEventListener('click', () => playFromList(favTracks, 0));
    viewport.appendChild(playBtn);
  }
  renderFilterableTrackList(viewport, favTracks, 'Search liked songs…');
}

function toggleFavoriteSong(id) {
  const idx = library.favorites.songs.indexOf(id);
  const wasFav = idx >= 0;
  if (wasFav) library.favorites.songs.splice(idx, 1);
  else library.favorites.songs.push(id);
  persistLibrary();
  updateNowPlayingFavIcon();
  ['npFavBtn', 'npBigFav'].forEach((btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.remove('pop-anim');
    void btn.offsetWidth;
    btn.classList.add('pop-anim');
  });
  syncFavoriteButtonsForTrack(id, !wasFav);
}

// Updates any visible "tfav" heart buttons for this track in place, and — if
// we're currently looking at the Favorites list and a song was just
// unliked — fades that row out instead of doing a full page re-render.
function syncFavoriteButtonsForTrack(trackId, nowFav) {
  document.querySelectorAll('.track-row').forEach((row) => {
    if (row.dataset.trackId !== trackId) return;
    const btn = row.querySelector('.tfav');
    if (btn) {
      btn.textContent = nowFav ? '❤️' : '🤍';
      btn.setAttribute('data-tooltip', nowFav ? 'Remove from Liked Songs' : 'Add to Liked Songs');
      btn.classList.remove('pop-anim');
      void btn.offsetWidth;
      btn.classList.add('pop-anim');
    }
    if (currentView === 'favorites' && !nowFav) {
      row.classList.add('row-fade-out');
      row.addEventListener('animationend', () => {
        row.remove();
        const sub = viewport.querySelector('.view-sub');
        const count = library.favorites.songs.length;
        if (sub) sub.textContent = `${count} song${count === 1 ? '' : 's'}`;
        if (count === 0) refreshCurrentScreen();
      }, { once: true });
    }
  });

  // Same sync for the Home screen's card-grid hearts...
  document.querySelectorAll('.card[data-track-id]').forEach((card) => {
    if (card.dataset.trackId !== trackId) return;
    const btn = card.querySelector('.cfav');
    if (btn) {
      btn.textContent = nowFav ? '❤️' : '🤍';
      btn.setAttribute('data-tooltip', nowFav ? 'Remove from Liked Songs' : 'Add to Liked Songs');
    }
  });

  // ...and for not-yet-imported YouTube search results, which are keyed by
  // videoId rather than a library track id until they're materialized.
  document.querySelectorAll('.yt-result-card[data-video-id]').forEach((card) => {
    if (('yt:' + card.dataset.videoId) !== trackId) return;
    const btn = card.querySelector('.yt-result-fav');
    if (btn) {
      btn.textContent = nowFav ? '❤️' : '🤍';
      btn.setAttribute('data-tooltip', nowFav ? 'Remove from Liked Songs' : 'Add to Liked Songs');
    }
  });
}

// ---- Stats ----
function renderStats() {
  viewport.appendChild(sectionTitle('Your Music'));
  const totalHours = (library.stats.totalMs / 3600000).toFixed(1);
  const songsPlayed = library.stats.history.length;
  const uniqueArtists = new Set(library.tracks.map((t) => t.artist)).size;

  const counts = library.stats.playCounts;
  const topTrackId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const topTrack = library.tracks.find((t) => t.id === topTrackId);

  const artistCounts = {};
  library.stats.history.forEach((id) => {
    const t = library.tracks.find((tt) => tt.id === id);
    if (t) artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
  });
  const topArtist = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a])[0];

  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-num">${totalHours}</div><div class="stat-label">Hours Listened</div></div>
    <div class="stat-card"><div class="stat-num">${songsPlayed}</div><div class="stat-label">Songs Played</div></div>
    <div class="stat-card"><div class="stat-num">${uniqueArtists}</div><div class="stat-label">Unique Artists</div></div>
  `;
  viewport.appendChild(grid);

  const detail = document.createElement('div');
  detail.innerHTML = `
    <div class="settings-row"><label>Most played song</label><span>${topTrack ? esc(topTrack.title) : '—'}</span></div>
    <div class="settings-row"><label>Most played artist</label><span>${topArtist ? esc(topArtist) : '—'}</span></div>
  `;
  viewport.appendChild(detail);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'primary-btn';
  resetBtn.textContent = 'Reset Statistics';
  resetBtn.style.marginTop = '18px';
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset all listening statistics?')) return;
    library.stats = { playCounts: {}, history: [], totalMs: 0 };
    await persistLibrary();
    renderView('stats');
  });
  viewport.appendChild(resetBtn);
}

// ---- Settings ----
function renderSettings() {
  viewport.appendChild(sectionTitle('Settings'));

  const accentGroup = document.createElement('div');
  accentGroup.className = 'settings-group';
  accentGroup.innerHTML = `<div class="settings-row"><label>Accent color</label></div>`;
  const swatchRow = document.createElement('div');
  swatchRow.className = 'swatch-row';
  ACCENTS.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (settings.accent === c ? ' active' : '');
    sw.style.background = c;
    sw.addEventListener('click', async () => {
      settings.accent = c;
      applyAccent(c);
      await persistSettings();
      refreshCurrentScreen();
    });
    swatchRow.appendChild(sw);
  });
  accentGroup.appendChild(swatchRow);

  const dynColorRow = document.createElement('div');
  dynColorRow.className = 'settings-row';
  dynColorRow.style.marginTop = '10px';
  dynColorRow.innerHTML = `<label>Match accent color to album art</label><input type="checkbox" id="dynamicColorToggle" ${settings.dynamicColor ? 'checked' : ''}/>`;
  accentGroup.appendChild(dynColorRow);
  viewport.appendChild(accentGroup);
  setTimeout(() => {
    document.getElementById('dynamicColorToggle').addEventListener('change', async (e) => {
      settings.dynamicColor = e.target.checked;
      await persistSettings();
      if (settings.dynamicColor) {
        const track = queue[queueIndex];
        if (track) applyDynamicColorFromArt(track);
      } else {
        applyAccent(settings.accent);
      }
    });
  });

  const playbackGroup = document.createElement('div');
  playbackGroup.className = 'settings-group';
  playbackGroup.innerHTML = `
    <div class="settings-row">
      <label>Gapless playback</label>
      <input type="checkbox" id="gaplessToggle" ${settings.gapless ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Crossfade duration (seconds)</label>
      <input type="range" id="crossfadeRange" min="0" max="8" step="1" value="${Math.round(settings.crossfadeMs / 1000)}" style="width:140px" />
    </div>
  `;
  viewport.appendChild(playbackGroup);
  setTimeout(() => {
    document.getElementById('gaplessToggle').addEventListener('change', async (e) => {
      settings.gapless = e.target.checked;
      await persistSettings();
    });
    document.getElementById('crossfadeRange').addEventListener('input', async (e) => {
      settings.crossfadeMs = Number(e.target.value) * 1000;
      await persistSettings();
    });
  });

  // ---- Equalizer ----
  const eqGroup = document.createElement('div');
  eqGroup.className = 'settings-group';
  eqGroup.innerHTML = `<div class="section-title" style="margin:0 0 10px">Equalizer</div>`;

  const eqToggleRow = document.createElement('div');
  eqToggleRow.className = 'settings-row';
  eqToggleRow.innerHTML = `<label>Enable audio processing (EQ / Preamp)</label><input type="checkbox" id="eqEnabledToggle" ${settings.eq.enabled ? 'checked' : ''}/>`;
  eqGroup.appendChild(eqToggleRow);

  const presetRow = document.createElement('div');
  presetRow.className = 'settings-row';
  const presetSelect = document.createElement('select');
  presetSelect.id = 'eqPresetSelect';
  presetSelect.style.cssText = 'padding:6px 10px;border-radius:8px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border)';
  presetSelect.innerHTML = Object.keys(EQ_PRESETS).map((p) => `<option value="${p}" ${settings.eq.preset === p ? 'selected' : ''}>${p}</option>`).join('') + `<option value="Custom" ${settings.eq.preset === 'Custom' ? 'selected' : ''}>Custom</option>`;
  presetRow.innerHTML = `<label>Preset</label>`;
  presetRow.appendChild(presetSelect);
  eqGroup.appendChild(presetRow);

  const preampRow = document.createElement('div');
  preampRow.className = 'settings-row';
  preampRow.innerHTML = `<label>Preamp (${settings.eq.preamp} dB)</label><input type="range" id="preampRange" min="-12" max="12" step="1" value="${settings.eq.preamp}" style="width:160px" />`;
  eqGroup.appendChild(preampRow);

  const bandsWrap = document.createElement('div');
  bandsWrap.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:8px;padding:18px 4px 6px;background:var(--bg-elev);border-radius:10px;margin-top:10px';
  EQ_FREQS.forEach((freq, i) => {
    const col = document.createElement('div');
    col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:1';
    const val = document.createElement('div');
    val.className = 'eq-val';
    val.style.cssText = 'font-size:10px;color:var(--text-faint)';
    val.textContent = `${settings.eq.bands[i]}`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = -12; slider.max = 12; slider.step = 1;
    slider.value = settings.eq.bands[i];
    slider.className = 'eq-band-slider';
    slider.dataset.idx = i;
    slider.style.cssText = 'writing-mode: vertical-lr; direction: rtl; width: 20px; height: 90px;';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:10px;color:var(--text-faint)';
    label.textContent = freq >= 1000 ? `${freq / 1000}k` : freq;
    col.appendChild(val);
    col.appendChild(slider);
    col.appendChild(label);
    bandsWrap.appendChild(col);
  });
  eqGroup.appendChild(bandsWrap);

  const resetEqBtn = document.createElement('button');
  resetEqBtn.className = 'ghost-btn';
  resetEqBtn.style.marginTop = '12px';
  resetEqBtn.textContent = '↺ Restore Default EQ';
  resetEqBtn.addEventListener('click', async () => {
    settings.eq = { enabled: true, preset: 'Flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    applyEqToGraph();
    await persistSettings();
    showToast('EQ restored to default', '↺');
    refreshCurrentScreen();
  });
  eqGroup.appendChild(resetEqBtn);
  viewport.appendChild(eqGroup);

  setTimeout(() => {
    document.getElementById('eqEnabledToggle').addEventListener('change', async (e) => {
      settings.eq.enabled = e.target.checked;
      applyEqToGraph();
      await persistSettings();
    });
    presetSelect.addEventListener('change', async (e) => {
      const preset = e.target.value;
      settings.eq.preset = preset;
      if (EQ_PRESETS[preset]) {
        settings.eq.bands = [...EQ_PRESETS[preset]];
        applyEqToGraph();
        await persistSettings();
        refreshCurrentScreen();
      }
    });
    document.getElementById('preampRange').addEventListener('input', async (e) => {
      settings.eq.preamp = Number(e.target.value);
      preampRow.querySelector('label').textContent = `Preamp (${settings.eq.preamp} dB)`;
      applyEqToGraph();
      await persistSettings();
    });
    document.querySelectorAll('.eq-band-slider').forEach((slider) => {
      slider.addEventListener('input', async (e) => {
        const idx = Number(e.target.dataset.idx);
        settings.eq.bands[idx] = Number(e.target.value);
        settings.eq.preset = 'Custom';
        presetSelect.value = 'Custom';
        e.target.parentElement.querySelector('.eq-val').textContent = settings.eq.bands[idx];
        applyEqToGraph();
        await persistSettings();
      });
    });
  });

  // ---- ReplayGain / output device ----
  const audioGroup = document.createElement('div');
  audioGroup.className = 'settings-group';
  audioGroup.innerHTML = `
    <div class="settings-row">
      <label>ReplayGain / loudness normalization</label>
      <input type="checkbox" id="replayGainToggle" ${settings.replayGainEnabled ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Show notification on track change</label>
      <input type="checkbox" id="notificationsToggle" ${settings.notificationsEnabled ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Balance (${settings.balance < 0 ? 'L' : settings.balance > 0 ? 'R' : 'C'} ${Math.abs(Math.round(settings.balance * 100))})</label>
      <input type="range" id="balanceRange" min="-100" max="100" step="1" value="${Math.round((settings.balance || 0) * 100)}" style="width:160px" />
    </div>
    <div class="settings-row">
      <label>Mono audio (downmix L+R)</label>
      <input type="checkbox" id="monoToggle" ${settings.monoMode ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Output device</label>
      <select id="outputDeviceSelect" style="padding:6px 10px;border-radius:8px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border);max-width:220px">
        <option value="default">System default</option>
      </select>
    </div>
  `;
  viewport.appendChild(audioGroup);
  setTimeout(async () => {
    document.getElementById('replayGainToggle').addEventListener('change', async (e) => {
      settings.replayGainEnabled = e.target.checked;
      const track = queue[queueIndex];
      if (track) applyReplayGain(track);
      await persistSettings();
    });
    document.getElementById('notificationsToggle').addEventListener('change', async (e) => {
      settings.notificationsEnabled = e.target.checked;
      await persistSettings();
    });
    document.getElementById('balanceRange').addEventListener('input', async (e) => {
      settings.balance = Number(e.target.value) / 100;
      ensureAudioGraph();
      applyBalance();
      const label = e.target.previousElementSibling;
      const pct = Math.abs(Math.round(settings.balance * 100));
      label.textContent = `Balance (${settings.balance < 0 ? 'L' : settings.balance > 0 ? 'R' : 'C'} ${pct})`;
      await persistSettings();
    });
    document.getElementById('monoToggle').addEventListener('change', async (e) => {
      settings.monoMode = e.target.checked;
      ensureAudioGraph();
      applyMono();
      await persistSettings();
    });
    const sel = document.getElementById('outputDeviceSelect');
    const devices = await refreshOutputDevices();
    devices.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output device (${d.deviceId.slice(0, 6)})`;
      if (d.deviceId === settings.outputDeviceId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', async (e) => {
      settings.outputDeviceId = e.target.value;
      ensureAudioGraph();
      await applyOutputDevice(settings.outputDeviceId);
      await persistSettings();
    });
  });

  const libGroup = document.createElement('div');
  libGroup.className = 'settings-group';
  libGroup.innerHTML = `<div class="settings-row"><label>Music folders</label><span>${library.folders.length}</span></div>`;
  const manageBtn = document.createElement('button');
  manageBtn.className = 'ghost-btn';
  manageBtn.style.marginTop = '12px';
  manageBtn.textContent = 'Manage Folders';
  manageBtn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'folders'));
    renderView('folders');
  });
  libGroup.appendChild(manageBtn);
  viewport.appendChild(libGroup);

  // ---- General / QoL ----
  const generalGroup = document.createElement('div');
  generalGroup.className = 'settings-group';
  generalGroup.innerHTML = `
    <div class="settings-row">
      <label>Resume playback on launch</label>
      <input type="checkbox" id="resumeOnLaunchToggle" ${settings.resumeOnLaunch ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Confirm before removing/deleting items</label>
      <input type="checkbox" id="confirmDestructiveToggle" ${settings.confirmDestructive ? 'checked' : ''}/>
    </div>
    <div class="settings-row">
      <label>Track list density</label>
      <select id="rowDensitySelect" style="padding:6px 10px;border-radius:8px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border)">
        <option value="comfortable" ${settings.rowDensity === 'comfortable' ? 'selected' : ''}>Comfortable</option>
        <option value="compact" ${settings.rowDensity === 'compact' ? 'selected' : ''}>Compact</option>
      </select>
    </div>
    <div class="settings-row">
      <label>Startup view</label>
      <select id="defaultViewSelect" style="padding:6px 10px;border-radius:8px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border)">
        ${['home', 'songs', 'albums', 'artists', 'genres', 'playlists', 'favorites', 'stats'].map((v) =>
          `<option value="${v}" ${settings.defaultView === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`
        ).join('')}
      </select>
    </div>
  `;
  viewport.appendChild(generalGroup);
  setTimeout(() => {
    document.getElementById('resumeOnLaunchToggle').addEventListener('change', async (e) => {
      settings.resumeOnLaunch = e.target.checked;
      await persistSettings();
    });
    document.getElementById('confirmDestructiveToggle').addEventListener('change', async (e) => {
      settings.confirmDestructive = e.target.checked;
      await persistSettings();
    });
    document.getElementById('rowDensitySelect').addEventListener('change', async (e) => {
      settings.rowDensity = e.target.value;
      document.body.classList.toggle('density-compact', settings.rowDensity === 'compact');
      await persistSettings();
    });
    document.getElementById('defaultViewSelect').addEventListener('change', async (e) => {
      settings.defaultView = e.target.value;
      await persistSettings();
    });
  });

  const shortcutsBtn = document.createElement('button');
  shortcutsBtn.className = 'ghost-btn';
  shortcutsBtn.style.marginTop = '6px';
  shortcutsBtn.textContent = '⌨️ Keyboard Shortcuts';
  shortcutsBtn.addEventListener('click', openShortcutsModal);
  viewport.appendChild(shortcutsBtn);

  // ---- YouTube Search ----
  const ytGroup = document.createElement('div');
  ytGroup.className = 'settings-group';
  ytGroup.style.marginTop = '26px';
  ytGroup.innerHTML = `
    <div class="section-title" style="margin:0 0 10px">YouTube Search</div>
    <label style="display:flex;flex-direction:column;gap:6px;font-size:11.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.03em">
      YouTube Data API Key
      <input id="ytApiKeyInput" type="text" value="${esc(settings.youtubeApiKey || '')}" placeholder="Paste your API key" autocomplete="off" spellcheck="false"
        style="text-transform:none;letter-spacing:normal;padding:9px 12px;border-radius:8px;background:var(--bg-elev-2);border:1px solid var(--border);color:var(--text);font-size:13px" />
    </label>
    <div style="font-size:11.5px;color:var(--text-faint);margin-top:8px;line-height:1.5">
      Optional. Search and playlist import use yt-dlp first, which needs no key and burns no quota — this key is only a fallback for when yt-dlp isn't installed or fails. Free from Google Cloud Console (enable "YouTube Data API v3"), roughly 100 searches/day on the free tier. Stored locally and never leaves your machine except to call YouTube's API.
    </div>
    <div id="ytApiKeyStatus" style="font-size:12px;margin-top:8px;min-height:16px"></div>
  `;
  viewport.appendChild(ytGroup);
  setTimeout(() => {
    const input = document.getElementById('ytApiKeyInput');
    const status = document.getElementById('ytApiKeyStatus');
    let saveTimer;
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      status.textContent = '';
      saveTimer = setTimeout(async () => {
        settings.youtubeApiKey = input.value.trim();
        await persistSettings();
        status.textContent = settings.youtubeApiKey ? '✓ Saved' : '';
        status.style.color = 'var(--accent)';
      }, 500);
    });
  });
}

// ---------- Playback engine ----------
let preloadedStandbyIndex = -1; // queueIndex the standby player currently holds, or -1

async function playFromList(list, index) {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  queue = [...list];
  queueIndex = index;
  preloadedStandbyIndex = -1;
  if (shuffleMode !== 'off') { preShuffleQueue = [...queue]; reshuffleUpcoming(); }
  await hardLoadAndPlay(activeKey, queueIndex);
}

// Hard switch: stop everything, load a track fresh into the given player key, play it as the active one.
async function hardLoadAndPlay(key, index, options = {}) {
  const { autoplay = true, seekTo = null } = options;
  crossfading = false;
  const track = queue[index];
  if (!track) return;
  activeKey = key;
  maintainQueueWindow();
  refreshQueuePanelIfOpen();

  if (track.source === 'youtube') {
    stopLocalPlayback();
    preloadedStandbyIndex = -1;
    await loadAndPlayYoutubeTrack(track, { autoplay, seekTo });
    if (autoplay) registerPlay(track);
    updateNowPlayingUI(track, { silent: !autoplay });
    loadLyrics(track);
    updatePlayingHighlight();
    return;
  }
  stopYoutubePlayback();

  const p = players[key];
  const other = players[key === 'A' ? 'B' : 'A'];
  other.el.pause();
  other.trackGain.gain.cancelScheduledValues(audioCtx.currentTime);
  other.trackGain.gain.value = 1;
  preloadedStandbyIndex = -1;

  const url = await window.api.getFileUrl(track.path);
  p.trackGain.gain.cancelScheduledValues(audioCtx.currentTime);
  p.trackGain.gain.value = 1;
  p.el.src = url;
  applyReplayGain(track);

  if (seekTo != null) {
    await new Promise((resolve) => {
      const onMeta = () => { p.el.currentTime = seekTo; p.el.removeEventListener('loadedmetadata', onMeta); resolve(); };
      p.el.addEventListener('loadedmetadata', onMeta);
      setTimeout(resolve, 2000); // safety timeout
    });
  }

  if (autoplay) {
    await p.el.play().catch(() => {});
    registerPlay(track);
  }
  updateNowPlayingUI(track, { silent: !autoplay });
  loadLyrics(track);
  updatePlayingHighlight();
}

function applyReplayGain(track) {
  if (!replayGainNode) return;
  if (settings.replayGainEnabled && typeof track.replayGainTrackDb === 'number') {
    const gain = Math.min(4, Math.max(0.1, dbToGain(track.replayGainTrackDb)));
    replayGainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.05);
  } else {
    replayGainNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05);
  }
}

function computeNextIndex() {
  if (queue.length === 0) return -1;
  // `queue` is kept physically reordered to match shuffle mode (see reshuffleUpcoming),
  // so advancing is always just "the next slot in the array" regardless of mode.
  let idx = queueIndex + 1;
  if (idx >= queue.length) {
    if (repeatMode === 'all') idx = 0;
    else return -1;
  }
  return idx;
}

function shuffleArrayInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Builds a full weighted-random order for `tracks`, reusing the same weighting
// rules the old per-song smart shuffle used (avoid same artist back-to-back,
// avoid recently played, favor favorites and less-played tracks) but computed
// once as a whole sequence so the queue panel can show it.
function computeSmartOrder(tracks, referenceTrack) {
  const recentIds = new Set(library.stats.history.slice(-15));
  const pool = [...tracks];
  const order = [];
  let current = referenceTrack;
  while (pool.length) {
    const weights = pool.map((t) => {
      let w = 10;
      if (current && t.artist === current.artist) w *= 0.15;
      if (recentIds.has(t.id)) w *= 0.2;
      if (library.favorites.songs.includes(t.id)) w *= 2.2;
      const plays = library.stats.playCounts[t.id] || 0;
      w *= 1 / (1 + plays * 0.15);
      return Math.max(w, 0.01);
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    let pick = pool.length - 1;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) { pick = i; break; }
    }
    current = pool[pick];
    order.push(current);
    pool.splice(pick, 1);
  }
  return order;
}

// Physically reorders `queue` so everything after the current track matches
// what shuffle will actually play next. Called whenever shuffle is toggled on
// or the current track advances, so the queue panel always reflects reality.
// Guards against re-rolling into the exact same order as last time — with
// pure randomness that's rare but not impossible, and the whole point of
// hitting shuffle again is to actually get something different.
let lastShuffleOrderKey = null;

function reshuffleUpcoming() {
  if (queue.length === 0 || shuffleMode === 'off') return;
  const head = queue.slice(0, queueIndex + 1);
  const base = queue.slice(queueIndex + 1);
  let tail = base;

  if (base.length > 1) {
    let attempts = 0;
    do {
      tail = shuffleMode === 'random' ? shuffledCopy(base) : computeSmartOrder(base, queue[queueIndex]);
      attempts++;
    } while (attempts < 5 && shuffleOrderKey(tail) === lastShuffleOrderKey);
  }

  lastShuffleOrderKey = shuffleOrderKey(tail);
  queue = head.concat(tail);
}

function shuffledCopy(arr) {
  const copy = [...arr];
  shuffleArrayInPlace(copy);
  return copy;
}

function shuffleOrderKey(tracks) {
  return tracks.map((t) => t.id).join('|');
}

// Keeps the queue feeling like an endless timeline rather than a finite
// playlist that eventually runs out: tops up upcoming tracks well before
// they'd actually be exhausted (pulling more from the library with the same
// smart-shuffle weighting used elsewhere), and trims off very old history so
// the array — and what gets persisted with the session — doesn't grow
// forever over a long-running listening session. Already-played history
// within that window is never touched, so it stays browsable.
const QUEUE_LOOKAHEAD = 5;
const MAX_QUEUE_HISTORY = 200;

function maintainQueueWindow() {
  if (queue.length === 0) return;

  if (repeatMode !== 'one') {
    const remaining = queue.length - 1 - queueIndex;
    if (remaining < QUEUE_LOOKAHEAD && library.tracks.length > 0) {
      const inQueueIds = new Set(queue.map((t) => t.id));
      let pool = library.tracks.filter((t) => !inQueueIds.has(t.id));
      // If literally every library track is already somewhere in the queue,
      // allow repeats rather than ever letting the timeline dead-end.
      if (pool.length === 0) pool = library.tracks;
      const toAdd = Math.min(QUEUE_LOOKAHEAD - remaining, pool.length);
      if (toAdd > 0) {
        const extension = computeSmartOrder(pool, queue[queueIndex]).slice(0, toAdd);
        queue.push(...extension);
      }
    }
  }

  if (queueIndex > MAX_QUEUE_HISTORY) {
    const excess = queueIndex - MAX_QUEUE_HISTORY;
    queue.splice(0, excess);
    queueIndex -= excess;
  }
}

function refreshQueuePanelIfOpen() {
  const panel = document.getElementById('queuePanel');
  if (panel && !panel.classList.contains('hidden')) renderQueuePanel();
}

function onTimeUpdate(key) {
  if (key !== activeKey) return; // ignore standby element's own timeupdate while preloading
  const p = players[activeKey];
  const el = p.el;
  if (!el.duration) return;

  updateLyricHighlight(el.currentTime);

  const remaining = el.duration - el.currentTime;
  const nextIdx = computeNextIndex();
  if (nextIdx === -1 || repeatMode === 'one') return;
  if (queue[nextIdx] && queue[nextIdx].source === 'youtube') return; // let it end naturally; hardLoadAndPlay handles the source switch
  if (sleepTimer.mode === 'endOfSong') return;
  if (sleepTimer.mode === 'endOfAlbum') {
    const cur = queue[queueIndex], nxt = queue[nextIdx];
    if (!nxt || nxt.album !== cur.album || nxt.albumArtist !== cur.albumArtist) return;
  }

  if (settings.crossfadeMs > 0) {
    const cfSec = settings.crossfadeMs / 1000;
    if (remaining <= cfSec && !crossfading) {
      startCrossfade(nextIdx, cfSec);
    }
  } else if (settings.gapless) {
    if (remaining <= 1.2 && preloadedStandbyIndex !== nextIdx) {
      preloadStandby(nextIdx);
    }
  }
}

async function preloadStandby(nextIdx) {
  const next = queue[nextIdx];
  if (!next) return;
  preloadedStandbyIndex = nextIdx;
  const sp = standbyPlayer();
  const url = await window.api.getFileUrl(next.path);
  sp.el.src = url;
  sp.el.load();
}

async function startCrossfade(nextIdx, cfSec) {
  const next = queue[nextIdx];
  if (!next) return;
  crossfading = true;
  const from = activePlayer();
  const toKey = standbyKey();
  const to = players[toKey];

  const url = await window.api.getFileUrl(next.path);
  to.el.src = url;
  to.trackGain.gain.cancelScheduledValues(audioCtx.currentTime);
  to.trackGain.gain.setValueAtTime(0, audioCtx.currentTime);
  applyReplayGain(next);
  await to.el.play().catch(() => {});

  const now = audioCtx.currentTime;
  from.trackGain.gain.cancelScheduledValues(now);
  from.trackGain.gain.setValueAtTime(from.trackGain.gain.value, now);
  from.trackGain.gain.linearRampToValueAtTime(0, now + cfSec);
  to.trackGain.gain.linearRampToValueAtTime(1, now + cfSec);

  updateNowPlayingUI(next);
  registerPlay(next);
  loadLyrics(next);

  setTimeout(() => {
    from.el.pause();
    from.trackGain.gain.value = 1;
    activeKey = toKey;
    queueIndex = nextIdx;
    preloadedStandbyIndex = -1;
    crossfading = false;
    reshuffleUpcoming();
    refreshQueuePanelIfOpen();
    updatePlayingHighlight();
  }, cfSec * 1000 + 60);
}

function onEnded(key) {
  if (key !== activeKey || crossfading) return;
  library.stats.totalMs += (players[key].el.duration || 0) * 1000;
  const justFinished = queue[queueIndex];
  const nextIdx = computeNextIndex();

  if (repeatMode === 'one') {
    if (checkSleepTimerOnTrackEnd(justFinished, justFinished)) return;
    hardLoadAndPlay(activeKey, queueIndex);
    return;
  }

  const nextTrackForSleepCheck = nextIdx === -1 ? null : queue[nextIdx];
  if (checkSleepTimerOnTrackEnd(justFinished, nextTrackForSleepCheck)) return;

  if (nextIdx === -1) {
    document.getElementById('playBtn').classList.remove('is-playing');
    document.getElementById('npBigPlay')?.classList.remove('is-playing');
    return;
  }

  // If we already gaplessly preloaded the standby element with this track, just flip to it.
  if (shuffleMode === 'off' && settings.crossfadeMs === 0 && settings.gapless && preloadedStandbyIndex === nextIdx) {
    const sKey = standbyKey();
    const sp = players[sKey];
    activeKey = sKey;
    queueIndex = nextIdx;
    preloadedStandbyIndex = -1;
    applyReplayGain(queue[nextIdx]);
    sp.el.play().catch(() => {});
    updateNowPlayingUI(queue[nextIdx]);
    registerPlay(queue[nextIdx]);
    loadLyrics(queue[nextIdx]);
    reshuffleUpcoming();
    refreshQueuePanelIfOpen();
    updatePlayingHighlight();
  } else {
    queueIndex = nextIdx;
    reshuffleUpcoming();
    refreshQueuePanelIfOpen();
    hardLoadAndPlay(activeKey, queueIndex);
  }
}

function registerPlay(track) {
  library.stats.playCounts[track.id] = (library.stats.playCounts[track.id] || 0) + 1;
  library.stats.history.push(track.id);
  if (library.stats.history.length > 500) library.stats.history.shift();
  persistLibrary();
}

function updateNowPlayingUI(track, opts = {}) {
  resetNpVideoModeForNewTrack();
  document.getElementById('npArt').src = track.artworkDataUrl || '';
  document.getElementById('npTitle').textContent = track.title;
  document.getElementById('npArtist').textContent = track.artist;
  updateNowPlayingFavIcon();

  const bits = [track.format];
  if (track.lossless) bits.push('Lossless');
  if (track.bitDepth) bits.push(`${track.bitDepth}-bit`);
  if (track.sampleRate) bits.push(`${(track.sampleRate / 1000).toFixed(1)}kHz`);
  document.getElementById('qualityBadge').textContent = bits.join(' • ');

  applyDynamicColorFromArt(track);

  if (settings.notificationsEnabled && !opts.silent) {
    window.api.notifyTrackChange({
      title: track.title,
      artist: track.artist,
      album: track.album,
      qualityLine: bits.join(' • '),
      artworkDataUrl: track.artworkDataUrl,
    });
  }
}

function updateNowPlayingFavIcon() {
  const track = queue[queueIndex];
  const btn = document.getElementById('npFavBtn');
  const bigBtn = document.getElementById('npBigFav');
  const isFav = !!track && library.favorites.songs.includes(track.id);
  btn.classList.toggle('is-fav', isFav);
  btn.dataset.tooltip = isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs';
  if (bigBtn) {
    bigBtn.classList.toggle('is-fav', isFav);
    bigBtn.dataset.tooltip = isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs';
  }
  refreshDynamicTooltips();
}

function nextTrack(auto) {
  if (queue.length === 0) return;
  const idx = computeNextIndex();
  if (idx === -1) { pausePlayback(); return; }
  queueIndex = idx;
  reshuffleUpcoming();
  refreshQueuePanelIfOpen();
  hardLoadAndPlay(activeKey, queueIndex);
}

function prevTrack() {
  if (queue.length === 0) return;
  if (getPlaybackCurrentTime() > 3) { seekPlaybackTo(0); return; }
  queueIndex = Math.max(0, queueIndex - 1);
  hardLoadAndPlay(activeKey, queueIndex);
}

// ---------- Transport wiring ----------
function wireTransport() {
  const playBtn = document.getElementById('playBtn');
  playBtn.addEventListener('click', async () => {
    if (queue.length === 0) return;
    ensureAudioGraph();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const wasPaused = isPlaybackPaused();
    togglePlayPause();
    if (!wasPaused) persistSessionState(); // just paused
    refreshDynamicTooltips();
  });

  document.getElementById('nextBtn').addEventListener('click', () => nextTrack(false));
  document.getElementById('prevBtn').addEventListener('click', () => prevTrack());

  const shuffleBtn = document.getElementById('shuffleBtn');
  shuffleBtn.addEventListener('click', () => {
    const wasOff = shuffleMode === 'off';
    shuffleMode = shuffleMode === 'off' ? 'random' : shuffleMode === 'random' ? 'smart' : 'off';
    syncShuffleRepeatUI();

    if (wasOff && shuffleMode !== 'off') {
      preShuffleQueue = [...queue]; // remember the original order to restore later
      reshuffleUpcoming();
    } else if (!wasOff && shuffleMode === 'off' && preShuffleQueue) {
      const currentTrack = queue[queueIndex];
      queue = preShuffleQueue;
      preShuffleQueue = null;
      const restoredIdx = queue.findIndex((t) => t === currentTrack);
      queueIndex = restoredIdx === -1 ? queueIndex : restoredIdx;
    } else if (shuffleMode !== 'off') {
      reshuffleUpcoming(); // switched random <-> smart: reorder upcoming with the new mode
    }
    refreshQueuePanelIfOpen();
    refreshDynamicTooltips();
  });

  const repeatBtn = document.getElementById('repeatBtn');
  repeatBtn.addEventListener('click', () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    syncShuffleRepeatUI();
    refreshDynamicTooltips();
  });

  document.getElementById('npFavBtn').addEventListener('click', () => {
    const track = queue[queueIndex];
    if (!track) return;
    toggleFavoriteSong(track.id);
  });

  document.getElementById('seekBar').addEventListener('input', (e) => {
    const dur = getPlaybackDuration();
    if (!dur) return;
    seekPlaybackTo((e.target.value / 1000) * dur);
  });

  document.getElementById('volBar').addEventListener('input', async (e) => {
    const v = e.target.value / 100;
    document.getElementById('npBigVol').value = e.target.value;
    syncMuteIconUI(v);
    players.A && (players.A.el.volume = v);
    players.B && (players.B.el.volume = v);
    applyVolumeToYtPlayer(v);
    settings.volume = v;
    await persistSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    if (e.code === 'ArrowRight' && e.shiftKey) nextTrack(false);
    if (e.code === 'ArrowLeft' && e.shiftKey) prevTrack();
    if (e.key.toLowerCase() === 's') shuffleBtn.click();
    if (e.key.toLowerCase() === 'r') repeatBtn.click();
    if (e.key.toLowerCase() === 'l') document.getElementById('lyricsBtn').click();
    if (e.key.toLowerCase() === 'q') document.getElementById('queueBtn').click();
  });
}

// ---------- Smooth progress + visualizer loop ----------
let overlayOpen = false;
let lastMiniPush = 0;

// Applies shuffleMode/repeatMode to every copy of the shuffle/repeat
// buttons — the mini now-playing bar's and the immersive overlay's — since
// npBigShuffle/npBigRepeat only forward their clicks to the small ones
// (see wireControls) and never had their own visual state before.
function syncShuffleRepeatUI() {
  ['shuffleBtn', 'npBigShuffle'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('on', shuffleMode !== 'off');
    btn.classList.toggle('is-smart', shuffleMode === 'smart');
  });
  ['repeatBtn', 'npBigRepeat'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('on', repeatMode !== 'off');
    btn.classList.toggle('mode-one', repeatMode === 'one');
  });
}

// Same idea as syncShuffleRepeatUI but for the two volume/mute buttons
// (the small one in the nowbar and npBigMute in the immersive overlay).
function syncMuteIconUI(v) {
  ['muteBtnSmall', 'npBigMute'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('vol-muted', v === 0);
    btn.classList.toggle('vol-low', v > 0 && v < 0.5);
    btn.dataset.tooltip = v === 0 ? 'Unmute' : 'Mute';
  });
}

let lastPlayIconState = null;
function updatePlayButtonsUI() {
  const isPlaying = queue.length > 0 && !isPlaybackPaused();
  if (isPlaying === lastPlayIconState) return; // avoid clobbering ripple children every frame
  lastPlayIconState = isPlaying;
  const playBtn = document.getElementById('playBtn');
  const bigBtn = document.getElementById('npBigPlay');
  playBtn.classList.toggle('is-playing', isPlaying);
  bigBtn.classList.toggle('is-playing', isPlaying);
}

function startUiLoop() {
  let lastBadgeUpdate = 0;
  function tick() {
    updatePlayButtonsUI();
    const dur = getPlaybackDuration();
    if (dur) {
      if (!isCurrentYoutube()) enforceAbLoop(); // A/B loop only applies to local playback
      const cur = getPlaybackCurrentTime();
      const pct = (cur / dur) * 1000;
      const curT = fmtTime(cur);
      const remT = '-' + fmtTime(dur - cur);
      document.getElementById('seekBar').value = pct;
      document.getElementById('curTime').textContent = curT;
      document.getElementById('remTime').textContent = remT;

      if (overlayOpen) {
        document.getElementById('npBigSeek').value = pct;
        document.getElementById('npBigCurTime').textContent = curT;
        document.getElementById('npBigRemTime').textContent = remT;
      }

      // Local tracks also get this from the <audio> element's own 'timeupdate'
      // event, but YouTube tracks have no such event (there's no <audio> tag
      // backing them) — this per-frame call is what keeps their lyric
      // highlight and fullscreen auto-scroll moving in time with playback.
      if (isCurrentYoutube()) updateLyricHighlight(cur);

      if (overlayOpen && npVideoMode && npVideoSource === 'local') syncLocalVideoToAudio();
    }

    // Cache YouTube's reported duration onto the track once known, so list views show real runtime
    if (isCurrentYoutube()) {
      const t = queue[queueIndex];
      if (t && !t.duration && ytPlayer && ytPlayerReady) {
        const d = ytPlayer.getDuration();
        if (d) { t.duration = d; persistLibrary(); }
      }
    }

    if (overlayOpen) {
      stepNpLyricsFocus();
      // The visualizer only has analyser data for local audio, and it's hidden
      // behind the video anyway while video mode is on.
      if (!isCurrentYoutube() && !npVideoMode) drawVisualizerFrame();
    }

    const now = performance.now();
    if (sleepTimer.mode === 'duration' && now - lastBadgeUpdate > 1000) {
      lastBadgeUpdate = now;
      updateSleepTimerBadge();
    }
    if (now - lastMiniPush > 100) {
      lastMiniPush = now;
      pushMiniPlayerState();
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function drawVisualizerFrame() {
  if (!analyser) return;
  analyser.getByteFrequencyData(analyserData);
  const canvas = document.getElementById('npVisualizer');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const n = analyserData.length;
  const bassEnd = Math.floor(n * 0.15);
  const midEnd = Math.floor(n * 0.5);
  let bass = 0, mid = 0, high = 0;
  for (let i = 0; i < bassEnd; i++) bass += analyserData[i];
  for (let i = bassEnd; i < midEnd; i++) mid += analyserData[i];
  for (let i = midEnd; i < n; i++) high += analyserData[i];
  bass /= bassEnd || 1; mid /= (midEnd - bassEnd) || 1; high /= (n - midEnd) || 1;

  // Circular spectrum around the art. The media frame is sized off a viewport
  // clamp rather than a fixed pixel box, so the ring's radius is derived from
  // however large the artwork actually is right now — otherwise the bars would
  // either hide behind the cover or float away from it as the window resizes.
  const cx = w / 2, cy = h / 2;
  const frameEl = document.getElementById('npMediaFrame');
  const unitsPerPx = w / (canvas.clientWidth || w);
  const frameHalf = ((frameEl ? frameEl.clientWidth : 320) / 2) * unitsPerPx;
  const baseRadius = Math.max(40, Math.min(w / 2 - 24, frameHalf * 1.02));
  const maxBarLen = Math.max(12, w / 2 - baseRadius - 6);
  const bars = 64;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < bars; i++) {
    const dataIdx = Math.floor((i / bars) * n * 0.85);
    const v = analyserData[dataIdx] / 255;
    const barLen = 6 + v * maxBarLen;
    const angle = (i / bars) * Math.PI * 2;
    ctx.rotate(i === 0 ? angle : (Math.PI * 2) / bars);
    ctx.beginPath();
    ctx.moveTo(0, -baseRadius);
    ctx.lineTo(0, -(baseRadius + barLen));
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35 + v * 0.65;
    ctx.stroke();
  }
  ctx.restore();

  // Pulse the art with bass energy
  const art = document.getElementById('npBigArt');
  const scale = 1 + Math.min(bass / 255, 1) * 0.045;
  art.style.transform = `scale(${scale.toFixed(4)})`;
}

// ---------- Immersive fullscreen: Now Playing + Lyrics ----------
// Both "Full Now Playing" and "Expand Lyrics to Fullscreen" share one true
// OS-level fullscreen session (see fsMode/enterFullscreenMode below) so that
// switching between them never touches the window, and the app only ever
// asks for/relinquishes native fullscreen at the outer edges of that session.
function wireOverlay() {
  document.getElementById('npArtWrap').addEventListener('click', () => enterFullscreenMode('now'));
  document.getElementById('npOverlayClose').addEventListener('click', closeFullscreenMode);
  document.getElementById('npOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'npOverlay') closeFullscreenMode();
  });

  document.getElementById('npBigPlay').addEventListener('click', () => document.getElementById('playBtn').click());
  document.getElementById('npBigNext').addEventListener('click', () => nextTrack(false));
  document.getElementById('npBigPrev').addEventListener('click', () => prevTrack());
  document.getElementById('npBigShuffle').addEventListener('click', () => document.getElementById('shuffleBtn').click());
  document.getElementById('npBigRepeat').addEventListener('click', () => document.getElementById('repeatBtn').click());
  document.getElementById('npBigSeek').addEventListener('input', (e) => {
    const dur = getPlaybackDuration();
    if (!dur) return;
    seekPlaybackTo((e.target.value / 1000) * dur);
  });

  document.getElementById('npBigFav').addEventListener('click', () => document.getElementById('npFavBtn').click());

  // Volume and mute both drive the main bar's controls rather than the audio
  // graph directly, so there's still exactly one place that owns volume.
  const bigVol = document.getElementById('npBigVol');
  bigVol.addEventListener('input', () => {
    const volBar = document.getElementById('volBar');
    volBar.value = bigVol.value;
    volBar.dispatchEvent(new Event('input'));
  });
  document.getElementById('npBigMute').addEventListener('click', () => toggleMute());
  document.getElementById('muteBtnSmall').addEventListener('click', () => toggleMute());

  document.getElementById('npVideoToggle').addEventListener('click', () => toggleNpVideoMode());

  // If the attached file turns out to be unplayable (a codec Chromium doesn't
  // decode, a moved file), fall back to the artwork rather than sitting on a
  // black frame.
  document.getElementById('npVideo').addEventListener('error', () => {
    if (npVideoSource !== 'local' || !npVideoMode) return;
    setNpVideoMode(false);
    showToast("That music video file couldn't be played", '⚠️');
  });

  // V toggles artwork/video while the Now Playing view is up.
  document.addEventListener('keydown', (e) => {
    if (fsMode !== 'now' || e.target.tagName === 'INPUT') return;
    if (e.key.toLowerCase() === 'v') { e.preventDefault(); toggleNpVideoMode(); }
  });

  // Keep the docked YouTube player glued to the media frame if the window
  // changes size underneath it.
  window.addEventListener('resize', () => { if (npVideoMode && npVideoSource === 'youtube') positionDockedYtWidget(); });
}

// ---- Shared fullscreen-mode state machine ----
// fsMode: which immersive layer is currently on screen ('lyrics' | 'now' | null).
// fsPreferred: the mode the user actually asked for. It only changes when the
// person explicitly opens one of the two views; the automatic lyrics<->now
// switching (see finishLyricsLoad) never touches it, so "Expand Lyrics" always
// snaps back to lyrics once a lyrics-having track comes back around.
// nativeFullscreen mirrors the real OS/window fullscreen state (kept in sync
// via app:fullscreenChanged from main.js, which fires for F11 too).
// ownsNativeFullscreen is true only when *we* turned native fullscreen on to
// support the overlay, so closing the overlay knows whether it should also
// turn native fullscreen back off, or leave it as the user had it.
let fsMode = null;
let fsPreferred = 'lyrics';
let nativeFullscreen = false;
let ownsNativeFullscreen = false;

function enterFullscreenMode(mode, opts = {}) {
  const { setPreferred = true, track: trackOverride = null } = opts;
  const track = trackOverride || queue[queueIndex];
  if (!track) return;
  if (setPreferred) fsPreferred = mode;
  if (fsMode === mode) return;

  if (fsMode === null && !nativeFullscreen) {
    window.api.setFullScreen(true);
    ownsNativeFullscreen = true;
  }

  if (mode === 'lyrics') {
    if (fsMode === 'now') hideNowPlayingOverlayDom();
    renderLyricsFullscreenContent(track);
    showLyricsFullscreenDom();
  } else {
    if (fsMode === 'lyrics') hideLyricsFullscreenDom();
    syncOverlayContent(track);
    showNowPlayingOverlayDom();
  }
  fsMode = mode;
}

function closeFullscreenMode() {
  if (fsMode === null) return;
  if (fsMode === 'lyrics') hideLyricsFullscreenDom();
  else hideNowPlayingOverlayDom();
  fsMode = null;
  if (ownsNativeFullscreen) window.api.setFullScreen(false);
  ownsNativeFullscreen = false;
}

// Called when native fullscreen ends for a reason other than us asking for it
// (F11, OS shortcut, window manager) — just fold the overlay state back to
// normal without asking the window to exit fullscreen a second time.
function onNativeFullscreenExited() {
  if (fsMode === 'lyrics') hideLyricsFullscreenDom();
  else if (fsMode === 'now') hideNowPlayingOverlayDom();
  fsMode = null;
  ownsNativeFullscreen = false;
}

function showNowPlayingOverlayDom() {
  const overlay = document.getElementById('npOverlay');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlayOpen = true;
}

function hideNowPlayingOverlayDom() {
  if (npVideoMode) setNpVideoMode(false); // never leave the YouTube player docked to a hidden frame
  document.getElementById('npOverlay').classList.remove('open');
  overlayOpen = false;
}

// Paints everything in the Now Playing view for `track`: the media stage,
// the title block, the availability of the video toggle, and the big lyrics
// column. Safe to call repeatedly — it's the single entry point used both on
// open and whenever the current track or its lyrics change underneath it.
let npLastSyncedTrackId = null;

function syncOverlayContent(track) {
  const trackChanged = track.id !== npLastSyncedTrackId;
  npLastSyncedTrackId = track.id;

  const art = document.getElementById('npBigArt');
  if (trackChanged && art.getAttribute('src')) {
    // Cross-fade the artwork itself rather than swapping the <img> src out
    // from under the user — the layer dips out, the new image goes in, the
    // layer comes back.
    const layer = document.getElementById('npArtLayer');
    layer.style.opacity = '0';
    setTimeout(() => {
      art.src = track.artworkDataUrl || '';
      layer.style.opacity = '';
    }, 200);
  } else {
    art.src = track.artworkDataUrl || '';
  }
  if (trackChanged) {
    const textEl = document.querySelector('.np-track-text');
    if (textEl) {
      textEl.classList.add('swapping');
      setTimeout(() => textEl.classList.remove('swapping'), 260);
    }
  }

  document.getElementById('npOverlayBg').style.backgroundImage = track.artworkDataUrl ? `url("${track.artworkDataUrl}")` : 'none';
  document.getElementById('npBigTitle').textContent = track.title;
  document.getElementById('npBigArtist').textContent = track.artist;

  const bits = [track.format];
  if (track.lossless) bits.push('Lossless');
  if (track.bitDepth) bits.push(`${track.bitDepth}-bit`);
  if (track.sampleRate) bits.push(`${(track.sampleRate / 1000).toFixed(1)}kHz`);
  document.getElementById('npBigQuality').textContent = bits.filter(Boolean).join(' • ') || '—';

  document.getElementById('npBigVol').value = document.getElementById('volBar').value;
  updateNowPlayingFavIcon();
  refreshNpVideoAvailability(track);

  // While lyrics are still loading for this track (lyricsHaveContent === null)
  // assume they might exist, so the layout doesn't flash to the centered
  // no-lyrics view and immediately flash back once the fetch resolves.
  const noLyrics = lyricsHaveContent === false && currentLyrics.length === 0 && currentPlainLines.length === 0;
  document.getElementById('npOverlayContent').classList.toggle('no-lyrics-mode', noLyrics);

  renderOverlayLyrics(track, { animate: trackChanged });
}

// ---------- Now Playing: focus-mode lyrics ----------
// Only ever two lines exist on screen: the one playing right now (rendered
// big, see the CSS for .active) and, once we're getting close to it, a small
// dim preview of the one after it. Every other line — including everything
// already sung — is simply not shown. This runs off the real transport clock
// each frame (stepNpLyricsFocus, called from startUiLoop) rather than off
// timeupdate events, so the upcoming line's fade-in is smooth regardless of
// how chunky the audio element's own timeupdate cadence is.
const NP_LYRIC_LEAD_IN = 2.4;   // seconds before a line starts that its preview begins appearing
const NP_LYRIC_PREVIEW_MAX = 0.6; // preview never gets brighter than this — it's a hint, not the main event
let npFocusActiveIdx = -2;      // sentinel so the very first frame always paints

function renderOverlayLyrics(track, { animate = false } = {}) {
  const stage = document.getElementById('npLyricsStage');
  const trackEl = document.getElementById('npLyricsTrack');
  if (!stage || !trackEl) return;

  const paint = () => {
    npFocusActiveIdx = -2;
    if (currentLyrics.length > 0) {
      stage.classList.remove('plain-mode');
      trackEl.innerHTML = currentLyrics
        .map((line) => `<div class="lyric-line${line.words && line.words.length ? ' word-synced' : ''}">${lyricLineToHtml(line)}</div>`)
        .join('');
      trackEl.querySelectorAll('.lyric-line').forEach((el, i) => {
        el.addEventListener('click', () => seekPlaybackTo(currentLyrics[i].time));
      });
      applyRomanizationToContainer(trackEl);
      stepNpLyricsFocus(); // paint the correct active/upcoming line immediately, no waiting for the next frame
    } else if (currentPlainLines.length > 0) {
      stage.classList.add('plain-mode');
      trackEl.innerHTML = currentPlainLines
        .map((line) => `<div class="lyric-line">${line ? renderLyricLineWordsHtml(line) : '♪'}</div>`)
        .join('');
      applyRomanizationToContainer(trackEl);
      document.getElementById('npLyricsViewport').scrollTop = 0;
    } else {
      stage.classList.add('plain-mode');
      const msg = lyricsHaveContent === null ? 'Loading lyrics…' : (lyricsStatusMessage || 'No lyrics found for this track.');
      const canSearch = lyricsHaveContent !== null;
      trackEl.innerHTML = `<div class="lyric-line lyrics-status">${esc(msg)}${
        canSearch ? `<br><a href="#" id="npNoLyricsSearchLink">Search for lyrics manually</a>` : ''
      }</div>`;
      const link = document.getElementById('npNoLyricsSearchLink');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); openLyricsMatchPicker(track); });
    }
    trackEl.classList.remove('swapping');
  };

  if (animate && trackEl.innerHTML.trim()) {
    trackEl.classList.add('swapping');
    setTimeout(paint, 220);
  } else {
    paint();
  }
}

// Runs once per frame while the overlay is open (called from startUiLoop).
function stepNpLyricsFocus() {
  const stage = document.getElementById('npLyricsStage');
  const trackEl = document.getElementById('npLyricsTrack');
  if (!stage || !trackEl || stage.classList.contains('plain-mode') || currentLyrics.length === 0) return;

  const t = getPlaybackCurrentTime();
  let activeIdx = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentLyrics[i].time <= t) activeIdx = i; else break;
  }
  const upcomingIdx = activeIdx + 1 < currentLyrics.length ? activeIdx + 1 : -1;
  const upcomingTime = upcomingIdx >= 0 ? currentLyrics[upcomingIdx].time : null;

  if (activeIdx !== npFocusActiveIdx) {
    npFocusActiveIdx = activeIdx;
    const lines = trackEl.children;
    for (let i = 0; i < lines.length; i++) {
      const el = lines[i];
      el.classList.toggle('active', i === activeIdx);
      el.classList.toggle('upcoming', i === upcomingIdx);
      if (i !== upcomingIdx) el.style.opacity = '';
      if (i === activeIdx) applyWordProgress(el, currentLyrics[i], upcomingTime, t);
    }
  } else if (activeIdx >= 0) {
    applyWordProgress(trackEl.children[activeIdx], currentLyrics[activeIdx], upcomingTime, t);
  }

  // Fade the upcoming line's preview in as its start time gets close, capped
  // well below full brightness so it reads as "coming up", not as a second
  // active line.
  if (upcomingIdx >= 0) {
    const timeUntil = upcomingTime - t;
    const progress = timeUntil >= NP_LYRIC_LEAD_IN ? 0 : Math.min(1, Math.max(0, 1 - timeUntil / NP_LYRIC_LEAD_IN));
    const el = trackEl.children[upcomingIdx];
    if (el) el.style.opacity = String(progress * NP_LYRIC_PREVIEW_MAX);
  }
}

// ---------- Now Playing: artwork <-> music video ----------
// Two very different sources sit behind one toggle:
//   * YouTube tracks — the audio *is* a YouTube embed, so "showing the video"
//     means moving that same live iframe over the media frame (by position
//     only; re-parenting an <iframe> reloads it and would desync playback).
//   * Local tracks — a sibling video file (Song.flac -> Song.mp4, or the same
//     name under a Videos/ subfolder) or one the user attached by hand, played
//     muted in a <video> that's kept time-locked to the audio engine.
// Either way the audio stream never changes, so the picture can't drift.
let npVideoMode = false;
let npVideoSource = null;   // 'youtube' | 'local' | null
let npVideoLookupToken = 0;

function refreshNpVideoAvailability(track) {
  const btn = document.getElementById('npVideoToggle');
  if (!track) { npVideoSource = null; updateNpVideoToggleUI(); return; }

  if (track.source === 'youtube') {
    npVideoSource = 'youtube';
    updateNpVideoToggleUI();
    return;
  }
  if (track.videoPath) {
    npVideoSource = 'local';
    updateNpVideoToggleUI();
    return;
  }
  if (track.videoChecked) {
    npVideoSource = null;
    updateNpVideoToggleUI();
    return;
  }

  // Unknown yet — look on disk once per track, then remember the answer.
  npVideoSource = null;
  updateNpVideoToggleUI();
  if (!track.path) { track.videoChecked = true; return; }
  if (track.videoLookupPending) return; // a lookup for this track is already in flight
  track.videoLookupPending = true;
  const myToken = ++npVideoLookupToken;
  btn.classList.add('loading');
  window.api.findVideoForTrack(track.path).then((found) => {
    track.videoChecked = true;
    delete track.videoLookupPending;
    if (found) { track.videoPath = found; persistLibrary(); }
    if (myToken !== npVideoLookupToken) return;     // a newer track took over
    btn.classList.remove('loading');
    npVideoSource = found ? 'local' : null;
    updateNpVideoToggleUI();
  }).catch(() => {
    delete track.videoLookupPending;
    if (myToken === npVideoLookupToken) btn.classList.remove('loading');
  });
}

function updateNpVideoToggleUI() {
  const btn = document.getElementById('npVideoToggle');
  if (!btn) return;
  const label = btn.querySelector('.np-media-toggle-label');
  const icon = btn.querySelector('.np-media-toggle-icon');
  btn.classList.toggle('hidden', !npVideoSource);
  btn.classList.toggle('on', npVideoMode);
  if (label) label.textContent = npVideoMode ? 'Artwork' : 'Video';
  if (icon) icon.textContent = npVideoMode ? '🖼️' : '🎬';
  btn.dataset.tooltip = npVideoMode ? 'Show album artwork' : 'Show the music video';
  refreshDynamicTooltips();
}

function toggleNpVideoMode() {
  if (!npVideoSource) return;
  setNpVideoMode(!npVideoMode);
}

function setNpVideoMode(on) {
  const media = document.getElementById('npMedia');
  const video = document.getElementById('npVideo');
  const track = queue[queueIndex];
  if (on && !npVideoSource) return;

  npVideoMode = !!on;
  media.classList.toggle('video-mode', npVideoMode);
  updateNpVideoToggleUI();

  if (npVideoMode) {
    // Clear any in-flight artwork cross-fade so its inline opacity can't
    // override the class-driven fade-out below.
    document.getElementById('npArtLayer').style.opacity = '';
    if (npVideoSource === 'youtube') {
      dockYtWidget();
    } else if (track && track.videoPath) {
      const wanted = 'file://' + track.videoPath.split('\\').join('/');
      if (video.dataset.forPath !== track.videoPath) {
        video.dataset.forPath = track.videoPath;
        video.src = wanted;
      }
      video.currentTime = getPlaybackCurrentTime();
      if (!isPlaybackPaused()) video.play().catch(() => {});
    }
  } else {
    undockYtWidget();
    if (!video.paused) video.pause();
    // Reset the artwork's visualizer pulse so it doesn't come back mid-scale.
    document.getElementById('npBigArt').style.transform = '';
  }
}

// Track changes always land on the artwork: the new song may have no video at
// all, and silently keeping a stale frame on screen would be worse than a
// deliberate fade back to the cover.
function resetNpVideoModeForNewTrack() {
  if (npVideoMode) setNpVideoMode(false);
  const video = document.getElementById('npVideo');
  if (video) { video.removeAttribute('src'); delete video.dataset.forPath; video.load(); }
}

// Keeps a local music video locked to the audio clock. Called once per frame
// while video mode is on; only corrects when drift is audible-sized, so the
// video isn't constantly being re-seeked (which would stutter).
function syncLocalVideoToAudio() {
  const video = document.getElementById('npVideo');
  if (!video || !video.src) return;
  const paused = isPlaybackPaused();
  if (paused && !video.paused) video.pause();
  if (!paused && video.paused) video.play().catch(() => {});
  if (video.readyState < 1) return;
  const cur = getPlaybackCurrentTime();
  if (Math.abs(video.currentTime - cur) > 0.3) video.currentTime = cur;
}

function positionDockedYtWidget() {
  const widget = document.getElementById('ytPlayerWidget');
  const media = document.getElementById('npMedia');
  if (!widget.classList.contains('docked') || !media) return;
  const r = media.getBoundingClientRect();
  const height = r.width * 0.5625;
  widget.style.left = `${r.left}px`;
  widget.style.top = `${r.top + (r.height - height) / 2}px`;
  widget.style.width = `${r.width}px`;
  widget.style.height = `${height}px`;
}

function dockYtWidget() {
  const widget = document.getElementById('ytPlayerWidget');
  if (!widget || widget.classList.contains('hidden')) return;
  // Pin the widget to where it currently sits (its CSS places it by `bottom`,
  // which can't be animated against a `top` target), then let the class's
  // transition carry it up onto the media frame.
  const r0 = widget.getBoundingClientRect();
  widget.style.transition = 'none';
  widget.style.left = `${r0.left}px`;
  widget.style.top = `${r0.top}px`;
  widget.style.bottom = 'auto';
  widget.style.width = `${r0.width}px`;
  widget.style.height = `${r0.height}px`;
  void widget.offsetHeight; // flush the "from" geometry before transitioning
  widget.style.transition = '';
  widget.classList.add('docked');
  requestAnimationFrame(positionDockedYtWidget);
}

function undockYtWidget() {
  const widget = document.getElementById('ytPlayerWidget');
  if (!widget || !widget.classList.contains('docked')) return;
  // Fade out in place, then drop back to the plain corner widget — snapping
  // the geometry back while it's invisible reads as a single clean handoff.
  widget.style.opacity = '0';
  setTimeout(() => {
    widget.classList.remove('docked');
    widget.removeAttribute('style');
  }, 360);
}

// ---------- Dynamic accent color from artwork ----------
let dynamicColorCache = new Map();
async function applyDynamicColorFromArt(track) {
  if (!settings.dynamicColor || !track.artworkDataUrl) return;
  if (dynamicColorCache.has(track.id)) {
    applyAccent(dynamicColorCache.get(track.id));
    return;
  }
  try {
    const hex = await extractDominantColor(track.artworkDataUrl);
    if (hex) {
      dynamicColorCache.set(track.id, hex);
      applyAccent(hex);
    }
  } catch (e) { /* ignore */ }
}

function extractDominantColor(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 24;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      let r = 0, g = 0, b = 0, count = 0;
      try {
        const data = ctx.getImageData(0, 0, size, size).data;
        for (let i = 0; i < data.length; i += 4) {
          const rr = data[i], gg = data[i + 1], bb = data[i + 2];
          const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (rr + gg + bb) / 3;
          if (lum < 20 || lum > 235) continue; // skip near-black/white
          const weight = 0.3 + sat; // favor saturated pixels
          r += rr * weight; g += gg * weight; b += bb * weight; count += weight;
        }
      } catch (e) { resolve(null); return; }
      if (count === 0) { resolve(null); return; }
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
      // Boost saturation/vibrancy a bit for a punchier accent
      const hex = '#' + [r, g, b].map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('');
      resolve(hex);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ---------- Mini player ----------
function wireMiniPlayer() {
  let miniOpen = false;
  const btn = document.getElementById('miniPlayerBtn');
  document.getElementById('miniPlayerBtn').addEventListener('click', async () => {
    if (!miniOpen) {
      await window.api.openMiniPlayer();
      miniOpen = true;
      btn.classList.add('on');
      btn.setAttribute('data-tooltip', 'Close Mini Player');
    } else {
      await window.api.closeMiniPlayer();
      miniOpen = false;
      btn.classList.remove('on');
      btn.setAttribute('data-tooltip', 'Open floating Mini Player');
    }
  });

  window.api.onMiniPlayerCommand((cmd) => {
    if (cmd === 'playPause') document.getElementById('playBtn').click();
    else if (cmd === 'next') nextTrack(false);
    else if (cmd === 'prev') prevTrack();
  });

  window.api.onMiniPlayerClosed(() => {
    miniOpen = false;
    btn.classList.remove('on');
    btn.setAttribute('data-tooltip', 'Open floating Mini Player');
  });

  window.api.onMiniPlayerStateRequest(() => pushMiniPlayerState());
}

function pushMiniPlayerState() {
  const track = queue[queueIndex];
  if (!track) return;
  window.api.pushMiniState({
    title: track.title,
    artist: track.artist,
    artworkDataUrl: track.artworkDataUrl,
    isPlaying: !isPlaybackPaused(),
    currentTime: getPlaybackCurrentTime(),
    duration: getPlaybackDuration() || 0,
  });
}
function wirePanels() {
  document.getElementById('lyricsBtn').addEventListener('click', () => togglePanel('lyricsPanel', 'queuePanel'));
  document.getElementById('queueBtn').addEventListener('click', () => { togglePanel('queuePanel', 'lyricsPanel'); renderQueuePanel(); });
  document.querySelectorAll('.close-panel').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.panel).classList.add('hidden')));
}

function togglePanel(id, otherId) {
  document.getElementById(otherId).classList.add('hidden');
  document.getElementById(id).classList.toggle('hidden');
}

function renderQueuePanel() {
  const content = document.getElementById('queueContent');
  content.innerHTML = '';
  if (queue.length === 0) {
    content.innerHTML = '<div style="color:var(--text-faint);padding:8px 0;">Queue is empty.</div>';
    return;
  }

  let currentEl = null;
  queue.forEach((t, i) => {
    if (i === 0 && queueIndex > 0) {
      content.appendChild(queueSectionLabel('History'));
    } else if (i === queueIndex) {
      content.appendChild(queueSectionLabel('Now Playing'));
    } else if (i === queueIndex + 1) {
      content.appendChild(queueSectionLabel('Next Up'));
    }

    const item = document.createElement('div');
    item.className = 'queue-item' + (i === queueIndex ? ' current' : i < queueIndex ? ' past' : '');
    item.innerHTML = `<img src="${t.artworkDataUrl || ''}" /><div><div class="qi-title">${i === queueIndex ? '▶ ' : ''}${esc(t.title)}</div><div class="qi-artist">${esc(t.artist)}</div></div>`;
    item.addEventListener('click', () => {
      queueIndex = i;
      hardLoadAndPlay(activeKey, queueIndex);
    });
    content.appendChild(item);
    if (i === queueIndex) currentEl = item;
  });

  // Bring the current song into view instead of leaving the panel scrolled
  // to the top of (potentially long-since-played) history.
  if (currentEl) {
    requestAnimationFrame(() => currentEl.scrollIntoView({ block: 'center', behavior: 'auto' }));
  }
}

function queueSectionLabel(text) {
  const label = document.createElement('div');
  label.className = 'queue-section-label';
  label.textContent = text;
  return label;
}

let currentLyrics = [];
// Whether the *current* track has any lyrics content at all (synced or plain).
// null while a fetch is in flight and the answer isn't known yet — treated as
// "assume yes" by anything that would otherwise flash to a no-lyrics layout.
let lyricsHaveContent = null;
// Plain-text lines of the *unsynced* fallback currently on screen (empty when
// the track has real synced lyrics). The Now Playing view renders its own copy
// of the lyrics rather than cloning the side panel's DOM, so it needs the data
// itself, not just the markup.
let currentPlainLines = [];
// The message shown when there are no lyrics at all ("No lyrics found…", etc),
// so every lyrics surface can word it the same way.
let lyricsStatusMessage = null;

// ---------- Romanization toggle (Japanese / Korean / Chinese lyrics) ----------
// When on, every displayed lyric line that contains CJK script gets a second,
// romanized line rendered right underneath it, original text always on top.
let romanizationEnabled = false;
// Plain-text version of whatever's currently on screen, index-aligned with
// the .lyric-line elements in whichever container was just rendered (synced
// lyrics use currentLyrics[i].text; plain lyrics use the raw split lines).
// Used only to know what to send off for romanization and match results
// back up to DOM elements.
let activeDisplayLines = [];
// Cache of exact line text -> romanized text, so re-rendering (fullscreen
// open/close, toggling on/off) never re-invokes yt-dlp/kuroshiro for a line
// already seen for this track (or any other track sharing a line).
let romanizedCache = new Map();

const CJK_ROMANIZABLE_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/;
function lineNeedsRomanization(text) { return !!(text && CJK_ROMANIZABLE_RE.test(text)); }

function wireLyricsRomanizeButton() {
  ['lyricsRomanizeBtn', 'lyricsFsRomanizeBtn', 'npBigRomanizeBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', toggleRomanization);
  });
  updateRomanizeButtonState();
}

function updateRomanizeButtonState() {
  ['lyricsRomanizeBtn', 'lyricsFsRomanizeBtn', 'npBigRomanizeBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('on', romanizationEnabled);
  });
}

async function toggleRomanization() {
  romanizationEnabled = !romanizationEnabled;
  settings.romanizeLyrics = romanizationEnabled;
  await persistSettings();
  updateRomanizeButtonState();
  await applyRomanizationToContainer(document.getElementById('lyricsContent'));
  if (lyricsFsOpen) await applyRomanizationToContainer(document.getElementById('lyricsFsTrack'));
  if (overlayOpen) await applyRomanizationToContainer(document.getElementById('npLyricsTrack'));
}

// Adds (or, if turned off, strips) a `.lyric-line-romanized` sub-line under
// each `.lyric-line` in `container`, matched up against `activeDisplayLines`
// by index. Safe to call repeatedly on the same container (e.g. re-opening
// fullscreen) — it always clears old sub-lines before deciding whether to
// add fresh ones.
async function applyRomanizationToContainer(container) {
  if (!container) return;
  const lineEls = container.querySelectorAll('.lyric-line');
  lineEls.forEach((el) => {
    const existing = el.querySelector('.lyric-line-romanized');
    if (existing) existing.remove();
  });
  if (!romanizationEnabled) return;

  const toFetch = [];
  activeDisplayLines.forEach((text) => {
    if (lineNeedsRomanization(text) && !romanizedCache.has(text) && !toFetch.includes(text)) toFetch.push(text);
  });
  if (toFetch.length > 0) {
    try {
      const results = await window.api.romanizeLyrics(toFetch);
      results.forEach((r, i) => romanizedCache.set(toFetch[i], r));
    } catch (e) {
      return; // romanization unavailable (e.g. dictionaries missing) — leave originals showing
    }
  }

  lineEls.forEach((el, i) => {
    const text = activeDisplayLines[i];
    if (!text) return;
    const romanized = romanizedCache.get(text);
    if (romanized && romanized.trim() && romanized.trim() !== text.trim()) {
      const sub = document.createElement('div');
      sub.className = 'lyric-line-romanized';
      sub.textContent = romanized;
      el.appendChild(sub);
    }
  });
}

// Monotonic token identifying the most recent loadLyrics() call. Used instead
// of comparing against `queue[queueIndex]` because queueIndex intentionally
// lags behind during a crossfade (it only flips once the fade completes),
// while loadLyrics for the incoming track is already running — a queueIndex
// check would wrongly call that in-flight load "stale".
let lyricsLoadToken = 0;

async function loadLyrics(track) {
  const myToken = ++lyricsLoadToken;
  const content = document.getElementById('lyricsContent');
  currentLyrics = [];
  currentPlainLines = [];
  lyricsStatusMessage = null;
  lyricsHaveContent = null;
  content.innerHTML = '<div style="color:var(--text-faint)">Loading…</div>';
  // Immediately clear/refresh any open fullscreen view so a track change
  // never leaves the previous song's lyrics on screen while this fetch runs.
  prepareFullscreenForTrackChange(track);

  // A manual pick from the lyrics-match picker (see openLyricsMatchPicker)
  // always wins, regardless of source — it's the user directly telling us
  // "this is the right one". Kept separate from the auto-fetched cache below
  // so a manual pick can't be confused with (or silently overwritten by) an
  // automatic guess.
  if (track.manualSyncedLyrics) { renderSyncedLyrics(track.manualSyncedLyrics); finishLyricsLoad(track, myToken); return; }
  if (track.manualPlainLyrics) { renderPlainLyrics(track.manualPlainLyrics); finishLyricsLoad(track, myToken); return; }

  if (track.source === 'youtube') {
    if (track.cachedSyncedLyrics) { renderSyncedLyrics(track.cachedSyncedLyrics); finishLyricsLoad(track, myToken); return; }
    if (track.cachedPlainLyrics) { renderPlainLyrics(track.cachedPlainLyrics); finishLyricsLoad(track, myToken); return; }

    const durationGuess = track.duration || (isCurrentYoutube() ? getPlaybackDuration() : 0) || null;
    const result = await fetchLyricsFromLrclib(track, durationGuess);
    if (!result || (!result.syncedLyrics && !result.plainLyrics)) {
      currentLyrics = [];
      lyricsHaveContent = false;
      content.innerHTML = noLyricsMessageHtml('No lyrics found for this track.');
      wireNoLyricsSearchLink(track);
      finishLyricsLoad(track, myToken);
      return;
    }
    if (result.syncedLyrics) {
      track.cachedSyncedLyrics = result.syncedLyrics;
      await persistLibrary();
      renderSyncedLyrics(result.syncedLyrics);
    } else {
      track.cachedPlainLyrics = result.plainLyrics;
      await persistLibrary();
      renderPlainLyrics(result.plainLyrics);
    }
    finishLyricsLoad(track, myToken);
    return;
  }

  if (!track.path) {
    currentLyrics = [];
    lyricsHaveContent = false;
    content.innerHTML = noLyricsMessageHtml('Lyrics aren\'t available for this source.');
    wireNoLyricsSearchLink(track);
    finishLyricsLoad(track, myToken);
    return;
  }
  const res = await window.api.loadLyricsForTrack(track.path);
  if (!res.found) {
    currentLyrics = [];
    lyricsHaveContent = false;
    content.innerHTML = noLyricsMessageHtml('No synced lyrics found for this track.');
    wireNoLyricsSearchLink(track);
    finishLyricsLoad(track, myToken);
    return;
  }
  renderSyncedLyrics(res.raw);
  finishLyricsLoad(track, myToken);
}

// Runs immediately (synchronously, before any network/disk fetch) whenever
// the current track changes, so an already-open fullscreen view never shows
// stale metadata or a lingering previous lyric line while the new track's
// lyrics are being looked up.
function prepareFullscreenForTrackChange(track) {
  if (overlayOpen) syncOverlayContent(track);
  if (lyricsFsOpen) {
    document.getElementById('lyricsFsArt').src = track.artworkDataUrl || '';
    document.getElementById('lyricsFsBg').style.backgroundImage = track.artworkDataUrl ? `url("${track.artworkDataUrl}")` : 'none';
    document.getElementById('lyricsFsTitle').textContent = track.title;
    document.getElementById('lyricsFsArtist').textContent = track.artist;
    document.getElementById('lyricsFsTrack').innerHTML = `<div class="lyric-line no-lyrics-msg">Loading…</div>`;
  }
}

// Runs once a track's lyrics fetch has actually settled (found, not found, or
// cached). This is the single place that decides whether an active fullscreen
// session should hop between "Expand Lyrics" and "Full Now Playing" to match
// what the now-current song actually has available.
function finishLyricsLoad(track, myToken) {
  if (myToken !== lyricsLoadToken) return; // a newer loadLyrics() call has since taken over; that load owns the UI now

  if (overlayOpen) syncOverlayContent(track);

  if (fsMode !== null && fsPreferred === 'lyrics') {
    const desired = currentLyrics.length > 0 ? 'lyrics' : 'now';
    if (fsMode !== desired) {
      enterFullscreenMode(desired, { setPreferred: false, track });
      return;
    }
  }

  if (fsMode === 'lyrics') renderLyricsFullscreenContent(track);
}

function noLyricsMessageHtml(message) {
  // Recorded here (rather than at each call site) so the Now Playing view and
  // the side panel can never drift apart on the wording.
  lyricsStatusMessage = message;
  return `<div style="color:var(--text-faint)">${esc(message)}<br>
    <a href="#" id="noLyricsSearchLink" style="color:var(--accent);text-decoration:underline;">Search for lyrics manually</a>
  </div>`;
}

function wireNoLyricsSearchLink(track) {
  const link = document.getElementById('noLyricsSearchLink');
  if (link) link.addEventListener('click', (e) => { e.preventDefault(); openLyricsMatchPicker(track); });
}

// Wraps each word of a lyric line in its own <span> so word-level highlighting
// can target them individually. If `line` carries real per-word timestamps
// (see parseEnhancedLineWords), those exact tokens are used; otherwise falls
// back to splitting the plain text on whitespace (keeping it as plain text
// between spans so line wrapping still looks natural).
function lyricLineToHtml(line) {
  if (line.words && line.words.length) {
    return line.words.map((w) => `<span class="lyric-word">${esc(w.text)}</span>`).join('');
  }
  return renderLyricLineWordsHtml(line.text);
}

function renderLyricLineWordsHtml(text) {
  if (!text) return '♪';
  return text.split(/(\s+)/).map((part) => {
    if (!part) return '';
    if (/^\s+$/.test(part)) return part;
    return `<span class="lyric-word">${esc(part)}</span>`;
  }).join('');
}

function renderSyncedLyrics(raw) {
  const content = document.getElementById('lyricsContent');
  currentLyrics = parseLrc(raw);
  if (currentLyrics.length === 0) { renderPlainLyrics(raw); return; }
  lyricsHaveContent = true;
  currentPlainLines = [];
  lyricsStatusMessage = null;
  content.innerHTML = '';
  activeDisplayLines = currentLyrics.map((l) => l.text || '');
  currentLyrics.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'lyric-line' + (line.words && line.words.length ? ' word-synced' : '');
    el.dataset.idx = i;
    el.innerHTML = lyricLineToHtml(line);
    el.addEventListener('click', () => seekPlaybackTo(line.time));
    content.appendChild(el);
  });
  applyRomanizationToContainer(content);
}

// Unsynced fallback — plain text, one line per row, no seek-on-click since
// there are no timestamps to seek to.
function renderPlainLyrics(text) {
  const content = document.getElementById('lyricsContent');
  currentLyrics = [];
  activeDisplayLines = [];
  const hasText = !!(text && text.trim());
  lyricsHaveContent = hasText;
  currentPlainLines = [];
  lyricsStatusMessage = null;
  content.innerHTML = '';
  if (!hasText) { content.innerHTML = noLyricsMessageHtml('No lyrics found for this track.'); return; }
  const lines = text.split('\n');
  activeDisplayLines = lines.map((l) => l.trim());
  currentPlainLines = activeDisplayLines;
  lines.forEach((line) => {
    const el = document.createElement('div');
    el.className = 'lyric-line';
    el.textContent = line.trim() || '♪';
    content.appendChild(el);
  });
  applyRomanizationToContainer(content);
}

// Strips common YouTube title noise ("(Official Video)", "[MV]", "feat. X",
// etc.) so the cleaned title has a better shot at matching LRCLIB's catalog,
// which is keyed on the actual song/artist name rather than upload titles.
function cleanYoutubeTitleForLyricsSearch(title) {
  return (title || '')
    .replace(/[([][^)\]]*[)\]]/g, '')
    .replace(/\b(official\s+)?(music\s+)?(video|audio|mv|lyric\s*video|visualizer)\b/gi, '')
    .replace(/\b(feat\.?|ft\.?)\s.*/i, '')
    .replace(/[-–|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Many YouTube upload titles are formatted "Artist - Song Title". LRCLIB's
// track_name field expects just the song title, so if we don't split this
// out, "Artist - Song Title" almost never matches anything in its catalog.
// Returns { artist, title } if the cleaned title looks like that shape,
// otherwise null.
function splitArtistTitle(cleanedTitle) {
  const parts = cleanedTitle.split(/\s[-–—]\s/);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { artist: parts[0].trim(), title: parts[1].trim() };
  }
  return null;
}

function wireLyricsFixButton() {
  document.getElementById('lyricsFixBtn').addEventListener('click', () => {
    const track = queue[queueIndex];
    if (!track) { showToast('Play a track first', 'ℹ️'); return; }
    openLyricsMatchPicker(track);
  });
}

// Lets the user override an auto-matched (or missing) set of lyrics by
// searching LRCLIB themselves and picking the right result — for when the
// automatic guess picked the wrong song, a rough cover, a different mix,
// etc. The chosen result is saved as a permanent per-track override that
// loadLyrics always prefers over anything auto-fetched.
async function openLyricsMatchPicker(track) {
  const defaultQuery = `${track.artist && track.artist !== 'Unknown Artist' ? track.artist + ' ' : ''}${track.title || ''}`.trim();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#17171f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:20px;width:440px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,0.5);';

  const label = document.createElement('div');
  label.textContent = 'Search for the correct lyrics:';
  label.style.cssText = 'margin-bottom:10px;font-size:14px;color:#eee;';

  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultQuery;
  input.style.cssText = 'flex:1;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:#0e0e14;color:#fff;font-size:14px;';

  const searchBtn = document.createElement('button');
  searchBtn.textContent = 'Search';
  searchBtn.className = 'primary-btn';
  searchBtn.style.cssText = 'width:auto;padding:8px 16px;';

  const results = document.createElement('div');
  results.style.cssText = 'max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Cancel';
  closeBtn.style.cssText = 'margin-top:14px;width:100%;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#ccc;font-size:14px;cursor:pointer;';

  function close() { document.removeEventListener('keydown', onKeydown); overlay.remove(); }
  function onKeydown(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  document.addEventListener('keydown', onKeydown);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function runSearch(q) {
    results.innerHTML = '<div style="color:#888;font-size:13px;">Searching…</div>';
    try {
      const resp = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      const data = resp.ok ? await resp.json() : [];
      results.innerHTML = '';
      if (!Array.isArray(data) || data.length === 0) {
        results.innerHTML = '<div style="color:#888;font-size:13px;">No results.</div>';
        return;
      }
      data.slice(0, 20).forEach((r) => {
        const row = document.createElement('button');
        row.style.cssText = 'text-align:left;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:#0e0e14;color:#eee;font-size:13px;cursor:pointer;';
        const durTxt = r.duration ? fmtTime(r.duration) : '—';
        const syncTag = r.syncedLyrics ? ' 🎤 synced' : (r.plainLyrics ? ' plain only' : ' no lyrics');
        row.innerHTML = `<div style="font-weight:700;">${esc(r.trackName || '?')}</div>
          <div style="color:#999;">${esc(r.artistName || '')}${r.albumName ? ' · ' + esc(r.albumName) : ''} · ${durTxt}${syncTag}</div>`;
        row.addEventListener('click', async () => {
          if (!r.syncedLyrics && !r.plainLyrics) return;
          track.manualSyncedLyrics = r.syncedLyrics || null;
          track.manualPlainLyrics = r.syncedLyrics ? null : (r.plainLyrics || null);
          await persistLibrary();
          close();
          if (queue[queueIndex] === track) loadLyrics(track);
          showToast('Lyrics updated', '✅');
        });
        results.appendChild(row);
      });
    } catch (e) {
      results.innerHTML = '<div style="color:#e77;font-size:13px;">Search failed — check your connection.</div>';
    }
  }

  searchBtn.addEventListener('click', () => runSearch(input.value.trim()));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value.trim()); } });

  searchRow.appendChild(input);
  searchRow.appendChild(searchBtn);
  box.appendChild(label);
  box.appendChild(searchRow);
  box.appendChild(results);
  box.appendChild(closeBtn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();

  if (defaultQuery) runSearch(defaultQuery);
}


//
// The video's "artist" field is usually the uploading channel name (a label,
// a lyric channel, "Topic", etc.), which frequently isn't the real recording
// artist, and the title often bundles the artist in with the song name. So
// instead of trusting either field blindly, we build a short list of
// plausible (title, artist) guesses — parsed-from-title first, since that's
// usually more accurate than the channel name — and try each in turn, first
// against the exact/duration-matched endpoint, then the fuzzy search
// endpoint, before falling back to a fully loose text query as a last resort.
async function fetchLyricsFromLrclib(track, durationGuess) {
  const cleaned = cleanYoutubeTitleForLyricsSearch(track.title);
  if (!cleaned) return null;

  const split = splitArtistTitle(cleaned);
  const channelArtist = track.artist || '';
  const guesses = [];
  if (split) guesses.push({ title: split.title, artist: split.artist });
  guesses.push({ title: cleaned, artist: channelArtist });
  if (split && split.artist.toLowerCase() !== channelArtist.toLowerCase()) {
    guesses.push({ title: split.title, artist: channelArtist });
  }

  if (durationGuess) {
    for (const guess of guesses) {
      try {
        const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(guess.title)}&artist_name=${encodeURIComponent(guess.artist)}&duration=${Math.round(durationGuess)}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (data && (data.syncedLyrics || data.plainLyrics)) return data;
        }
      } catch (e) { /* try next guess */ }
    }
  }

  for (const guess of guesses) {
    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(guess.title)}&artist_name=${encodeURIComponent(guess.artist)}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const results = await resp.json();
      if (!Array.isArray(results) || results.length === 0) continue;
      const withSync = results.filter((r) => r.syncedLyrics);
      const pool = withSync.length ? withSync : results;
      if (durationGuess) pool.sort((a, b) => Math.abs((a.duration || 0) - durationGuess) - Math.abs((b.duration || 0) - durationGuess));
      if (pool[0]) return pool[0];
    } catch (e) { /* try next guess */ }
  }

  // Last resort: LRCLIB's generic "q" query does a looser combined-field
  // search with no strict artist requirement, which catches cases where
  // none of the guesses above lined up with how the track is actually
  // catalogued.
  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(cleaned)}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const results = await resp.json();
      if (Array.isArray(results) && results.length > 0) {
        const withSync = results.filter((r) => r.syncedLyrics);
        const pool = withSync.length ? withSync : results;
        if (durationGuess) pool.sort((a, b) => Math.abs((a.duration || 0) - durationGuess) - Math.abs((b.duration || 0) - durationGuess));
        return pool[0] || null;
      }
    }
  } catch (e) { /* give up */ }

  return null;
}

// Some LRC files include an "enhanced"/karaoke extension with a real
// timestamp before each word, e.g. "[00:12.34]<00:12.34>Hello <00:12.78>world".
// When present, this gives exact per-word timing instead of an estimate.
const wordTagRe = /<(\d{2}):(\d{2})(?:[.:](\d{1,3}))?>/g;

function parseEnhancedLineWords(textWithWordTags) {
  const matches = [...textWithWordTags.matchAll(wordTagRe)];
  if (matches.length === 0) return null;
  const words = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
    const time = min * 60 + sec + ms / 1000;
    const start = m.index + m[0].length;
    const end = (i + 1 < matches.length) ? matches[i + 1].index : textWithWordTags.length;
    const text = textWithWordTags.slice(start, end);
    if (text.trim()) words.push({ time, text });
  }
  return words.length ? words : null;
}

function parseLrc(raw) {
  const lines = raw.split('\n');
  const out = [];
  const timeRe = /\[(\d{2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const matches = [...line.matchAll(timeRe)];
    if (matches.length === 0) continue;
    const rawText = line.replace(timeRe, '').trim();
    const words = parseEnhancedLineWords(rawText);
    const text = words ? rawText.replace(wordTagRe, '').trim() : rawText;
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      out.push({ time: min * 60 + sec + ms / 1000, text, words });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function updateLyricHighlight(t) {
  if (currentLyrics.length === 0) return;
  let activeIdx = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentLyrics[i].time <= t) activeIdx = i; else break;
  }
  const nextLineTime = (activeIdx >= 0 && activeIdx + 1 < currentLyrics.length) ? currentLyrics[activeIdx + 1].time : null;

  ['lyricsContent'].forEach((containerId) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const lines = container.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
      if (i === activeIdx) applyWordProgress(el, currentLyrics[i], nextLineTime, t);
    });
    const active = container.querySelector('.lyric-line.active');
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  // The fullscreen lyrics view doesn't use scrollIntoView — it has its own
  // rAF lerp loop that glides the active line into the middle of its
  // viewport. The Now Playing column is handled separately, every frame, by
  // stepNpLyricsFocus (called from startUiLoop) rather than from here, since
  // its upcoming-line fade needs continuous updates, not just on timeupdate.
  const fsTrack = document.getElementById('lyricsFsTrack');
  if (fsTrack) {
    const lines = fsTrack.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
      el.classList.toggle('near', Math.abs(i - activeIdx) === 1);
      if (i === activeIdx) applyWordProgress(el, currentLyrics[i], nextLineTime, t);
    });
  }
}

// Lights up the word of the currently-active line that's playing "right
// now" — but only when the LRC data included real per-word timestamps
// (enhanced/karaoke format). LRCLIB usually only gives one timestamp per
// *line*, and estimating word timing from that isn't a real sync — it just
// looks like one. So without exact data, no word gets singled out; the
// active line's own whole-line glow (handled elsewhere via the `.active`
// class) is the only highlight, same as before word-level sync existed.
function applyWordProgress(lineEl, line, nextLineTime, t) {
  const words = lineEl.querySelectorAll('.lyric-word');
  if (words.length === 0) return;

  if (!line.words || line.words.length !== words.length) {
    words.forEach((w) => { w.classList.remove('sung', 'word-active'); });
    return;
  }

  let activeWordIdx = -1;
  for (let i = 0; i < line.words.length; i++) {
    if (line.words[i].time <= t) activeWordIdx = i; else break;
  }
  words.forEach((w, i) => {
    w.classList.toggle('sung', i < activeWordIdx);
    w.classList.toggle('word-active', i === activeWordIdx);
  });
}

// ---------- Metadata editor ----------
let metaEditingTrack = null;
let metaPendingArtworkPath = null;

function wireMetaEditor() {
  document.getElementById('metaModalClose').addEventListener('click', closeMetaEditor);
  document.getElementById('metaModal').addEventListener('click', (e) => {
    if (e.target.id === 'metaModal') closeMetaEditor();
  });
  document.getElementById('metaChangeArt').addEventListener('click', async () => {
    const filePath = await window.api.pickArtworkFile();
    if (!filePath) return;
    metaPendingArtworkPath = filePath;
    document.getElementById('metaArtPreview').src = 'file://' + filePath.split('/').join('/');
  });
  document.getElementById('metaSaveBtn').addEventListener('click', saveMetaEditor);
}

function openMetaEditor(track) {
  if (track.source === 'youtube') { showToast('Track info editing isn\'t available for YouTube videos', 'ℹ️'); return; }
  metaEditingTrack = track;
  metaPendingArtworkPath = null;
  document.getElementById('metaArtPreview').src = track.artworkDataUrl || '';
  document.getElementById('metaTitle').value = track.title || '';
  document.getElementById('metaArtist').value = track.artist || '';
  document.getElementById('metaAlbum').value = track.album || '';
  document.getElementById('metaAlbumArtist').value = track.albumArtist || '';
  document.getElementById('metaGenre').value = track.genre || '';
  document.getElementById('metaYear').value = track.year || '';
  document.getElementById('metaTrack').value = track.track || '';
  document.getElementById('metaDisk').value = track.disk || '';
  document.getElementById('metaComposer').value = track.composer || '';
  document.getElementById('metaCopyright').value = '';
  document.getElementById('metaLyrics').value = '';
  document.getElementById('metaModal').classList.remove('hidden');
}

function closeMetaEditor() {
  document.getElementById('metaModal').classList.add('hidden');
  metaEditingTrack = null;
  metaPendingArtworkPath = null;
}

async function saveMetaEditor() {
  if (!metaEditingTrack) return;
  const fields = {
    title: document.getElementById('metaTitle').value.trim(),
    artist: document.getElementById('metaArtist').value.trim(),
    album: document.getElementById('metaAlbum').value.trim(),
    albumArtist: document.getElementById('metaAlbumArtist').value.trim(),
    genre: document.getElementById('metaGenre').value.trim(),
    year: document.getElementById('metaYear').value,
    track: document.getElementById('metaTrack').value,
    disk: document.getElementById('metaDisk').value,
    composer: document.getElementById('metaComposer').value.trim(),
    copyright: document.getElementById('metaCopyright').value.trim(),
    lyrics: document.getElementById('metaLyrics').value,
  };
  const saveBtn = document.getElementById('metaSaveBtn');
  saveBtn.textContent = 'Saving…';
  saveBtn.disabled = true;
  try {
    const updated = await window.api.writeMetadata({
      filePath: metaEditingTrack.path,
      fields,
      newArtworkPath: metaPendingArtworkPath,
    });
    const idx = library.tracks.findIndex((t) => t.id === metaEditingTrack.id);
    if (idx >= 0) library.tracks[idx] = updated;
    const qIdx = queue.findIndex((t) => t.id === metaEditingTrack.id);
    if (qIdx >= 0) {
      queue[qIdx] = updated;
      if (qIdx === queueIndex) updateNowPlayingUI(updated);
    }
    await persistLibrary();
    closeMetaEditor();
    refreshCurrentScreen();
    showToast(`Saved info for "${updated.title}"`, '✏️');
  } catch (e) {
    alert('Could not save changes: ' + e.message);
  } finally {
    saveBtn.textContent = 'Save Changes';
    saveBtn.disabled = false;
  }
}

// ---------- Sleep timer ----------
let sleepTimer = { timeoutId: null, mode: null, endsAt: null }; // mode: 'duration' | 'endOfSong' | 'endOfAlbum'

function wireSleepTimer() {
  const btn = document.getElementById('sleepTimerBtn');
  const pop = document.getElementById('sleepTimerPopover');
  btn.addEventListener('click', () => pop.classList.toggle('hidden'));
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== btn) pop.classList.add('hidden');
  });
  pop.querySelectorAll('.popover-opt[data-min]').forEach((b) => {
    b.addEventListener('click', () => { setSleepTimerDuration(Number(b.dataset.min)); pop.classList.add('hidden'); });
  });
  pop.querySelector('[data-special="endOfSong"]').addEventListener('click', () => { setSleepTimerSpecial('endOfSong'); pop.classList.add('hidden'); });
  pop.querySelector('[data-special="endOfAlbum"]').addEventListener('click', () => { setSleepTimerSpecial('endOfAlbum'); pop.classList.add('hidden'); });
  document.getElementById('sleepCustomBtn').addEventListener('click', () => {
    const v = Number(document.getElementById('sleepCustomMin').value);
    if (v > 0) { setSleepTimerDuration(v); pop.classList.add('hidden'); }
  });
  document.getElementById('sleepCancelBtn').addEventListener('click', () => { clearSleepTimer(); pop.classList.add('hidden'); });
}

function setSleepTimerDuration(minutes) {
  clearSleepTimer();
  sleepTimer.mode = 'duration';
  sleepTimer.endsAt = Date.now() + minutes * 60000;
  sleepTimer.timeoutId = setTimeout(() => { pausePlayback(); clearSleepTimer(); }, minutes * 60000);
  updateSleepTimerBadge();
}

function setSleepTimerSpecial(mode) {
  clearSleepTimer();
  sleepTimer.mode = mode;
  sleepTimer.endsAt = null;
  updateSleepTimerBadge();
}

function clearSleepTimer() {
  if (sleepTimer.timeoutId) clearTimeout(sleepTimer.timeoutId);
  sleepTimer = { timeoutId: null, mode: null, endsAt: null };
  updateSleepTimerBadge();
}

function updateSleepTimerBadge() {
  const btn = document.getElementById('sleepTimerBtn');
  btn.classList.toggle('on', !!sleepTimer.mode);
  const label = sleepTimer.mode === 'duration' ? `Sleep timer active (${Math.max(0, Math.round((sleepTimer.endsAt - Date.now()) / 60000))} min left)`
    : sleepTimer.mode === 'endOfSong' ? 'Sleep at end of current song'
    : sleepTimer.mode === 'endOfAlbum' ? 'Sleep at end of current album'
    : 'Sleep Timer';
  btn.setAttribute('data-tooltip', label);
}

function pausePlayback() {
  if (isCurrentYoutube()) {
    if (ytPlayer && ytPlayerReady) { try { ytPlayer.pauseVideo(); } catch (e) {} }
  } else {
    const p = activePlayer();
    if (p) p.el.pause();
  }
}

// Called from onEnded / hardLoadAndPlay to check "end of song" / "end of album" sleep modes
function checkSleepTimerOnTrackEnd(justFinishedTrack, nextTrack) {
  if (sleepTimer.mode === 'endOfSong') {
    pausePlayback();
    clearSleepTimer();
    return true; // signal: stop advancing
  }
  if (sleepTimer.mode === 'endOfAlbum') {
    const sameAlbum = nextTrack && justFinishedTrack && nextTrack.album === justFinishedTrack.album && nextTrack.albumArtist === justFinishedTrack.albumArtist;
    if (!sameAlbum) {
      pausePlayback();
      clearSleepTimer();
      return true;
    }
  }
  return false;
}

// ---------- A/B loop ----------
let abLoop = { a: null, b: null, stage: 'idle' }; // idle -> hasA -> active

function wireAbLoop() {
  document.getElementById('abLoopBtn').addEventListener('click', () => {
    if (isCurrentYoutube()) { showToast('A/B loop isn\'t available for YouTube tracks', 'ℹ️'); return; }
    const el = activePlayer() ? activePlayer().el : null;
    if (!el || !el.duration) return;
    if (abLoop.stage === 'idle') {
      abLoop.a = el.currentTime;
      abLoop.stage = 'hasA';
    } else if (abLoop.stage === 'hasA') {
      abLoop.b = el.currentTime;
      if (abLoop.b <= abLoop.a) [abLoop.a, abLoop.b] = [abLoop.b, abLoop.a];
      abLoop.stage = 'active';
    } else {
      abLoop = { a: null, b: null, stage: 'idle' };
    }
    updateAbLoopButton();
  });
}

function updateAbLoopButton() {
  const btn = document.getElementById('abLoopBtn');
  btn.classList.toggle('on', abLoop.stage !== 'idle');
  btn.textContent = abLoop.stage === 'idle' ? 'AB' : abLoop.stage === 'hasA' ? 'A·set B' : 'A↔B';
  refreshDynamicTooltips();
}

function enforceAbLoop() {
  if (abLoop.stage !== 'active') return;
  const el = activePlayer() ? activePlayer().el : null;
  if (!el) return;
  if (el.currentTime >= abLoop.b) el.currentTime = abLoop.a;
}

// ---------- Keyboard extras + media keys ----------
let volumeBeforeMute = null;
function wireExtraShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key.toLowerCase() === 'f') {
      const track = queue[queueIndex];
      if (track) toggleFavoriteSong(track.id);
    }
    if (e.key.toLowerCase() === 'm') toggleMute();
    if (e.code === 'ArrowUp' && !e.shiftKey) { e.preventDefault(); nudgeVolume(5); }
    if (e.code === 'ArrowDown' && !e.shiftKey) { e.preventDefault(); nudgeVolume(-5); }
  });

  window.api.onMediaKey((type) => {
    if (type === 'playPause') document.getElementById('playBtn').click();
    else if (type === 'next') nextTrack(false);
    else if (type === 'prev') prevTrack();
    else if (type === 'stop') pausePlayback();
  });

  // Auto-update: main.js downloads new releases silently in the background
  // (see setupAutoUpdater there); once one's ready, show a persistent
  // banner rather than a toast that disappears — the person might be deep
  // in a listening session and not notice a 3-second toast, and installing
  // requires a restart they should choose the moment for.
  if (window.api.onUpdateDownloaded) {
    window.api.onUpdateDownloaded((version) => {
      const bar = document.createElement('div');
      bar.className = 'bulk-bar';
      bar.style.bottom = '150px';
      bar.innerHTML = `<span class="bulk-count">✨ Update ${esc(version)} is ready</span>`;
      const laterBtn = document.createElement('button');
      laterBtn.className = 'ghost-btn';
      laterBtn.textContent = 'Later';
      laterBtn.addEventListener('click', () => bar.remove());
      const nowBtn = document.createElement('button');
      nowBtn.className = 'ghost-btn';
      nowBtn.textContent = 'Restart & update';
      nowBtn.addEventListener('click', () => window.api.installUpdateNow());
      bar.appendChild(nowBtn);
      bar.appendChild(laterBtn);
      document.body.appendChild(bar);
    });
  }
}

function nudgeVolume(delta) {
  const bar = document.getElementById('volBar');
  bar.value = Math.min(100, Math.max(0, Number(bar.value) + delta));
  bar.dispatchEvent(new Event('input'));
}

function toggleMute() {
  const bar = document.getElementById('volBar');
  if (volumeBeforeMute === null) {
    volumeBeforeMute = bar.value;
    bar.value = 0;
  } else {
    bar.value = volumeBeforeMute;
    volumeBeforeMute = null;
  }
  bar.dispatchEvent(new Event('input'));
}

// ---------- Custom tooltips ---------- 
function wireTooltips() {
  const tip = document.getElementById('tooltip');
  let currentTarget = null;

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el || el === currentTarget) return;
    currentTarget = el;
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    tip.textContent = text;
    tip.classList.remove('hidden');
    positionTooltip(tip, el);
    requestAnimationFrame(() => tip.classList.add('show'));
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    currentTarget = null;
    tip.classList.remove('show');
    setTimeout(() => { if (!currentTarget) tip.classList.add('hidden'); }, 130);
  });
}

function positionTooltip(tip, el) {
  const rect = el.getBoundingClientRect();
  tip.style.visibility = 'hidden';
  tip.classList.remove('hidden');
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.top - tipRect.height - 10;
  if (top < 4) top = rect.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.style.visibility = 'visible';
}

// Refresh dynamic tooltip text for stateful buttons (call after state changes)
function refreshDynamicTooltips() {
  const track = queue[queueIndex];
  document.getElementById('npFavBtn').setAttribute('data-tooltip',
    track && library.favorites.songs.includes(track.id) ? 'Remove from Liked Songs' : 'Add to Liked Songs');
  document.getElementById('playBtn').setAttribute('data-tooltip',
    players[activeKey] && !players[activeKey].el.paused ? 'Pause' : 'Play');
  document.getElementById('shuffleBtn').setAttribute('data-tooltip',
    `Shuffle: ${shuffleMode === 'off' ? 'off' : shuffleMode === 'random' ? 'random' : 'smart'} (click to change)`);
  document.getElementById('repeatBtn').setAttribute('data-tooltip',
    `Repeat: ${repeatMode === 'off' ? 'off' : repeatMode === 'all' ? 'all' : 'one'} (click to change)`);
  document.getElementById('abLoopBtn').setAttribute('data-tooltip',
    abLoop.stage === 'idle' ? 'A/B Loop: set point A' : abLoop.stage === 'hasA' ? 'A/B Loop: set point B' : 'A/B Loop active (click to clear)');
}

// ---------- Ripple click feedback ----------
function wireRippleEffect() {
  document.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.icon-btn, .primary-btn, .play-btn, .nav-item, .card, .popover-opt');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    const prevPosition = getComputedStyle(el).position;
    if (prevPosition === 'static') el.style.position = 'relative';
    el.style.overflow = el.style.overflow || 'hidden';
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

// ---------- Fullscreen lyrics mode ----------
function wireLyricsFullscreen() {
  document.getElementById('lyricsFullscreenBtn').addEventListener('click', () => enterFullscreenMode('lyrics'));
  document.getElementById('npBigLyricsFullscreenBtn').addEventListener('click', () => enterFullscreenMode('lyrics'));
  document.getElementById('lyricsFsClose').addEventListener('click', closeFullscreenMode);

  // Single Escape handler for both immersive views.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fsMode !== null) closeFullscreenMode();
  });

  // Keep the overlay state in lockstep with real OS/window fullscreen,
  // regardless of what triggered the change (our own button, F11, or the OS).
  window.api.onFullscreenChange((flag) => {
    nativeFullscreen = flag;
    if (!flag && fsMode !== null) onNativeFullscreenExited();
  });
  window.api.isFullScreen().then((flag) => { nativeFullscreen = !!flag; }).catch(() => {});

  startLyricsFsScrollLoop();
}

let lyricsFsOpen = false;
let lyricsFsScrollCurrent = 0; // current animated translateY value (px)
let lyricsFsScrollTarget = 0;  // target translateY value (px)

// Populates the fullscreen lyrics layer's art/title/lyric text for `track`.
// Used both when the view is first opened and when a track change needs to
// refresh an already-open view (no full close/reopen, per the smooth-switch
// requirement).
function renderLyricsFullscreenContent(track) {
  document.getElementById('lyricsFsArt').src = track.artworkDataUrl || '';
  document.getElementById('lyricsFsBg').style.backgroundImage = track.artworkDataUrl ? `url("${track.artworkDataUrl}")` : 'none';
  document.getElementById('lyricsFsTitle').textContent = track.title;
  document.getElementById('lyricsFsArtist').textContent = track.artist;

  const trackEl = document.getElementById('lyricsFsTrack');
  if (currentLyrics.length === 0) {
    trackEl.innerHTML = `<div class="lyric-line no-lyrics-msg">No synced lyrics available for this track.</div>`;
  } else {
    trackEl.innerHTML = currentLyrics.map((line) => `<div class="lyric-line${line.words && line.words.length ? ' word-synced' : ''}">${lyricLineToHtml(line)}</div>`).join('');
    trackEl.querySelectorAll('.lyric-line').forEach((el, i) => {
      el.addEventListener('click', () => { activePlayer().el.currentTime = currentLyrics[i].time; });
    });
    applyRomanizationToContainer(trackEl);
  }

  // Snap scroll to the currently active line immediately (no animated glide-in from 0)
  const viewportH = document.getElementById('lyricsFsViewport').clientHeight;
  lyricsFsScrollTarget = computeLyricsFsTargetOffset(viewportH);
  lyricsFsScrollCurrent = lyricsFsScrollTarget;
  trackEl.style.transform = `translateY(${-lyricsFsScrollCurrent}px)`;
}

function showLyricsFullscreenDom() {
  const overlay = document.getElementById('lyricsFullscreen');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('open'));
  lyricsFsOpen = true;
}

function hideLyricsFullscreenDom() {
  document.getElementById('lyricsFullscreen').classList.remove('open');
  lyricsFsOpen = false;
}

function computeLyricsFsTargetOffset(viewportH) {
  const activeEl = document.querySelector('#lyricsFsTrack .lyric-line.active');
  if (!activeEl) return 0;
  return activeEl.offsetTop + activeEl.offsetHeight / 2 - viewportH / 2;
}

// Smooth, continuous lerp-based scroll for fullscreen lyrics — no native scrollbar, no jumps.
function startLyricsFsScrollLoop() {
  function tick() {
    if (lyricsFsOpen) {
      const viewport = document.getElementById('lyricsFsViewport');
      lyricsFsScrollTarget = computeLyricsFsTargetOffset(viewport.clientHeight);
      lyricsFsScrollCurrent += (lyricsFsScrollTarget - lyricsFsScrollCurrent) * 0.09;
      document.getElementById('lyricsFsTrack').style.transform = `translateY(${-lyricsFsScrollCurrent}px)`;

      // Subtle bass-reactive pulse on the header art, reusing the already-computed analyser data
      if (analyser && analyserData) {
        analyser.getByteFrequencyData(analyserData);
        let bass = 0;
        const bassEnd = Math.floor(analyserData.length * 0.15);
        for (let i = 0; i < bassEnd; i++) bass += analyserData[i];
        bass /= bassEnd || 1;
        const scale = 1 + Math.min(bass / 255, 1) * 0.05;
        document.getElementById('lyricsFsArt').style.transform = `scale(${scale.toFixed(3)})`;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------- Resume on launch ----------
function persistSessionState() {
  if (queue.length === 0 || !players[activeKey]) return;
  const p = players[activeKey];
  library.lastSession = {
    trackIds: queue.map((t) => t.id),
    queueIndex,
    currentTime: p.el.currentTime || 0,
    shuffleMode,
    repeatMode,
  };
  persistLibrary();
}

async function restoreLastSession() {
  const session = library.lastSession;
  if (!session || !Array.isArray(session.trackIds) || session.trackIds.length === 0) return;
  const restoredQueue = session.trackIds.map((id) => library.tracks.find((t) => t.id === id)).filter(Boolean);
  if (restoredQueue.length === 0) return;
  ensureAudioGraph();
  queue = restoredQueue;
  queueIndex = Math.min(Math.max(session.queueIndex || 0, 0), queue.length - 1);
  shuffleMode = session.shuffleMode || 'off';
  repeatMode = session.repeatMode || 'off';
  syncShuffleRepeatUI();
  await hardLoadAndPlay(activeKey, queueIndex, { autoplay: false, seekTo: session.currentTime || 0 });
  showToast('Resumed where you left off', '⏯️');
}

// ---------- Toast notifications ----------
function showToast(message, icon = '✓', duration = 3200) {
  const stack = document.getElementById('toastStack');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${esc(message)}</span>`;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ---------- Track context menu ----------
function wireContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.track-row');
    const menu = document.getElementById('contextMenu');
    if (!row || !row.dataset.trackId) { menu.classList.add('hidden'); return; }
    e.preventDefault();
    const track = library.tracks.find((t) => t.id === row.dataset.trackId);
    if (!track) return;
    buildContextMenu(track, e.clientX, e.clientY);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#contextMenu')) document.getElementById('contextMenu').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('contextMenu').classList.add('hidden');
  });
}

function buildContextMenu(track, x, y) {
  const menu = document.getElementById('contextMenu');
  const isFav = library.favorites.songs.includes(track.id);
  const isYoutube = track.source === 'youtube';
  const playlistItems = library.playlists.map((pl) =>
    `<div class="ctx-item" data-add-playlist="${pl.id}">${esc(pl.name)}</div>`
  ).join('');

  const fileActions = isYoutube
    ? `<div class="ctx-item" data-action="openYoutube">🔗 Open on YouTube</div>`
    : `<div class="ctx-item" data-action="showInFolder">📁 Show in File Explorer</div>
       <div class="ctx-item" data-action="editInfo">✏️ Edit Track Info</div>
       <div class="ctx-item" data-action="${track.videoPath ? 'removeVideo' : 'attachVideo'}">🎬 ${
         track.videoPath ? 'Remove Music Video' : 'Attach Music Video…'}</div>`;

  menu.innerHTML = `
    <div class="ctx-item" data-action="playNext">▶️ Play Next</div>
    <div class="ctx-item" data-action="addQueue">📑 Add to Queue</div>
    <div class="ctx-item" data-action="toggleFav">${isFav ? '💔 Remove from Liked Songs' : '❤️ Add to Liked Songs'}</div>
    <div class="ctx-item has-submenu">📂 Add to Playlist ▸
      <div class="ctx-submenu">
        ${playlistItems || '<div class="ctx-item" style="color:var(--text-faint)">No playlists yet</div>'}
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-action="newPlaylist">+ New Playlist…</div>
      </div>
    </div>
    <div class="ctx-sep"></div>
    ${fileActions}
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="removeFromLibrary">🗑️ Remove from Library</div>
  `;

  menu.querySelectorAll('[data-action]').forEach((item) => {
    item.addEventListener('click', () => handleContextAction(item.dataset.action, track));
  });
  menu.querySelectorAll('[data-add-playlist]').forEach((item) => {
    item.addEventListener('click', async () => {
      const pl = library.playlists.find((p) => p.id === item.dataset.addPlaylist);
      if (!pl) return;
      if (!pl.trackIds.includes(track.id)) pl.trackIds.push(track.id);
      await persistLibrary();
      showToast(`Added to "${pl.name}"`, '📂');
      menu.classList.add('hidden');
    });
  });

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

async function handleContextAction(action, track) {
  const menu = document.getElementById('contextMenu');
  menu.classList.add('hidden');

  if (action === 'playNext') {
    if (queue.length === 0) { playFromList([track], 0); return; }
    queue.splice(queueIndex + 1, 0, track);
    showToast(`"${track.title}" will play next`, '▶️');
  } else if (action === 'addQueue') {
    if (queue.length === 0) { playFromList([track], 0); return; }
    queue.push(track);
    showToast(`Added "${track.title}" to queue`, '📑');
  } else if (action === 'toggleFav') {
    toggleFavoriteSong(track.id);
  } else if (action === 'newPlaylist') {
    const name = await promptModal('Playlist name:');
    if (!name) return;
    const pl = { id: 'pl_' + Date.now(), name, trackIds: [track.id] };
    library.playlists.push(pl);
    await persistLibrary();
    showToast(`Created "${name}" and added track`, '📂');
  } else if (action === 'showInFolder') {
    window.api.showInFolder(track.path);
  } else if (action === 'openYoutube') {
    window.api.openExternal(`https://www.youtube.com/watch?v=${track.videoId}`);
  } else if (action === 'attachVideo') {
    const picked = await window.api.pickVideoFile();
    if (!picked) return;
    track.videoPath = picked;
    track.videoChecked = true;
    await persistLibrary();
    if (queue[queueIndex] && queue[queueIndex].id === track.id) refreshNpVideoAvailability(track);
    showToast(`Music video attached to "${track.title}"`, '🎬');
  } else if (action === 'removeVideo') {
    track.videoPath = null;
    track.videoChecked = true;
    await persistLibrary();
    if (queue[queueIndex] && queue[queueIndex].id === track.id) {
      if (npVideoMode) setNpVideoMode(false);
      refreshNpVideoAvailability(track);
    }
    showToast(`Music video removed from "${track.title}"`, '🎬');
  } else if (action === 'editInfo') {
    openMetaEditor(track);
  } else if (action === 'removeFromLibrary') {
    const doRemove = async () => {
      library.tracks = library.tracks.filter((t) => t.id !== track.id);
      library.favorites.songs = library.favorites.songs.filter((id) => id !== track.id);
      queue = queue.filter((t) => t.id !== track.id);
      await persistLibrary();
      showToast(`Removed "${track.title}" from library`, '🗑️');
      refreshCurrentScreen();
    };
    if (settings.confirmDestructive) {
      if (confirm(`Remove "${track.title}" from your library? The file itself won't be deleted.`)) await doRemove();
    } else {
      await doRemove();
    }
  }
}

// ---------- Keyboard shortcuts help ----------
const SHORTCUTS_LIST = [
  ['Space', 'Play / Pause'],
  ['Shift + →', 'Next track'],
  ['Shift + ←', 'Previous track'],
  ['↑ / ↓', 'Volume up / down'],
  ['M', 'Mute / unmute'],
  ['S', 'Cycle shuffle mode'],
  ['R', 'Cycle repeat mode'],
  ['F', 'Favorite current track'],
  ['L', 'Toggle lyrics panel'],
  ['Q', 'Toggle queue panel'],
  ['Esc', 'Close overlay / panel / menu'],
  ['F11', 'Toggle true fullscreen'],
  ['?', 'Show this help'],
];

function wireShortcutsModal() {
  document.getElementById('shortcutsModalClose').addEventListener('click', closeShortcutsModal);
  document.getElementById('shortcutsModal').addEventListener('click', (e) => {
    if (e.target.id === 'shortcutsModal') closeShortcutsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') openShortcutsModal();
  });
  const grid = document.getElementById('shortcutsGrid');
  grid.innerHTML = SHORTCUTS_LIST.map(([key, desc]) =>
    `<div class="shortcut-row"><span>${esc(desc)}</span><span class="shortcut-key">${esc(key)}</span></div>`
  ).join('');
}

function openShortcutsModal() { document.getElementById('shortcutsModal').classList.remove('hidden'); }
function closeShortcutsModal() { document.getElementById('shortcutsModal').classList.add('hidden'); }

// ---------- Utils ----------

function groupBy(arr, keyFn) {
  const map = new Map();
  arr.forEach((item) => {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  });
  return map;
}

function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
