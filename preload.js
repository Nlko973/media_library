const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFiles: (mediaType) => ipcRenderer.invoke('select-files', mediaType),
  readMetadata: () => ipcRenderer.invoke('read-metadata'),
  writeMetadata: (data) => ipcRenderer.invoke('write-metadata', data),
  toggleFavorite: (id, favorite) => ipcRenderer.invoke('toggle-favorite', id, favorite),
  updateDurations: (durations) => ipcRenderer.invoke('update-durations', durations),
  moveFile: (srcPath, category, mediaType, external) => ipcRenderer.invoke('move-file', srcPath, category, mediaType, external),
  getVideoDuration: (videoPath) => ipcRenderer.invoke('get-video-duration', videoPath),
  selectVideoThumbnail: (videoPath) => ipcRenderer.invoke('select-video-thumbnail', videoPath),
  pasteVideoThumbnail: (videoPath) => ipcRenderer.invoke('paste-video-thumbnail', videoPath),
  getCastUrl: () => ipcRenderer.invoke('get-cast-url'),
  selectComicLinksFile: () => ipcRenderer.invoke('select-comic-links-file'),
  importComicsFile: (filePath, category) => ipcRenderer.invoke('import-comics-file', filePath, category),
  selectComicPreviewFile: () => ipcRenderer.invoke('select-comic-preview-file'),
  importManualComic: (options) => ipcRenderer.invoke('import-manual-comic', options),
  onComicImportProgress: (callback) => {
    const listener = (event, progress) => callback(progress)
    ipcRenderer.on('comic-import-progress', listener)
    return () => ipcRenderer.removeListener('comic-import-progress', listener)
  },
  removeComicPage: (comicId, pagePath) => ipcRenderer.invoke('remove-comic-page', comicId, pagePath),
  saveFile: (relPath, dataURL) => ipcRenderer.invoke('save-file', relPath, dataURL),
  listImportFiles: (srcFolder, mediaType) => ipcRenderer.invoke('list-import-files', srcFolder, mediaType),
  moveFolder: (srcFolder, category, mediaType) => ipcRenderer.invoke('move-folder', srcFolder, category, mediaType)
  ,deleteMedia: (id) => ipcRenderer.invoke('delete-media', id)
  ,updateMedia: (changes) => ipcRenderer.invoke('update-media', changes)
})
