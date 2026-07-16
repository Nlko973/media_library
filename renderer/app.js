const $ = sel => document.querySelector(sel)

function createBrowserApi() {
  // Desktop-only actions (file pickers, import, thumbnail paste) stay blocked
  // in the web/cast view — there is no equivalent over plain HTTP.
  const desktopOnly = () => Promise.resolve({ error: 'Это действие доступно только в десктоп-приложении' })

  // Generic JSON POST helper for the cast server write endpoints.
  const postJson = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try { message = (await res.json()).error || message } catch (e) {}
      return { error: message }
    }
    return res.json()
  }

  return {
    readMetadata: async () => {
      const res = await fetch('/api/metadata', { cache: 'no-store' })
      if (!res.ok) throw new Error('Cannot load library')
      return res.json()
    },
    // Full metadata replacement. Used for tag/category management and bulk edits.
    writeMetadata: async (data) => {
      const result = await postJson('/api/metadata', data)
      return !!(result && result.ok)
    },
    toggleFavorite: async (id, favorite) => postJson('/api/toggle-favorite', { id, favorite }),
    updateDurations: async (durations) => postJson('/api/update-durations', durations),
    deleteMedia: async (id) => postJson('/api/delete-media', { id }),
    // Single-item field update (name, category, tags, description).
    updateMedia: async (changes) => postJson('/api/update-media', changes),
    getCastUrl: async () => ({ url: location.href, urls: [location.href] }),
    selectFolder: desktopOnly,
    selectFiles: desktopOnly,
    moveFile: desktopOnly,
    getVideoDuration: async () => ({ duration: null }),
    selectVideoThumbnail: desktopOnly,
    pasteVideoThumbnail: desktopOnly,
    selectComicLinksFile: desktopOnly,
    importComicsFile: desktopOnly,
    selectComicPreviewFile: desktopOnly,
    importManualComic: desktopOnly,
    onComicImportProgress: () => () => {},
    removeComicPage: desktopOnly,
    saveFile: desktopOnly,
    listImportFiles: async () => [],
    moveFolder: async () => []
  }
}

if (!window.api) window.api = createBrowserApi()

let state = {
  mode: 'photo',
  metadata: { media: [], tags: [], privateCategories: [] },
  currentCategory: null,
  selectedTags: [],
  favoriteOnly: false,
  importing: false,
  editingId: null,
  viewerId: null,
  viewerFillFullscreen: false,
  comicZoom: 100,
  selectedMediaIds: new Set(),
  editSelectedTags: [],
  page: 1,
  pageSize: 24
}

let searchTimer = null
let durationLookupRun = 0
const viewerSwipe = {
  startX: 0,
  startY: 0,
  active: false
}

async function init() {
  applyStoredTheme()
  applyImportNoMovePref()
  bindUI()
  state.metadata = await window.api.readMetadata()
  updateImportMode()
  renderCategories()
  renderTags()
  renderMediaGrid()
  setImportProgress(0, 0, '')
}

function bindUI() {
  $('#cast-link').addEventListener('click', showCastLink)
  $('#theme-toggle').addEventListener('click', toggleTheme)
  $('#mode-photo').addEventListener('click', () => setMode('photo'))
  $('#mode-video').addEventListener('click', () => setMode('video'))
  $('#mode-comic').addEventListener('click', () => setMode('comic'))
  $('#add-category').addEventListener('click', addCategory)
  $('#add-tag').addEventListener('click', addTag)
  $('#category-search').addEventListener('input', () => renderCategories())
  $('#tag-search').addEventListener('input', () => renderTags())
  $('#toggle-categories').addEventListener('click', () => toggleSidebarPanel('categories-panel', 'toggle-categories'))
  $('#toggle-tags').addEventListener('click', () => toggleSidebarPanel('tags-panel', 'toggle-tags'))
  bindStableTextInputs()
  $('#select-folder').addEventListener('click', selectFolder)
  $('#select-files').addEventListener('click', selectFiles)
  $('#import-move').addEventListener('click', importMove)
  $('#import-no-move').addEventListener('change', event => {
    localStorage.setItem('import-no-move', event.target.checked ? '1' : '0')
  })
  $('#select-comic-links').addEventListener('click', selectComicLinksFile)
  $('#import-comics').addEventListener('click', importComics)
  $('#import-manual-comic').addEventListener('click', openManualComicModal)
  $('#toggle-favorites').addEventListener('click', toggleFavoriteFilter)
  $('#search-input').addEventListener('input', scheduleSearchRender)
  $('#exclude-tags').addEventListener('change', () => {
    state.page = 1
    state.selectedMediaIds.clear()
    renderMediaGrid()
  })
  $('#viewer-close').addEventListener('click', closeViewer)
  $('#comic-zoom').addEventListener('input', event => setComicZoom(event.target.value))
  $('#comic-zoom-out').addEventListener('click', () => setComicZoom(state.comicZoom - 10))
  $('#comic-zoom-in').addEventListener('click', () => setComicZoom(state.comicZoom + 10))
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      state.viewerFillFullscreen = false
      $('#viewer').classList.remove('viewer-fill')
    }
  })
  $('#viewer').addEventListener('click', event => {
    if (event.target.id === 'viewer') closeViewer()
  })
  document.addEventListener('keydown', handleViewerKeys)
  $('#edit-form').addEventListener('submit', saveEditForm)
  $('#edit-close').addEventListener('click', closeEditModal)
  $('#edit-cancel').addEventListener('click', closeEditModal)
  $('#edit-add-tag').addEventListener('click', addEditTag)
  $('#edit-thumbnail-change').addEventListener('click', changeVideoThumbnail)
  $('#edit-thumbnail-paste').addEventListener('click', pasteVideoThumbnail)
  $('#edit-new-tag').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addEditTag()
    }
  })
  $('#edit-modal').addEventListener('click', event => {
    if (event.target.id === 'edit-modal') closeEditModal()
  })
  $('#manual-comic-form').addEventListener('submit', importManualComic)
  $('#manual-comic-close').addEventListener('click', closeManualComicModal)
  $('#manual-comic-cancel').addEventListener('click', closeManualComicModal)
  $('#manual-comic-folder-select').addEventListener('click', selectManualComicFolder)
  $('#manual-comic-preview-select').addEventListener('click', selectManualComicPreview)
  $('#manual-comic-modal').addEventListener('click', event => {
    if (event.target.id === 'manual-comic-modal') closeManualComicModal()
  })
  $('#select-visible').addEventListener('click', selectVisibleItems)
  $('#clear-selection').addEventListener('click', clearSelection)
  $('#bulk-change-category').addEventListener('click', bulkChangeCategory)
  $('#bulk-delete').addEventListener('click', bulkDeleteSelected)
}

async function showCastLink() {
  const button = $('#cast-link')
  button.disabled = true
  try {
    const result = await window.api.getCastUrl()
    if (!result || result.error) return alert('Error: ' + (result?.error || 'Cannot start local broadcast'))
    const urls = result.urls && result.urls.length ? result.urls : [result.url]
    const text = `Open one of these links on a phone or tablet in the same local network:\n\n${urls.join('\n')}\n\nIf it does not open, allow this app in Windows Firewall for private networks.`
    try {
      await navigator.clipboard?.writeText(urls[0])
      alert(`${text}\n\nFirst link copied to clipboard.`)
    } catch (e) {
      alert(text)
    }
  } finally {
    button.disabled = false
  }
}

function mediaSrc(filePath, cacheBust = false) {
  if (!filePath) return ''
  const suffix = cacheBust ? `&v=${Date.now()}` : ''
  if (location.protocol === 'file:') return `file://${filePath}${cacheBust ? `?v=${Date.now()}` : ''}`
  return `/media?path=${encodeURIComponent(filePath)}${suffix}`
}

function applyStoredTheme() {
  const theme = localStorage.getItem('theme') || 'light'
  document.body.dataset.theme = theme
  updateThemeButton(theme)
}

function applyImportNoMovePref() {
  const checkbox = $('#import-no-move')
  if (checkbox) checkbox.checked = localStorage.getItem('import-no-move') === '1'
}

function toggleTheme() {
  const nextTheme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'
  document.body.dataset.theme = nextTheme
  localStorage.setItem('theme', nextTheme)
  updateThemeButton(nextTheme)
}

function updateThemeButton(theme) {
  const button = $('#theme-toggle')
  if (!button) return
  button.textContent = theme === 'dark' ? '☀' : '☾'
  button.title = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
}

function bindStableTextInputs() {
  document.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('click', event => event.stopPropagation())
    input.addEventListener('mousedown', event => event.stopPropagation())
    input.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Enter' && input.id === 'new-category') {
        event.preventDefault()
        addCategory()
      }
      if (event.key === 'Enter' && input.id === 'new-tag') {
        event.preventDefault()
        addTag()
      }
    })
  })

  const searchBox = $('.search-box')
  if (searchBox) {
    searchBox.addEventListener('click', () => $('#search-input').focus())
  }
}

function scheduleSearchRender() {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    state.page = 1
    state.selectedMediaIds.clear()
    renderMediaGrid()
  }, 120)
}

function setMode(mode) {
  state.mode = mode
  state.currentCategory = null
  state.selectedTags = []
  state.favoriteOnly = false
  state.selectedMediaIds.clear()
  state.page = 1
  $('#mode-photo').classList.toggle('active', mode === 'photo')
  $('#mode-video').classList.toggle('active', mode === 'video')
  $('#mode-comic').classList.toggle('active', mode === 'comic')
  updateImportMode()
  renderCategories()
  renderTags()
  // scrollToTopOfContent is called after render so the browser has
  // finished layout and the scroll reset sticks.
  renderMediaGrid()
  scrollToTopOfContent()
}

function scrollToTopOfContent() {
  const candidates = [$('#content'), $('main'), $('#app')]
  const reset = () => {
    // Reset every scroll container that could hold the scroll position.
    candidates.forEach(el => {
      if (!el) return
      if (typeof el.scrollTop === 'number') el.scrollTop = 0
      if (el.scrollTo) el.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    })
    const sidebar = $('#sidebar')
    if (sidebar) {
      sidebar.scrollTop = 0
      sidebar.scrollTo?.({ top: 0, left: 0, behavior: 'auto' })
    }
    window.scrollTo(0, 0)
    // As a last resort, scroll the content toolbar into view at the top.
    const toolbar = $('.content-toolbar')
    if (toolbar) toolbar.scrollIntoView({ block: 'start', behavior: 'auto' })
  }
  // Reset immediately, then again after the browser finishes layout for the
  // newly rendered content. Two rAFs guarantee we run after paint; a small
  // timeout covers image-load driven reflow of the grid.
  reset()
  requestAnimationFrame(reset)
  requestAnimationFrame(() => requestAnimationFrame(reset))
  setTimeout(reset, 0)
  setTimeout(reset, 50)
}

function toggleSidebarPanel(panelId, buttonId) {
  const panel = $(`#${panelId}`)
  const button = $(`#${buttonId}`)
  const collapsed = panel.classList.toggle('collapsed')
  button.textContent = collapsed ? 'v' : '^'
}

function updateImportMode() {
  const isComic = state.mode === 'comic'
  document.querySelectorAll('.comic-import-control').forEach(el => el.classList.toggle('hidden', !isComic))
  $('#select-files').classList.toggle('hidden', isComic)
  $('#select-folder').classList.toggle('hidden', isComic)
  $('#import-path').classList.toggle('hidden', isComic)
  $('#import-category').classList.toggle('hidden', false)
  $('#import-move').classList.toggle('hidden', isComic)
  $('#import-no-move-wrap').classList.toggle('hidden', isComic)
}

function getModeItems() {
  return state.metadata.media.filter(item => item.type === state.mode)
}

function findMediaById(id) {
  return state.metadata.media.find(item => String(item.id) === String(id))
}

function isPrivateCategory(category) {
  if (!category) return false
  const list = state.metadata.privateCategories || []
  return list.some(item => item === category)
}

function togglePrivateCategory(category) {
  if (!category) return
  const list = state.metadata.privateCategories || (state.metadata.privateCategories = [])
  const index = list.indexOf(category)
  if (index === -1) list.push(category)
  else list.splice(index, 1)
  window.api.writeMetadata(state.metadata)
}

function getCategories() {
  const categories = new Set(getModeItems().map(item => item.category || 'No category'))
  if (state.mode === 'comic') categories.add('Comics')
  if (state.currentCategory) categories.add(state.currentCategory)
  return Array.from(categories).sort((a, b) => a.localeCompare(b))
}

function matchPanelSearch(text, input) {
  if (!input) return true
  const query = (input.value || '').trim().toLowerCase()
  if (!query) return true
  return String(text || '').toLowerCase().includes(query)
}

function renderCategories() {
  const ul = $('#categories')
  ul.innerHTML = ''


  const allItems = getModeItems()
  const privateSet = new Set(state.metadata.privateCategories || [])
  const publicCount = allItems.filter(item => !privateSet.has(item.category || 'No category')).length
  const all = document.createElement('li')
  all.classList.toggle('active', !state.currentCategory)
  all.innerHTML = `<span class="category-name">All</span><span class="category-total">${publicCount}</span><span class="list-spacer"></span>`
  all.addEventListener('click', () => {
    state.currentCategory = null
    state.page = 1
    state.selectedMediaIds.clear()
    renderCategories()
    renderMediaGrid()
  })
  ul.appendChild(all)

  getCategories().forEach(category => {
    if (!matchPanelSearch(category, $('#category-search'))) return
    const li = document.createElement('li')
    const isPrivate = privateSet.has(category)
    const count = allItems.filter(item => (item.category || 'No category') === category).length
    li.classList.toggle('active', category === state.currentCategory)
    li.classList.toggle('private', isPrivate)
    const privacyTitle = isPrivate ? 'Снять приватность' : 'Сделать приватной'
    const privacyIcon = isPrivate ? '🔒' : '🔓'
    li.innerHTML = `
      <span class="category-name"></span>
      <span class="category-total">${count}</span>
      ${category === 'No category'
        ? '<span class="list-spacer"></span>'
        : `<button class="list-private ${isPrivate ? 'active' : ''}" type="button" title="${privacyTitle}">${privacyIcon}</button><button class="list-delete" type="button" title="Delete category">x</button>`}
    `
    li.querySelector('.category-name').textContent = category
    li.addEventListener('click', () => {
      state.currentCategory = category
      state.page = 1
      state.selectedMediaIds.clear()
      renderCategories()
      renderMediaGrid()
    })
    const privacyButton = li.querySelector('.list-private')
    if (privacyButton) {
      privacyButton.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        togglePrivateCategory(category)
        state.page = 1
        state.selectedMediaIds.clear()
        renderCategories()
        renderMediaGrid()
      })
    }
    const deleteButton = li.querySelector('.list-delete')
    if (deleteButton) {
      deleteButton.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        deleteCategory(category)
      })
    }
    ul.appendChild(li)
  })

  $('#category-count').textContent = getCategories().length
  updateImportCategorySelect()
  updateCategorySelect($('#edit-category'), state.editingId ? findMediaById(state.editingId)?.category : '')
  updateCategorySelect($('#bulk-category'), '')
  updateCategorySelect($('#manual-comic-category'), $('#import-category').value || state.currentCategory || 'Comics')
}

function updateImportCategorySelect() {
  const select = $('#import-category')
  const currentValue = select.value
  select.innerHTML = ''

  getCategories().forEach(category => {
    const option = document.createElement('option')
    option.value = category
    option.textContent = category
    select.appendChild(option)
  })

  const option = document.createElement('option')
  option.value = '__new__'
  option.textContent = 'Create new'
  select.appendChild(option)

  if (currentValue && [...select.options].some(optionItem => optionItem.value === currentValue)) {
    select.value = currentValue
  } else if (state.currentCategory) {
    select.value = state.currentCategory
  }
}

function updateCategorySelect(select, selectedValue) {
  if (!select) return
  const currentValue = selectedValue || select.value
  select.innerHTML = ''

  getCategories().forEach(category => {
    const option = document.createElement('option')
    option.value = category
    option.textContent = category
    select.appendChild(option)
  })

  const option = document.createElement('option')
  option.value = '__new__'
  option.textContent = 'Create new'
  select.appendChild(option)

  if (currentValue && [...select.options].some(optionItem => optionItem.value === currentValue)) {
    select.value = currentValue
  }
}

function addCategory() {
  const value = $('#new-category').value.trim()
  if (!value) return
  state.currentCategory = value
  state.page = 1
  $('#new-category').value = ''
  renderCategories()
  renderMediaGrid()
}

function addTag() {
  const value = $('#new-tag').value.trim()
  if (!value) return
  if (!state.metadata.tags.includes(value)) state.metadata.tags.push(value)
  $('#new-tag').value = ''
  window.api.writeMetadata(state.metadata)
  renderTags()
}

function deleteTag(tag) {
  const usedCount = state.metadata.media.filter(item => (item.tags || []).includes(tag)).length
  const ok = confirm(usedCount
    ? `Delete tag "${tag}" from ${usedCount} files?`
    : `Delete tag "${tag}"?`)
  if (!ok) return

  state.metadata.tags = state.metadata.tags.filter(item => item !== tag)
  state.selectedTags = state.selectedTags.filter(item => item !== tag)
  state.editSelectedTags = state.editSelectedTags.filter(item => item !== tag)
  state.metadata.media.forEach(item => {
    item.tags = (item.tags || []).filter(itemTag => itemTag !== tag)
  })
  window.api.writeMetadata(state.metadata)
  renderTags()
  renderMediaGrid()
}

function deleteCategory(category) {
  const affected = getModeItems().filter(item => (item.category || 'No category') === category)
  if (!affected.length) return
  const ok = confirm(`Remove category "${category}" from ${affected.length} files? Files will stay in the library.`)
  if (!ok) return

  affected.forEach(item => {
    item.category = 'No category'
  })
  if (state.currentCategory === category) state.currentCategory = null
  state.page = 1
  window.api.writeMetadata(state.metadata)
  renderCategories()
  renderMediaGrid()
}

function renderTags() {
  const wrap = $('#tags')
  wrap.innerHTML = ''
  const search = $('#tag-search')

  state.metadata.tags
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .forEach(tag => {
      if (!matchPanelSearch(tag, search)) return
      const label = document.createElement('label')
      label.className = 'tag-option'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = tag
      checkbox.checked = state.selectedTags.includes(tag)
      checkbox.addEventListener('change', event => {
        if (event.target.checked) state.selectedTags.push(tag)
        else state.selectedTags = state.selectedTags.filter(item => item !== tag)
        state.page = 1
        state.selectedMediaIds.clear()
        renderMediaGrid()
      })
      const span = document.createElement('span')
      span.textContent = tag
      const del = document.createElement('button')
      del.className = 'list-delete'
      del.type = 'button'
      del.title = 'Delete tag'
      del.textContent = 'x'
      del.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        deleteTag(tag)
      })
      label.appendChild(checkbox)
      label.appendChild(span)
      label.appendChild(del)
      wrap.appendChild(label)
    })

  $('#tag-count').textContent = state.metadata.tags.length
  renderEditTags()
}

async function selectFolder() {
  const btn = $('#select-folder')
  btn.disabled = true
  try {
    const path = await window.api.selectFolder()
    $('#import-path').textContent = path || ''
  } finally {
    btn.disabled = false
  }
}

async function importMove() {
  const sourcePath = $('#import-path').textContent
  if (!sourcePath) return alert('Choose a folder first')

  const category = await resolveImportCategory()
  if (!category) return

  const files = await window.api.listImportFiles(sourcePath, state.mode)
  if (files && files.error) return alert('Error: ' + files.error)
  if (!files.length) return alert('No supported files found in this folder')

  const external = $('#import-no-move').checked
  const verb = external ? 'import' : 'move'
  const ok = confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${files.length} files to "${category}"?`)
  if (!ok) return
  await importPaths(files, category, external)
}

async function selectFiles() {
  const btn = $('#select-files')
  btn.disabled = true
  try {
    const category = await resolveImportCategory()
    if (!category) return

    const paths = await window.api.selectFiles(state.mode)
    if (!paths || paths.error) return alert(paths?.error || 'No files selected')
    if (!paths.length) return
    await importPaths(paths, category, $('#import-no-move').checked)
  } finally {
    btn.disabled = false
  }
}

async function selectComicLinksFile() {
  const filePath = await window.api.selectComicLinksFile()
  if (!filePath || filePath.error) {
    if (filePath?.error) alert(filePath.error)
    return
  }
  $('#comic-links-path').textContent = filePath
}

async function importComics() {
  const category = await resolveImportCategory()
  if (!category) return

  const linksPath = $('#comic-links-path').textContent.trim()
  state.importing = true
  setImportControlsDisabled(true)
  setImportProgress(0, 1, 'Importing comics')
  const offProgress = window.api.onComicImportProgress(progress => {
    const done = Number(progress.done) || 0
    const total = Number(progress.total) || 1
    const imported = Number(progress.imported) || 0
    const failed = Number(progress.failed) || 0
    const name = progress.current ? getFileName(progress.current) : 'Importing comics'
    setImportProgress(done, total, `${name} | added ${imported}, failed ${failed}`)
  })
  try {
    const result = await window.api.importComicsFile(linksPath || null, category)
    if (!result || result.error) return alert('Error: ' + (result?.error || 'Cannot import comics'))

    state.metadata = await window.api.readMetadata()
    state.currentCategory = category
    state.page = 1
    state.selectedMediaIds.clear()
    renderCategories()
    renderTags()
    renderMediaGrid()

    const imported = result.imported ? result.imported.length : 0
    const failed = result.errors ? result.errors.length : 0
    setImportProgress(result.total || imported, result.total || imported || 1, `Imported ${imported}, skipped ${failed}`)
    if (failed) {
      console.warn('Comic import issues', result.errors)
      alert(formatComicImportErrors(imported, result.errors))
    }
  } finally {
    offProgress()
    state.importing = false
    setImportControlsDisabled(false)
  }
}

async function openManualComicModal() {
  $('#manual-comic-title').value = ''
  $('#manual-comic-folder').value = ''
  $('#manual-comic-preview').value = ''
  updateCategorySelect($('#manual-comic-category'), $('#import-category').value || state.currentCategory || 'Comics')
  $('#manual-comic-modal').classList.remove('hidden')
  $('#manual-comic-title').focus()
}

function closeManualComicModal() {
  if (state.importing) return
  $('#manual-comic-modal').classList.add('hidden')
}

async function selectManualComicFolder() {
  const folder = await window.api.selectFolder()
  if (!folder || folder.error) {
    if (folder?.error) alert(folder.error)
    return
  }
  $('#manual-comic-folder').value = folder
  if (!$('#manual-comic-title').value.trim()) $('#manual-comic-title').value = getFileName(folder)
}

async function selectManualComicPreview() {
  const filePath = await window.api.selectComicPreviewFile()
  if (!filePath || filePath.error) {
    if (filePath?.error) alert(filePath.error)
    return
  }
  $('#manual-comic-preview').value = filePath
}

async function importManualComic(event) {
  event.preventDefault()

  const category = await resolveCategoryFromSelect($('#manual-comic-category'))
  if (!category) return

  const title = $('#manual-comic-title').value.trim()
  const contentFolder = $('#manual-comic-folder').value.trim()
  const previewPath = $('#manual-comic-preview').value.trim()

  if (!title) return alert('Введите название комикса')
  if (!contentFolder) return alert('Выберите папку с содержимым комикса')
  if (!previewPath) return alert('Выберите превью комикса')

  state.importing = true
  setImportControlsDisabled(true)
  setImportProgress(0, 1, title)
  try {
    const result = await window.api.importManualComic({ contentFolder, previewPath, title, category })
    if (!result || result.error) return alert('Error: ' + (result?.error || 'Cannot import comic'))

    state.metadata = await window.api.readMetadata()
    state.currentCategory = result.item.category || category
    state.page = 1
    state.selectedMediaIds.clear()
    renderCategories()
    renderTags()
    renderMediaGrid()
    setImportProgress(1, 1, `Imported ${result.pages || (result.item.pages || []).length}`)
    $('#manual-comic-modal').classList.add('hidden')
  } finally {
    state.importing = false
    setImportControlsDisabled(false)
  }
}

function formatComicImportErrors(imported, errors) {
  const list = (errors || [])
    .map(item => `${item.url}\n${item.error}`)
    .join('\n\n')
  return `Imported: ${imported}\nNot added: ${(errors || []).length}\n\n${list}`
}

async function importPaths(paths, category, external) {
  state.importing = true
  setImportControlsDisabled(true)
  setImportProgress(0, paths.length, 'Preparing')

  try {
    let imported = 0
    for (const path of paths) {
      setImportProgress(imported, paths.length, getFileName(path))
      const result = await window.api.moveFile(path, category, state.mode, external)
      if (result && result.error) console.error('move error', result)
      else addMediaEntry(result.path, path, result.thumbnail, category, result.duration, external)
      imported += 1
      setImportProgress(imported, paths.length, getFileName(path))
    }

    state.metadata = await window.api.readMetadata()
    state.currentCategory = category
    state.page = 1
    renderCategories()
    renderMediaGrid()
  } finally {
    state.importing = false
    setImportControlsDisabled(false)
    setImportProgress(paths.length, paths.length, 'Done')
  }
}

function setImportProgress(done, total, label) {
  const progress = $('#import-progress')
  const fill = $('#import-progress-fill')
  const count = $('#import-progress-count')
  const labelEl = $('#import-progress-label')

  if (!total) {
    progress.classList.add('hidden')
    fill.style.width = '0%'
    count.textContent = '0 / 0'
    labelEl.textContent = 'Import'
    return
  }

  const percent = Math.round((done / total) * 100)
  progress.classList.remove('hidden')
  fill.style.width = `${percent}%`
  count.textContent = `${done} / ${total}`
  labelEl.textContent = label || 'Import'
}

function setImportControlsDisabled(disabled) {
  $('#select-files').disabled = disabled
  $('#select-folder').disabled = disabled
  $('#import-move').disabled = disabled
  $('#import-category').disabled = disabled
  $('#select-comic-links').disabled = disabled
  $('#import-comics').disabled = disabled
  $('#import-manual-comic').disabled = disabled
  $('#manual-comic-title').disabled = disabled
  $('#manual-comic-category').disabled = disabled
  $('#manual-comic-folder-select').disabled = disabled
  $('#manual-comic-preview-select').disabled = disabled
  $('#manual-comic-form button[type="submit"]').disabled = disabled
}

async function resolveImportCategory() {
  return resolveCategoryFromSelect($('#import-category'))
}

function addMediaEntry(destPath, originalPath, thumbnail, category, duration, external) {
  const item = {
    id: Date.now() + Math.random(),
    name: getFileName(destPath),
    path: destPath,
    thumbnail: thumbnail || null,
    original: originalPath,
    type: state.mode,
    category: category || state.currentCategory || 'No category',
    tags: [],
    favorite: false,
    description: '',
    dateAdded: new Date().toISOString(),
    external: !!external
  }
  if (duration) item.duration = duration
  state.metadata.media.push(item)
  window.api.writeMetadata(state.metadata)
}

function getFilteredItems() {
  const query = $('#search-input').value.trim().toLowerCase()
  const exclude = $('#exclude-tags').checked
  let items = getModeItems()

  if (state.currentCategory) {
    // A specific category is selected: show only its items (private or not).
    items = items.filter(item => (item.category || 'No category') === state.currentCategory)
  } else {
    // "All" / common view: hide items that belong to private categories.
    const privateSet = new Set(state.metadata.privateCategories || [])
    items = items.filter(item => !privateSet.has(item.category || 'No category'))
  }
  if (state.favoriteOnly) items = items.filter(item => item.favorite)

  if (state.selectedTags.length) {
    const selectedTags = state.selectedTags.map(tag => tag.toLowerCase())
    if (exclude) {
      items = items.filter(item => {
        const itemTags = (item.tags || []).map(tag => String(tag).toLowerCase())
        return !itemTags.some(tag => selectedTags.includes(tag))
      })
    } else {
      items = items.filter(item => {
        const itemTags = (item.tags || []).map(tag => String(tag).toLowerCase())
        return selectedTags.every(tag => itemTags.includes(tag))
      })
    }
  }

  if (query) {
    const parts = query.split(/\s+/)
    if (exclude) {
      items = items.filter(item => {
        const tags = (item.tags || []).map(tag => String(tag).toLowerCase())
        return !tags.some(tag => parts.some(part => tag.includes(part)))
      })
    } else {
      items = items.filter(item => {
        const name = (item.name || '').toLowerCase()
        const tags = (item.tags || []).map(tag => String(tag).toLowerCase())
        return parts.every(part => name.includes(part) || tags.some(tag => tag.includes(part)))
      })
    }
  }

  return items
}

function renderMediaGrid() {
  const grid = $('#media-grid')
  grid.innerHTML = ''

  const items = getFilteredItems()
  const totalItems = items.length
  const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize))
  if (state.page > totalPages) state.page = totalPages

  const start = (state.page - 1) * state.pageSize
  const pageItems = items.slice(start, start + state.pageSize)
  pageItems.forEach(item => grid.appendChild(createMediaCard(item)))
  grid.dataset.visibleIds = JSON.stringify(pageItems.map(item => String(item.id)))

  $('#empty-state').classList.toggle('hidden', totalItems !== 0)
  $('#toggle-favorites').classList.toggle('active', state.favoriteOnly)
  renderPagination(totalItems)
  updateSummary(totalItems)
  updateBulkToolbar(pageItems)
  lookupVisibleVideoDurations(pageItems)
}

function createMediaCard(item) {
  const card = document.createElement('article')
  card.className = 'media-item'

  const thumbWrap = document.createElement('div')
  thumbWrap.className = 'thumb-wrap'

  const selectorLabel = document.createElement('label')
  selectorLabel.className = 'media-selector'
  selectorLabel.title = 'Select'
  const selector = document.createElement('input')
  selector.type = 'checkbox'
  selector.checked = state.selectedMediaIds.has(String(item.id))
  selector.addEventListener('click', event => event.stopPropagation())
  selector.addEventListener('change', event => {
    const id = String(item.id)
    if (event.target.checked) state.selectedMediaIds.add(id)
    else state.selectedMediaIds.delete(id)
    card.classList.toggle('selected', event.target.checked)
    updateBulkToolbar(getCurrentPageItems())
  })
  selectorLabel.appendChild(selector)
  thumbWrap.appendChild(selectorLabel)

  if (item.type === 'photo' || item.type === 'comic' || item.thumbnail) {
    const img = document.createElement('img')
    img.src = mediaSrc(item.thumbnail || item.path || (item.pages || [])[0])
    img.alt = item.name || 'Media'
    img.addEventListener('click', () => openViewer(item))
    thumbWrap.appendChild(img)
  } else {
    const video = document.createElement('video')
    video.src = mediaSrc(item.path)
    video.muted = true
    video.addEventListener('click', () => openViewer(item))
    thumbWrap.appendChild(video)
  }

  const type = document.createElement('span')
  type.className = 'media-type'
  type.textContent = item.type === 'photo' ? 'Photo' : item.type === 'comic' ? 'Comic' : 'Video'
  thumbWrap.appendChild(type)

  if (item.type === 'video') {
    const duration = document.createElement('span')
    duration.className = 'media-duration'
    duration.dataset.mediaId = String(item.id)
    duration.textContent = formatDuration(item.duration)
    thumbWrap.appendChild(duration)
    if (item.watched) {
      const watched = document.createElement('span')
      watched.className = 'media-watched-badge'
      watched.title = 'Просмотрено'
      watched.textContent = '✓'
      thumbWrap.appendChild(watched)
    }
  }

  const info = document.createElement('div')
  info.className = 'media-info'

  const title = document.createElement('div')
  title.className = 'media-title'
  title.textContent = item.name || 'Untitled'

  const tags = document.createElement('div')
  tags.className = 'media-tags'
  ;(item.tags || []).slice(0, 3).forEach(tag => {
    const tagEl = document.createElement('span')
    tagEl.textContent = tag
    tags.appendChild(tagEl)
  })

  const actions = document.createElement('div')
  actions.className = 'media-actions'

  const favorite = document.createElement('button')
  favorite.textContent = item.favorite ? '★' : '☆'
  favorite.title = 'Favorite'
  favorite.setAttribute('aria-label', 'Favorite')
  favorite.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    toggleFavorite(item.id)
  })

  const edit = document.createElement('button')
  edit.textContent = '✎'
  edit.title = 'Edit'
  edit.setAttribute('aria-label', 'Edit')
  edit.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    editMetadata(item.id)
  })

  const del = document.createElement('button')
  del.className = 'danger'
  del.textContent = '×'
  del.title = 'Delete'
  del.setAttribute('aria-label', 'Delete')
  del.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    deleteMedia(item.id)
  })

  actions.appendChild(favorite)
  actions.appendChild(edit)
  actions.appendChild(del)
  info.appendChild(title)
  info.appendChild(tags)
  info.appendChild(actions)
  card.appendChild(thumbWrap)
  card.appendChild(info)
  card.classList.toggle('selected', state.selectedMediaIds.has(String(item.id)))
  return card
}

function formatDuration(seconds) {
  const total = Math.floor(Number(seconds) || 0)
  if (!total) return ''

  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

async function lookupVisibleVideoDurations(items) {
  const run = ++durationLookupRun
  const videos = items.filter(item => item.type === 'video' && !item.duration && item.path)
  if (!videos.length) return

  const resolved = {}
  for (const item of videos) {
    if (run !== durationLookupRun) return
    const result = await window.api.getVideoDuration(item.path)
    if (run !== durationLookupRun) return
    if (!result || result.error || !result.duration) continue

    item.duration = result.duration
    resolved[String(item.id)] = result.duration
    const durationEl = document.querySelector(`.media-duration[data-media-id="${String(item.id)}"]`)
    if (durationEl) durationEl.textContent = formatDuration(item.duration)
  }

  // Persist durations atomically so we never overwrite favorites/other fields
  // that were changed concurrently on disk.
  if (Object.keys(resolved).length && window.api.updateDurations) {
    window.api.updateDurations(resolved)
  } else if (Object.keys(resolved).length) {
    window.api.writeMetadata(state.metadata)
  }
}

function renderPagination(totalItems) {
  const pager = $('#pagination')
  pager.innerHTML = ''

  const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize))
  const goToPage = page => {
    const nextPage = Math.min(totalPages, Math.max(1, Number(page) || 1))
    if (nextPage === state.page) return
    state.page = nextPage
    state.selectedMediaIds.clear()
    renderMediaGrid()
  }

  const first = document.createElement('button')
  first.textContent = '<<'
  first.title = 'First page'
  first.disabled = state.page <= 1
  first.addEventListener('click', () => goToPage(1))

  const prev = document.createElement('button')
  prev.textContent = '<'
  prev.title = 'Previous page'
  prev.disabled = state.page <= 1
  prev.addEventListener('click', () => goToPage(state.page - 1))

  const next = document.createElement('button')
  next.textContent = '>'
  next.title = 'Next page'
  next.disabled = state.page >= totalPages
  next.addEventListener('click', () => goToPage(state.page + 1))

  const last = document.createElement('button')
  last.textContent = '>>'
  last.title = 'Last page'
  last.disabled = state.page >= totalPages
  last.addEventListener('click', () => goToPage(totalPages))

  const info = document.createElement('span')
  info.className = 'page-jump'
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.max = String(totalPages)
  input.value = String(state.page)
  input.setAttribute('aria-label', 'Page number')
  input.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      goToPage(input.value)
    }
  })
  input.addEventListener('blur', () => {
    input.value = String(Math.min(totalPages, Math.max(1, Number(input.value) || state.page)))
    goToPage(input.value)
  })
  const total = document.createElement('span')
  total.textContent = `/ ${totalPages}`
  info.appendChild(input)
  info.appendChild(total)

  pager.appendChild(first)
  pager.appendChild(prev)
  pager.appendChild(info)
  pager.appendChild(next)
  pager.appendChild(last)
}

function getCurrentPageItems() {
  const items = getFilteredItems()
  const start = (state.page - 1) * state.pageSize
  return items.slice(start, start + state.pageSize)
}

function selectVisibleItems() {
  getCurrentPageItems().forEach(item => state.selectedMediaIds.add(String(item.id)))
  renderMediaGrid()
}

function clearSelection() {
  state.selectedMediaIds.clear()
  renderMediaGrid()
}

function updateBulkToolbar(pageItems = getCurrentPageItems()) {
  const visibleSelected = pageItems.filter(item => state.selectedMediaIds.has(String(item.id))).length
  const totalSelected = state.selectedMediaIds.size
  $('#selected-count').textContent = `${totalSelected} selected`
  $('#select-visible').disabled = !pageItems.length || visibleSelected === pageItems.length
  $('#clear-selection').disabled = totalSelected === 0
  $('#bulk-change-category').disabled = totalSelected === 0
  $('#bulk-delete').disabled = totalSelected === 0
}

async function resolveCategoryFromSelect(select) {
  let category = select.value
  if (category === '__new__' || !category) {
    category = prompt('New category name')
    if (!category) return null
    category = category.trim()
  }
  return category || null
}

async function bulkChangeCategory() {
  const ids = Array.from(state.selectedMediaIds)
  if (!ids.length) return

  const category = await resolveCategoryFromSelect($('#bulk-category'))
  if (!category) return

  state.metadata.media.forEach(item => {
    if (ids.includes(String(item.id))) item.category = category
  })
  state.selectedMediaIds.clear()
  state.currentCategory = category
  state.page = 1
  window.api.writeMetadata(state.metadata)
  renderCategories()
  renderMediaGrid()
}

async function bulkDeleteSelected() {
  const ids = Array.from(state.selectedMediaIds)
  if (!ids.length) return

  const hasExternal = ids.some(id => {
    const item = findMediaById(id)
    return item && item.external
  })
  const msg = hasExternal
    ? `Remove ${ids.length} items from the library? Files imported "without moving" stay in place.`
    : `Delete ${ids.length} selected files and their library records?`
  const ok = confirm(msg)
  if (!ok) return

  for (const id of ids) {
    const result = await window.api.deleteMedia(id)
    if (result && result.error) return alert('Error: ' + result.error)
  }

  state.selectedMediaIds.clear()
  state.metadata = await window.api.readMetadata()
  renderCategories()
  renderTags()
  renderMediaGrid()
}

function updateSummary(visibleCount) {
  const modeItems = getModeItems()
  const privateSet = new Set(state.metadata.privateCategories || [])
  const publicItems = modeItems.filter(item => !privateSet.has(item.category || 'No category'))
  $('#total-count').textContent = publicItems.length
  $('#visible-count').textContent = visibleCount
  $('#favorite-count').textContent = publicItems.filter(item => item.favorite).length
}

function openViewer(item) {
  stopViewerMedia()
  state.viewerId = item.id
  state.viewerFillFullscreen = false
  $('#viewer').classList.remove('viewer-fill')
  $('#viewer').classList.toggle('viewer-comic', item.type === 'comic')
  const body = $('#viewer-body')
  body.innerHTML = ''
  $('#comic-viewer-tools').classList.toggle('hidden', item.type !== 'comic')

  if (item.type === 'photo') {
    const img = document.createElement('img')
    img.src = mediaSrc(item.path)
    img.alt = item.name || 'Photo'
    bindViewerSwipe(img)
    body.appendChild(img)
  } else if (item.type === 'comic') {
    const comic = document.createElement('div')
    comic.className = 'comic-reader'
    comic.style.setProperty('--comic-zoom', `${state.comicZoom}%`)
    ;(item.pages || []).forEach((page, index) => {
      const img = document.createElement('img')
      img.src = mediaSrc(page)
      img.alt = `${item.name || 'Comic'} ${index + 1}`
      comic.appendChild(img)
    })
    body.appendChild(comic)
  } else {
    const video = document.createElement('video')
    video.src = mediaSrc(item.path)
    video.controls = true
    video.autoplay = true
    body.appendChild(video)
    setupVideoViewer(video, item)
  }

  const current = findMediaById(item.id) || item
  body.appendChild(renderViewerMeta(current))
  $('#viewer').classList.remove('hidden')
}

// Saves the video playback position to disk at most once every 5 seconds so
// reopening the video can offer to resume from where we left off.
function setupVideoViewer(video, item) {
  let lastSavedPosition = -1
  const SAVE_INTERVAL = 5 // seconds between position saves

  // "Watched" checkbox, shown over the video (top-left) so the user can mark
  // the video as watched/unwatched without leaving the viewer.
  addVideoWatchedControl(video, item)

  // Persist the position every 5s of playback (not wall-clock), and on pause.
  const maybeSavePosition = () => {
    const t = Number(video.currentTime) || 0
    if (Math.abs(t - lastSavedPosition) < SAVE_INTERVAL) return
    lastSavedPosition = t
    const target = findMediaById(item.id)
    if (target) target.position = t
    if (window.api.updateMedia) {
      window.api.updateMedia({ id: item.id, position: t }).catch(() => {})
    }
  }

  video.addEventListener('timeupdate', maybeSavePosition)
  video.addEventListener('pause', maybeSavePosition)

  // Mark as watched when playback reaches the end.
  video.addEventListener('ended', () => {
    const target = findMediaById(item.id)
    if (target && !target.watched) {
      target.watched = true
      target.position = 0
      if (window.api.updateMedia) {
        window.api.updateMedia({ id: item.id, watched: true, position: 0 }).catch(() => {})
      }
      // Reflect the green check on the grid without closing the viewer.
      renderMediaGrid()
    }
  })

  // "Resume from last position" overlay: shown for 5s if a saved position
  // exists and is far enough from the start to be worth resuming.
  const savedPosition = Number(findMediaById(item.id)?.position) || 0
  if (savedPosition >= 5) {
    showVideoResumeOverlay(video, item, savedPosition)
  }
}

function addVideoWatchedControl(video, item) {
  const body = $('#viewer-body')
  const wrap = document.createElement('label')
  wrap.className = 'video-watched-toggle'

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = !!(findMediaById(item.id)?.watched)
  cb.addEventListener('change', () => {
    const target = findMediaById(item.id)
    if (!target) return
    target.watched = cb.checked
    // Reset the saved position when marking as watched.
    if (cb.checked) target.position = 0
    if (window.api.updateMedia) {
      window.api.updateMedia({
        id: item.id,
        watched: cb.checked,
        position: cb.checked ? 0 : (target.position || 0)
      }).catch(() => {})
    }
    renderMediaGrid()
  })

  const span = document.createElement('span')
  span.textContent = 'просмотрено'

  wrap.appendChild(cb)
  wrap.appendChild(span)
  body.appendChild(wrap)

  // Keep clicks/keys on the checkbox from bubbling to the viewer.
  ;['click', 'mousedown', 'keydown', 'keyup'].forEach(type => {
    wrap.addEventListener(type, event => event.stopPropagation())
  })
}

function showVideoResumeOverlay(video, item, position) {
  const body = $('#viewer-body')
  const overlay = document.createElement('div')
  overlay.className = 'video-resume-overlay'

  const label = document.createElement('span')
  label.className = 'video-resume-label'
  label.textContent = `Продолжить с ${formatDuration(position)}?`

  const resumeBtn = document.createElement('button')
  resumeBtn.type = 'button'
  resumeBtn.className = 'video-resume-button'
  resumeBtn.textContent = 'Продолжить'
  resumeBtn.addEventListener('click', event => {
    event.stopPropagation()
    try { video.currentTime = position } catch (e) {}
    video.play?.().catch(() => {})
    overlay.remove()
  })

  overlay.appendChild(label)
  overlay.appendChild(resumeBtn)
  body.appendChild(overlay)

  // Stop clicks on the overlay from bubbling to the viewer (which would close it).
  overlay.addEventListener('click', event => event.stopPropagation())
  overlay.addEventListener('mousedown', event => event.stopPropagation())

  // Auto-hide after 5 seconds.
  const hideTimer = setTimeout(() => overlay.remove(), 5000)
  // Also hide as soon as the user seeks manually.
  video.addEventListener('seeked', () => {
    clearTimeout(hideTimer)
    overlay.remove()
  }, { once: true })
}

// Renders the metadata block under the viewer. The Tags and Description rows
// are clickable: clicking turns the row into an inline editor so tags and the
// description can be changed without leaving the viewer.
function renderViewerMeta(current) {
  const meta = document.createElement('div')
  meta.className = 'viewer-meta'

  const categoryRow = document.createElement('div')
  categoryRow.textContent = `Category: ${current.category || 'No category'}`
  meta.appendChild(categoryRow)

  meta.appendChild(buildViewerTagSelector({
    item: current,
    editTitle: 'Нажмите, чтобы изменить теги'
  }))

  meta.appendChild(buildViewerMetaRow({
    label: 'Description',
    value: current.description || '',
    placeholder: 'none',
    multiline: true,
    editTitle: 'Нажмите, чтобы изменить описание',
    onCommit: text => commitViewerField(current, { description: text }),
    render: text => text || 'none'
  }))

  return meta
}

function buildViewerMetaRow({ label, value, placeholder, multiline, editTitle, onCommit, render, onChange }) {
  const row = document.createElement('div')
  row.className = 'viewer-meta-row'
  row.title = editTitle

  const labelEl = document.createElement('span')
  labelEl.className = 'viewer-meta-label'
  labelEl.textContent = `${label}:`
  row.appendChild(labelEl)

  const valueEl = document.createElement('span')
  valueEl.className = 'viewer-meta-value'
  valueEl.textContent = render(value) || placeholder
  row.appendChild(valueEl)

  // Keep a mutable copy so re-opening the editor reflects the last saved value.
  let currentValue = value

  row.addEventListener('click', () => {
    if (row.classList.contains('editing')) return
    startViewerMetaEdit(row, valueEl, currentValue, multiline, async text => {
      const result = await onCommit(text)
      if (result === false) return false
      currentValue = text
      if (onChange) onChange()
      valueEl.textContent = render(text) || placeholder
      return true
    })
  })

  return row
}

function buildViewerTagSelector({ item, editTitle }) {
  const row = document.createElement('div')
  row.className = 'viewer-meta-row viewer-tag-selector'
  row.title = editTitle

  const labelEl = document.createElement('span')
  labelEl.className = 'viewer-meta-label'
  labelEl.textContent = 'Tags:'
  row.appendChild(labelEl)

  const valueEl = document.createElement('span')
  valueEl.className = 'viewer-meta-value'
  valueEl.textContent = (item.tags || []).join(', ') || 'none'
  row.appendChild(valueEl)

  // Mutable working copy of tags so we can toggle without saving immediately
  let workingTags = [...(item.tags || [])]

  row.addEventListener('click', () => {
    if (row.classList.contains('editing')) return
    openViewerTagEditor(row, valueEl, workingTags, item, async (newTags) => {
      workingTags = newTags
      valueEl.textContent = newTags.join(', ') || 'none'
      renderTags()
      renderMediaGrid()
      return true
    })
  })

  return row
}

function openViewerTagEditor(row, valueEl, initialTags, item, onDone) {
  row.classList.add('editing')
  valueEl.classList.add('hidden')

  const wrap = document.createElement('div')
  wrap.className = 'viewer-tag-editor'

  // Tag search input
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = 'Поиск тега...'
  searchInput.className = 'viewer-meta-input viewer-tag-search'

  const list = document.createElement('div')
  list.className = 'viewer-tag-list'

  // Merge all known tags with current item tags
  const allTags = Array.from(new Set([...state.metadata.tags, ...initialTags]))
    .sort((a, b) => a.localeCompare(b))

  let selected = [...initialTags]

  function renderCheckboxes() {
    list.innerHTML = ''
    const query = (searchInput.value || '').trim().toLowerCase()
    const filtered = query
      ? allTags.filter(tag => tag.toLowerCase().includes(query))
      : allTags
    filtered.forEach(tag => {
      const label = document.createElement('label')
      label.className = 'tag-option'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = tag
      cb.checked = selected.includes(tag)
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!selected.includes(tag)) selected.push(tag)
        } else {
          selected = selected.filter(t => t !== tag)
        }
      })
      const span = document.createElement('span')
      span.textContent = tag
      label.appendChild(cb)
      label.appendChild(span)
      list.appendChild(label)
    })
  }

  searchInput.addEventListener('input', renderCheckboxes)

  renderCheckboxes()

  const addRow = document.createElement('div')
  addRow.className = 'viewer-tag-add'
  const addInput = document.createElement('input')
  addInput.type = 'text'
  addInput.placeholder = 'Новый тег'
  addInput.className = 'viewer-meta-input'
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'secondary-button'
  addBtn.textContent = '+'
  addBtn.addEventListener('click', () => {
    const val = addInput.value.trim()
    if (!val) return
    if (!allTags.includes(val)) {
      allTags.push(val)
      allTags.sort((a, b) => a.localeCompare(b))
    }
    if (!selected.includes(val)) selected.push(val)
    addInput.value = ''
    renderCheckboxes()
  })
  addInput.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      addBtn.click()
    }
  })

  // Stop propagation so viewer keyboard shortcuts don't fire
  ;['click', 'mousedown', 'keydown', 'keyup'].forEach(type => {
    wrap.addEventListener(type, event => event.stopPropagation())
  })

  addRow.appendChild(addInput)
  addRow.appendChild(addBtn)
  wrap.appendChild(searchInput)
  wrap.appendChild(list)
  wrap.appendChild(addRow)

  const actions = document.createElement('div')
  actions.className = 'viewer-meta-actions'

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'secondary-button'
  save.textContent = 'Сохранить'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'secondary-button'
  cancel.textContent = 'Отмена'

  let finished = false
  const finish = async (apply) => {
    if (finished) return
    finished = true
    if (apply) {
      save.disabled = true
      cancel.disabled = true
      const ok = await commitViewerField(item, { tags: selected })
      if (ok === false) {
        finished = false
        save.disabled = false
        cancel.disabled = false
        return
      }
      await onDone(selected)
    }
    row.classList.remove('editing')
    valueEl.classList.remove('hidden')
    wrap.replaceWith(valueEl)
    actions.remove()
  }

  save.addEventListener('click', () => finish(true))
  cancel.addEventListener('click', () => finish(false))

  // Escape to cancel
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape' && !finished) {
      e.preventDefault()
      e.stopPropagation()
      document.removeEventListener('keydown', escHandler)
      finish(false)
    }
  })

  valueEl.replaceWith(wrap)
  addInput.focus()
  row.appendChild(actions)
  actions.appendChild(save)
  actions.appendChild(cancel)
}

function startViewerMetaEdit(row, valueEl, initialValue, multiline, commit) {
  row.classList.add('editing')
  valueEl.classList.add('hidden')

  const input = document.createElement(multiline ? 'textarea' : 'input')
  if (!multiline) input.type = 'text'
  input.className = 'viewer-meta-input'
  input.value = initialValue
  if (multiline) input.rows = 3

  const actions = document.createElement('div')
  actions.className = 'viewer-meta-actions'

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'secondary-button'
  save.textContent = 'Сохранить'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'secondary-button'
  cancel.textContent = 'Отмена'

  let finished = false
  const finish = async apply => {
    if (finished) return
    finished = true
    if (apply) {
      const text = input.value
      save.disabled = true
      cancel.disabled = true
      const ok = await commit(text)
      if (ok === false) {
        finished = false
        save.disabled = false
        cancel.disabled = false
        return
      }
    }
    row.classList.remove('editing')
    valueEl.classList.remove('hidden')
    input.replaceWith(valueEl)
    actions.remove()
  }

  save.addEventListener('click', () => finish(true))
  cancel.addEventListener('click', () => finish(false))
  if (!multiline) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
  } else {
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
  }
  // Keep keyboard viewer navigation (arrows / F) from firing while editing.
  ;['click', 'mousedown', 'keydown', 'keyup'].forEach(type => {
    input.addEventListener(type, event => event.stopPropagation())
  })

  valueEl.replaceWith(input)
  input.focus()
  if (multiline) {
    input.setSelectionRange(input.value.length, input.value.length)
  } else {
    input.select()
  }
  row.appendChild(actions)
  actions.appendChild(save)
  actions.appendChild(cancel)
}

async function commitViewerField(item, changes) {
  const target = findMediaById(item.id)
  if (!target) return false

  if (Array.isArray(changes.tags)) {
    target.tags = changes.tags
    changes.tags.forEach(tag => {
      if (!state.metadata.tags.includes(tag)) state.metadata.tags.push(tag)
    })
  }
  if (typeof changes.description === 'string') {
    target.description = changes.description
  }

  try {
    if (window.api.updateMedia) {
      const result = await window.api.updateMedia({
        id: target.id,
        tags: target.tags,
        description: target.description
      })
      if (result && result.error) {
        alert('Ошибка: ' + result.error)
        return false
      }
      if (isWebMode()) await refreshMetadataFromDisk()
    } else {
      window.api.writeMetadata(state.metadata)
    }
    return true
  } catch (e) {
    alert('Ошибка: ' + e.message)
    return false
  }
}

function closeViewer() {
  stopViewerMedia()
  state.viewerId = null
  state.viewerFillFullscreen = false
  $('#comic-viewer-tools').classList.add('hidden')
  $('#viewer').classList.remove('viewer-fill')
  $('#viewer').classList.remove('viewer-comic')
  $('#viewer').classList.add('hidden')
  $('#viewer-body').innerHTML = ''
}

function stopViewerMedia() {
  $('#viewer-body').querySelectorAll('video, audio').forEach(media => {
    media.pause()
    media.removeAttribute('src')
    media.load()
  })
}

function handleViewerKeys(event) {
  if ($('#viewer').classList.contains('hidden')) return
  // Don't interfere with text editing inside the viewer (description, tags, etc.)
  const tag = event.target.tagName ? event.target.tagName.toLowerCase() : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return
  const key = event.key ? event.key.toLowerCase() : ''
  if (key === 'f' || key === 'а') {
    const current = findMediaById(state.viewerId)
    if (current && (current.type === 'photo' || current.type === 'video' || current.type === 'comic')) {
      event.preventDefault()
      toggleViewerFullscreen(true)
    }
    return
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

  const current = findMediaById(state.viewerId)
  if (!current || current.type !== 'photo') return

  const photos = getFilteredItems().filter(item => item.type === 'photo')
  if (photos.length < 2) return

  const currentIndex = photos.findIndex(item => String(item.id) === String(current.id))
  if (currentIndex === -1) return

  event.preventDefault()
  const direction = event.key === 'ArrowRight' ? 1 : -1
  openPhotoInDirection(direction, current, photos, currentIndex)
}

function openPhotoInDirection(direction, current = null, photos = null, currentIndex = -1) {
  const active = current || findMediaById(state.viewerId)
  if (!active || active.type !== 'photo') return false

  const photoItems = photos || getFilteredItems().filter(item => item.type === 'photo')
  if (photoItems.length < 2) return false

  const activeIndex = currentIndex >= 0
    ? currentIndex
    : photoItems.findIndex(item => String(item.id) === String(active.id))
  if (activeIndex === -1) return false

  const nextIndex = (activeIndex + direction + photoItems.length) % photoItems.length
  openViewer(photoItems[nextIndex])
  return true
}

function bindViewerSwipe(img) {
  if (!isMobileCastMode()) return

  img.classList.add('viewer-swipe-target')
  img.addEventListener('touchstart', handleViewerSwipeStart, { passive: true })
  img.addEventListener('touchmove', handleViewerSwipeMove, { passive: true })
  img.addEventListener('touchend', handleViewerSwipeEnd)
  img.addEventListener('touchcancel', resetViewerSwipe, { passive: true })
}

function isMobileCastMode() {
  return location.protocol !== 'file:' && window.matchMedia?.('(pointer: coarse)').matches
}

function handleViewerSwipeStart(event) {
  if (!isMobileCastMode() || event.touches.length !== 1) {
    resetViewerSwipe()
    return
  }

  viewerSwipe.startX = event.touches[0].clientX
  viewerSwipe.startY = event.touches[0].clientY
  viewerSwipe.active = true
}

function handleViewerSwipeMove(event) {
  if (!viewerSwipe.active || event.touches.length !== 1) resetViewerSwipe()
}

function handleViewerSwipeEnd(event) {
  if (!viewerSwipe.active || !isMobileCastMode()) {
    resetViewerSwipe()
    return
  }

  const touch = event.changedTouches[0]
  const deltaX = touch.clientX - viewerSwipe.startX
  const deltaY = touch.clientY - viewerSwipe.startY
  const threshold = Math.max(56, Math.min(120, window.innerWidth * 0.16))
  resetViewerSwipe()

  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return

  event.preventDefault()
  openPhotoInDirection(deltaX < 0 ? 1 : -1)
}

function resetViewerSwipe() {
  viewerSwipe.active = false
}

function toggleViewerFullscreen(fill = false) {
  const viewer = $('#viewer')
  const wasFill = viewer.classList.contains('viewer-fill')
  state.viewerFillFullscreen = fill
  viewer.classList.toggle('viewer-fill', fill)
  if (!document.fullscreenElement) {
    viewer.requestFullscreen?.()
  } else {
    if (fill && !wasFill) viewer.classList.add('viewer-fill')
    else document.exitFullscreen?.()
  }
}

function setComicZoom(value) {
  const next = Math.min(180, Math.max(50, Number(value) || 100))
  state.comicZoom = next
  $('#comic-zoom').value = String(next)
  $('#comic-zoom-value').textContent = `${next}%`
  const reader = document.querySelector('.comic-reader')
  if (reader) reader.style.setProperty('--comic-zoom', `${next}%`)
}

async function toggleFavorite(id) {
  const item = findMediaById(id)
  if (!item) return
  item.favorite = !item.favorite
  // Persist atomically through the main process so the flag survives even when
  // another renderer write (e.g. duration lookup) rewrites the whole file
  // around the same time. Falls back to a full metadata write in browser mode.
  if (window.api.toggleFavorite) {
    const result = await window.api.toggleFavorite(id, item.favorite)
    if (result && result.error) {
      // rollback the optimistic UI change on failure
      item.favorite = !item.favorite
    } else if (isWebMode()) {
      // Keep the in-memory copy in sync with what landed on disk (other devices
      // may have changed the file concurrently), without losing the optimistic
      // UI update we just applied.
      refreshMetadataFromDisk()
    }
  } else {
    window.api.writeMetadata(state.metadata)
  }
  renderMediaGrid()
}

function toggleFavoriteFilter() {
  state.favoriteOnly = !state.favoriteOnly
  state.page = 1
  state.selectedMediaIds.clear()
  renderMediaGrid()
}

function editMetadata(id) {
  const item = findMediaById(id)
  if (!item) {
    alert('Cannot find this file in the library')
    return
  }

  state.editingId = item.id
  state.editSelectedTags = [...(item.tags || [])]
  $('#edit-name').value = item.name || ''
  updateCategorySelect($('#edit-category'), item.category || '')
  renderEditTags()
  $('#edit-new-tag').value = ''
  $('#edit-description').value = item.description || ''
  renderEditThumbnail(item)
  renderEditComicPages(item)
  $('#edit-modal').classList.remove('hidden')
  $('#edit-name').focus()
}

function renderEditThumbnail(item) {
  const section = $('#edit-video-thumbnail')
  if (!section) return
  const isVideo = item && item.type === 'video'
  section.classList.toggle('hidden', !isVideo)
  if (!isVideo) return

  const img = $('#edit-thumbnail-img')
  if (item.thumbnail) {
    img.src = mediaSrc(item.thumbnail, true)
    img.classList.remove('hidden')
  } else {
    img.removeAttribute('src')
    img.classList.add('hidden')
  }
}

function renderEditComicPages(item) {
  const section = $('#edit-comic-pages')
  const list = $('#edit-comic-pages-list')
  if (!section || !list) return

  const isComic = item && item.type === 'comic'
  section.classList.toggle('hidden', !isComic)
  list.innerHTML = ''
  if (!isComic) return

  ;(item.pages || []).forEach((page, index) => {
    const row = document.createElement('div')
    row.className = 'comic-page-edit'

    const img = document.createElement('img')
    img.src = mediaSrc(page, true)
    img.alt = `Page ${index + 1}`

    const meta = document.createElement('div')
    meta.className = 'comic-page-edit-meta'
    const title = document.createElement('strong')
    title.textContent = `Page ${index + 1}`
    const name = document.createElement('span')
    name.textContent = getFileName(page)
    meta.appendChild(title)
    meta.appendChild(name)

    const del = document.createElement('button')
    del.className = 'danger-button'
    del.type = 'button'
    del.textContent = 'Delete'
    del.addEventListener('click', () => removeComicPage(item.id, page))

    row.appendChild(img)
    row.appendChild(meta)
    row.appendChild(del)
    list.appendChild(row)
  })
}

async function removeComicPage(comicId, pagePath) {
  const item = findMediaById(comicId)
  if (!item || item.type !== 'comic') return
  if ((item.pages || []).length <= 1) return alert('Comic must have at least one page')
  const ok = confirm(`Delete this page from "${item.name}"?`)
  if (!ok) return

  const result = await window.api.removeComicPage(comicId, pagePath)
  if (!result || result.error) return alert('Error: ' + (result?.error || 'Cannot delete page'))

  const index = state.metadata.media.findIndex(media => String(media.id) === String(comicId))
  if (index !== -1) state.metadata.media[index] = result.item
  renderEditComicPages(result.item)
  renderMediaGrid()
}

function renderEditTags() {
  const wrap = $('#edit-tags')
  if (!wrap) return
  wrap.innerHTML = ''
  const summary = $('#edit-tags-summary')
  if (summary) {
    summary.textContent = state.editSelectedTags.length
      ? `${state.editSelectedTags.length} selected`
      : 'Select tags'
  }

  const tagList = Array.from(new Set([...state.metadata.tags, ...state.editSelectedTags]))
    .sort((a, b) => a.localeCompare(b))
  tagList.forEach(tag => {
    const label = document.createElement('label')
    label.className = 'tag-option'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = tag
    checkbox.checked = state.editSelectedTags.includes(tag)
    checkbox.addEventListener('change', event => {
      if (event.target.checked) {
        if (!state.editSelectedTags.includes(tag)) state.editSelectedTags.push(tag)
      } else {
        state.editSelectedTags = state.editSelectedTags.filter(item => item !== tag)
      }
      renderEditTags()
    })
    const span = document.createElement('span')
    span.textContent = tag
    label.appendChild(checkbox)
    label.appendChild(span)
    wrap.appendChild(label)
  })
}

function addEditTag() {
  const input = $('#edit-new-tag')
  const value = input.value.trim()
  if (!value) return
  if (!state.metadata.tags.includes(value)) state.metadata.tags.push(value)
  if (!state.editSelectedTags.includes(value)) state.editSelectedTags.push(value)
  input.value = ''
  renderEditTags()
}

// Re-read metadata from disk (web mode) and refresh the UI without resetting
// the current navigation (category/tag/page selection). Used after server-side
// mutations so the local copy reflects the canonical state on disk.
async function refreshMetadataFromDisk() {
  if (!isWebMode()) return
  try {
    const fresh = await window.api.readMetadata()
    state.metadata = fresh
    renderTags()
    renderCategories()
    renderMediaGrid()
  } catch (e) {
    // Silent: the optimistic UI change already happened, a refresh failure is
    // non-fatal and the next manual reload will recover.
  }
}

async function saveEditForm(event) {
  event.preventDefault()

  const item = findMediaById(state.editingId)
  if (!item) {
    closeEditModal()
    return
  }

  const name = $('#edit-name').value.trim()
  const category = await resolveCategoryFromSelect($('#edit-category'))
  if (!category) return
  const tags = state.editSelectedTags.map(tag => tag.trim()).filter(Boolean)
  const description = $('#edit-description').value.trim()

  // Apply the change to the in-memory item so the UI updates immediately.
  if (name) item.name = name
  if (category) item.category = category
  item.tags = tags
  item.description = description

  tags.forEach(tag => {
    if (!state.metadata.tags.includes(tag)) state.metadata.tags.push(tag)
  })

  if (isWebMode() && window.api.updateMedia) {
    // Atomic per-item update avoids clobbering concurrent writes from other
    // devices with a stale full-file snapshot.
    const result = await window.api.updateMedia({
      id: item.id,
      name: item.name,
      category: item.category,
      tags: item.tags,
      description: item.description
    })
    if (result && result.error) return alert('Ошибка: ' + result.error)
    await refreshMetadataFromDisk()
  } else {
    window.api.writeMetadata(state.metadata)
  }

  closeEditModal()
  renderTags()
  renderCategories()
  renderMediaGrid()
}

async function changeVideoThumbnail() {
  const item = findMediaById(state.editingId)
  if (!item || item.type !== 'video') return

  const button = $('#edit-thumbnail-change')
  button.disabled = true
  try {
    const result = await window.api.selectVideoThumbnail(item.path)
    await applyVideoThumbnailResult(item, result)
  } finally {
    button.disabled = false
  }
}

async function pasteVideoThumbnail() {
  const item = findMediaById(state.editingId)
  if (!item || item.type !== 'video') return

  const button = $('#edit-thumbnail-paste')
  button.disabled = true
  try {
    const result = await window.api.pasteVideoThumbnail(item.path)
    await applyVideoThumbnailResult(item, result)
  } finally {
    button.disabled = false
  }
}

async function applyVideoThumbnailResult(item, result) {
  if (!result) return
  if (result.error) return alert('Error: ' + result.error)

  item.thumbnail = result.thumbnail
  await window.api.writeMetadata(state.metadata)
  renderEditThumbnail(item)
  renderMediaGrid()
}

function closeEditModal() {
  state.editingId = null
  state.editSelectedTags = []
  $('#edit-comic-pages').classList.add('hidden')
  $('#edit-modal').classList.add('hidden')
}

async function deleteMedia(id) {
  const item = findMediaById(id)
  const msg = item && item.external
    ? 'Remove from library? The original file will stay in place.'
    : 'Delete this file and its library record?'
  const ok = confirm(msg)
  if (!ok) return

  const result = await window.api.deleteMedia(id)
  if (result && result.error) return alert('Error: ' + result.error)

  state.selectedMediaIds.delete(String(id))
  state.metadata = await window.api.readMetadata()
  renderCategories()
  renderTags()
  renderMediaGrid()
}

function getFileName(path) {
  return String(path || '').split(/[\\/]/).pop()
}

// True when running in the cast/web view (served over HTTP from another device
// or opened from a browser) rather than the Electron desktop app. Determines
// whether atomic server endpoints should be preferred over full-file writes.
function isWebMode() {
  return location.protocol !== 'file:'
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

window.addEventListener('DOMContentLoaded', init)
