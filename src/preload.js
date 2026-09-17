const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadLibrary: () => ipcRenderer.invoke('store:loadLibrary'),
  saveLibrary: (data) => ipcRenderer.invoke('store:saveLibrary', data),
  loadSettings: () => ipcRenderer.invoke('store:loadSettings'),
  saveSettings: (data) => ipcRenderer.invoke('store:saveSettings', data),
  pickFolder: () => ipcRenderer.invoke('library:pickFolder'),
  scanFolders: (folders) => ipcRenderer.invoke('library:scanFolders', folders),
  onScanProgress: (cb) => ipcRenderer.on('library:scanProgress', (e, payload) => cb(payload)),
  loadLyricsForTrack: (trackPath) => ipcRenderer.invoke('lyrics:loadForTrack', trackPath),
  getFileUrl: (filePath) => ipcRenderer.invoke('app:getFileUrl', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('app:showInFolder', filePath),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  setFullScreen: (flag) => ipcRenderer.invoke('app:setFullScreen', flag),
  isFullScreen: () => ipcRenderer.invoke('app:isFullScreen'),
  onFullscreenChange: (cb) => ipcRenderer.on('app:fullscreenChanged', (e, flag) => cb(flag)),
  // Music video lookup for local tracks
  findVideoForTrack: (trackPath) => ipcRenderer.invoke('video:findForTrack', trackPath),
  pickVideoFile: () => ipcRenderer.invoke('video:pickFile'),

  ytdlpSearch: (query) => ipcRenderer.invoke('ytdlp:search', query),
  ytdlpFetchPlaylist: (url) => ipcRenderer.invoke('ytdlp:fetchPlaylist', url),
  ytdlpFetchTrackInfo: (videoId) => ipcRenderer.invoke('ytdlp:fetchTrackInfo', videoId),

  // Lyrics romanization (Japanese/Korean/Chinese -> Latin script)
  romanizeLyrics: (lines) => ipcRenderer.invoke('lyrics:romanize', lines),

  // Mini player
  openMiniPlayer: () => ipcRenderer.invoke('miniplayer:open'),
  closeMiniPlayer: () => ipcRenderer.invoke('miniplayer:close'),
  pushMiniState: (state) => ipcRenderer.send('miniplayer:pushState', state),
  onMiniPlayerState: (cb) => ipcRenderer.on('miniplayer:state', (e, state) => cb(state)),
  sendMiniCommand: (cmd) => ipcRenderer.send('miniplayer:command', cmd),
  onMiniPlayerCommand: (cb) => ipcRenderer.on('miniplayer:command', (e, cmd) => cb(cmd)),
  onMiniPlayerClosed: (cb) => ipcRenderer.on('miniplayer:closed', () => cb()),
  onMiniPlayerStateRequest: (cb) => ipcRenderer.on('miniplayer:requestState', () => cb()),

  // Metadata editor
  writeMetadata: (payload) => ipcRenderer.invoke('metadata:write', payload),
  pickArtworkFile: () => ipcRenderer.invoke('metadata:pickArtwork'),

  // System notifications
  notifyTrackChange: (payload) => ipcRenderer.send('notify:trackChange', payload),

  // Media keys
  onMediaKey: (cb) => {
    ipcRenderer.on('mediakey:playPause', () => cb('playPause'));
    ipcRenderer.on('mediakey:next', () => cb('next'));
    ipcRenderer.on('mediakey:prev', () => cb('prev'));
    ipcRenderer.on('mediakey:stop', () => cb('stop'));
  },

  // Auto-update (see setupAutoUpdater in main.js)
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (e, version) => cb(version)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (e, version) => cb(version)),
  installUpdateNow: () => ipcRenderer.send('update:installNow'),
});
