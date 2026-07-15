const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const https = require('https')
const os = require('os')
const ffmpegPath = require('ffmpeg-static')
const sharp = require('sharp')

const APP_ROOT = path.join(__dirname, 'programm')
const DATA_ROOT = path.join(APP_ROOT, 'data')
const USER_DATA_ROOT = path.join(APP_ROOT, 'electron-user-data')
const CAST_PORT = 17877
let castServer = null
let castServerPort = null
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']

if (!fs.existsSync(APP_ROOT)) fs.mkdirSync(APP_ROOT)
if (!fs.existsSync(USER_DATA_ROOT)) fs.mkdirSync(USER_DATA_ROOT, { recursive: true })

app.setPath('userData', USER_DATA_ROOT)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')

function createWindow () {
  const win = new BrowserWindow({
    title: 'Media Library',
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#eef2f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (castServer) castServer.close()
})

function ensureDirs() {
  if (!fs.existsSync(APP_ROOT)) fs.mkdirSync(APP_ROOT)
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT)
  const photos = path.join(DATA_ROOT, 'photos')
  const videos = path.join(DATA_ROOT, 'videos')
  const comics = path.join(DATA_ROOT, 'comics')
  if (!fs.existsSync(photos)) fs.mkdirSync(photos)
  if (!fs.existsSync(videos)) fs.mkdirSync(videos)
  if (!fs.existsSync(comics)) fs.mkdirSync(comics)
  const metadata = path.join(APP_ROOT, 'metadata.json')
  if (!fs.existsSync(metadata)) fs.writeFileSync(metadata, JSON.stringify({media:[], tags:[]}, null, 2))
}

ensureDirs()

function ensureThumbsDir(mediaType){
  const folder = mediaType === 'photo' ? 'photos' : mediaType === 'comic' ? 'comics' : 'videos'
  const thumbs = path.join(APP_ROOT, 'data', folder, 'thumbnails')
  if (!fs.existsSync(thumbs)) fs.mkdirSync(thumbs, { recursive: true })
  return thumbs
}

function isSupportedMediaFile(filePath, mediaType) {
  const ext = path.extname(filePath).toLowerCase()
  const videoExts = ['.mp4','.mov','.webm','.mkv','.avi']
  if (mediaType === 'photo') return IMAGE_EXTS.includes(ext)
  if (mediaType === 'video') return videoExts.includes(ext)
  return false
}

function isSupportedImageFile(filePath) {
  return IMAGE_EXTS.includes(path.extname(filePath || '').toLowerCase())
}

function listSupportedFiles(srcFolder, mediaType) {
  const entries = fs.readdirSync(srcFolder)
  const files = []
  for (const name of entries) {
    const src = path.join(srcFolder, name)
    const stat = fs.statSync(src)
    if (stat.isFile() && isSupportedMediaFile(src, mediaType)) files.push(src)
  }
  return files
}

function normalizeMetadata(data){
  let changed = false
  if (!data || typeof data !== 'object') { data = { media: [], tags: [] }; changed = true }
  if (!Array.isArray(data.media)) { data.media = []; changed = true }
  if (!Array.isArray(data.tags)) { data.tags = []; changed = true }
  if (!Array.isArray(data.privateCategories)) { data.privateCategories = []; changed = true }
  const seenIds = new Set()
  for (let i=0;i<data.media.length;i++){
    const m = data.media[i]
    if (!m || typeof m !== 'object') { data.media[i] = m = {}; changed = true }
    if (!m.id) { m.id = Date.now() + Math.floor(Math.random()*1000); changed = true }
    if (seenIds.has(String(m.id))) { m.id = Date.now() + Math.floor(Math.random()*1000); changed = true }
    seenIds.add(String(m.id))
    if (!m.name) { m.name = path.basename(m.path || 'unknown'); changed = true }
    if (!m.path) { m.path = ''; changed = true }
    if (!m.type) { m.type = 'photo'; changed = true }
    if (m.type === 'comic' && !Array.isArray(m.pages)) { m.pages = []; changed = true }
    if (m.type === 'comic' && !m.thumbnail && m.pages && m.pages[0]) { m.thumbnail = m.pages[0]; changed = true }
    if (!m.category) { m.category = 'uncategorized'; changed = true }
    if (!Array.isArray(m.tags)) { m.tags = []; changed = true }
    // Preserve favorites even if stored as a non-boolean (e.g. "true"/1) instead of dropping them
    if (typeof m.favorite !== 'boolean') {
      m.favorite = m.favorite === true || m.favorite === 'true' || m.favorite === 1 || m.favorite === '1'
      changed = true
    }
    if (typeof m.description === 'undefined') { m.description = ''; changed = true }
    if (!m.dateAdded) { m.dateAdded = new Date().toISOString(); changed = true }
  }
  return { data, changed }
}

function slugify(value) {
  const safe = String(value || 'comic')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return safe || `comic-${Date.now()}`
}

function sanitizeFileName(value) {
  return String(value || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file'
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
}

function getAttr(tag, attr) {
  const escaped = String(attr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(tag || '').match(re)
  return match ? decodeHtml((match[1] || match[2] || match[3] || '').trim()) : ''
}

function decodeJsEscapes(value) {
  return String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
}

function cleanImageValue(value) {
  return decodeJsEscapes(decodeHtml(String(value || '').trim()))
    .replace(/^url\((.*)\)$/i, '$1')
    .replace(/^["']|["']$/g, '')
    .trim()
}

function resolveUrl(value, baseUrl) {
  try {
    const cleaned = cleanImageValue(value)
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return null
    return new URL(cleaned, baseUrl).toString()
  } catch (e) {
    return null
  }
}

function isImageUrl(value) {
  return /\.(?:jpe?g|png|webp|gif|bmp)(?:[?#][^\s"'<>]*)?$/i.test(cleanImageValue(value))
}

function extractSrcsetUrls(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function requestBuffer(url, referer) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : http
    const req = client.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': '*/*',
        ...(referer ? { Referer: referer } : {})
      },
      timeout: 30000
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const nextUrl = new URL(res.headers.location, url).toString()
        requestBuffer(nextUrl, referer || url).then(resolve, reject)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || '',
        finalUrl: url
      }))
    })
    req.on('timeout', () => req.destroy(new Error('Request timeout')))
    req.on('error', reject)
  })
}

async function fetchText(url) {
  const result = await requestBuffer(url)
  return result.buffer.toString('utf8')
}

function getImageExt(url, contentType) {
  const clean = String(url || '').split('?')[0].split('#')[0]
  const ext = path.extname(clean).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return ext
  if (/png/i.test(contentType)) return '.png'
  if (/gif/i.test(contentType)) return '.gif'
  if (/webp/i.test(contentType)) return '.webp'
  if (/bmp/i.test(contentType)) return '.bmp'
  return '.jpg'
}

function scoreImageUrl(url) {
  const text = String(url || '').toLowerCase()
  let score = 0
  if (/\.(jpe?g|png|webp|gif|bmp)(\?|#|$)/.test(text)) score += 4
  if (/\/(uploads|images|comics|manga|reader|content|gallery|pages|files)\//.test(text)) score += 5
  if (/(page|comic|manga|chapter|scan|pic|img|image|photo|full|original|large|\d{2,})/.test(text)) score += 2
  if (/(logo|sprite|icon|avatar|banner|button|counter|rating|advert|favicon|social|share|thumb|preview)/.test(text)) score -= 10
  if (/(^|[\/_.-])ads?([\/_.-]|$)/.test(text)) score -= 10
  return score
}

function isLikelyDecorativeImage(url) {
  const text = String(url || '').toLowerCase()
  return /(logo|sprite|icon|avatar|banner|button|counter|rating|advert|favicon|social|share|captcha|loader|spinner|blank|pixel)/.test(text) ||
    /(^|[\/_.-])ads?([\/_.-]|$)/.test(text)
}

function isLikelySameComicLink(href, pageUrl) {
  if (!href) return true
  try {
    const target = new URL(href, pageUrl)
    const source = new URL(pageUrl)
    if (target.href === source.href) return true
    if (target.hash && target.origin === source.origin && target.pathname === source.pathname) return true
    return false
  } catch (e) {
    return true
  }
}

function addUniqueCandidate(candidates, seen, value, pageUrl, index, source, context = '') {
  const url = resolveUrl(value, pageUrl)
  if (!url || seen.has(url)) return
  seen.add(url)

  const contextText = String(context || '').toLowerCase()
  let score = scoreImageUrl(url)
  if (source === 'href-image') score += 5
  if (source === 'img') score += 2
  if (source === 'script') score -= 1
  if (/(reader|read|comic|manga|chapter|page|pages|post-content|entry-content|gallery|content)/.test(contextText)) score += 5
  if (/(related|recommend|similar|thumb|preview|sidebar|footer|header|nav|logo|avatar|ad-|ads|banner)/.test(contextText)) score -= 10

  const width = Number((context.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1])
  const height = Number((context.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1])
  if ((width && width < 220) || (height && height < 220)) score -= 8
  if ((width && width >= 600) || (height && height >= 600)) score += 4

  candidates.push({ url, index, score, source })
}

function listComicPageFiles(srcFolder) {
  const root = path.resolve(srcFolder || '')
  const files = []

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && isSupportedImageFile(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  walk(root)
  return files.sort((a, b) => {
    const relA = path.relative(root, a)
    const relB = path.relative(root, b)
    return relA.localeCompare(relB, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function getPathKey(filePath) {
  const resolved = path.resolve(filePath || '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseComicHtml(html, pageUrl) {
  const text = String(html || '')
  if (isImageUrl(pageUrl)) {
    return {
      title: path.basename(new URL(pageUrl).pathname) || pageUrl,
      tags: [],
      previewUrl: pageUrl,
      pageUrls: [pageUrl]
    }
  }

  const title =
    getAttr((text.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [])[0], 'content') ||
    getAttr((text.match(/<meta[^>]+name=["']title["'][^>]*>/i) || [])[0], 'content') ||
    decodeHtml(((text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim()) ||
    decodeHtml(((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim()) ||
    pageUrl

  const keywords = getAttr((text.match(/<meta[^>]+name=["']keywords["'][^>]*>/i) || [])[0], 'content')
  const tags = new Set()
  keywords.split(',').map(item => item.trim()).filter(Boolean).forEach(item => tags.add(item))
  ;[...text.matchAll(/<a[^>]+rel=["'][^"']*tag[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => decodeHtml(match[1].replace(/<[^>]+>/g, '').trim()))
    .filter(Boolean)
    .forEach(tag => tags.add(tag))

  const imageCandidates = []
  const scriptCandidates = []
  const seenImages = new Set()
  const seenScripts = new Set()
  const addImage = value => {
    addUniqueCandidate(imageCandidates, seenImages, value, pageUrl, imageCandidates.length, 'img', '')
  }
  const ogImage = getAttr((text.match(/<meta[^>]+property=["']og:image["'][^>]*>/i) || [])[0], 'content')
  const previewUrl = resolveUrl(ogImage, pageUrl)
  for (const anchorMatch of text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const href = decodeHtml(anchorMatch[1])
    if (isImageUrl(href)) {
      addUniqueCandidate(imageCandidates, seenImages, href, pageUrl, imageCandidates.length, 'href-image', anchorMatch[0])
      continue
    }
    if (isLikelySameComicLink(href, pageUrl)) continue
    for (const imageMatch of anchorMatch[0].matchAll(/<img\b[^>]*>/gi)) {
      const tag = imageMatch[0]
      ;[
        getAttr(tag, 'data-src'),
        getAttr(tag, 'data-lazy-src'),
        getAttr(tag, 'data-original'),
        getAttr(tag, 'data-full'),
        getAttr(tag, 'data-url'),
        getAttr(tag, 'data-image'),
        getAttr(tag, 'data-file'),
        getAttr(tag, 'src')
      ].forEach(value => addUniqueCandidate(imageCandidates, seenImages, value, pageUrl, imageCandidates.length, 'img', anchorMatch[0]))
      const srcset = getAttr(tag, 'srcset') || getAttr(tag, 'data-srcset')
      if (srcset) {
        extractSrcsetUrls(srcset).forEach(value => addUniqueCandidate(imageCandidates, seenImages, value, pageUrl, imageCandidates.length, 'img', anchorMatch[0]))
      }
    }
  }

  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]
    const contextStart = Math.max(0, match.index - 500)
    const contextEnd = Math.min(text.length, match.index + tag.length + 500)
    const context = text.slice(contextStart, contextEnd)
    ;[
      getAttr(tag, 'data-full'),
      getAttr(tag, 'data-original'),
      getAttr(tag, 'data-src'),
      getAttr(tag, 'data-lazy-src'),
      getAttr(tag, 'data-url'),
      getAttr(tag, 'data-image'),
      getAttr(tag, 'data-file'),
      getAttr(tag, 'data-large-file'),
      getAttr(tag, 'data-medium-file'),
      getAttr(tag, 'data-orig-file'),
      getAttr(tag, 'data-zoom-image'),
      getAttr(tag, 'src')
    ].forEach(value => addUniqueCandidate(imageCandidates, seenImages, value, pageUrl, imageCandidates.length, 'img', context))
    const srcset = getAttr(tag, 'srcset') || getAttr(tag, 'data-srcset')
    if (srcset) {
      extractSrcsetUrls(srcset).forEach(value => addUniqueCandidate(imageCandidates, seenImages, value, pageUrl, imageCandidates.length, 'img', context))
    }
  }
  for (const match of text.matchAll(/["'(]([^"'()<>]+\.(?:jpe?g|png|webp|gif|bmp)(?:\?[^"'()<>]*)?)["')]/gi)) {
    addUniqueCandidate(scriptCandidates, seenScripts, match[1], pageUrl, scriptCandidates.length, 'script', '')
  }
  for (const match of text.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+\.(?:jpe?g|png|webp|gif|bmp)(?:\?[^"'\s<>]*)?/gi)) {
    addUniqueCandidate(scriptCandidates, seenScripts, match[0], pageUrl, scriptCandidates.length, 'script', '')
  }
  for (const match of text.matchAll(/(?:src|url|image|file|full|original|large)["']?\s*:\s*["']([^"']+\.(?:jpe?g|png|webp|gif|bmp)(?:\?[^"']*)?)["']/gi)) {
    addUniqueCandidate(scriptCandidates, seenScripts, match[1], pageUrl, scriptCandidates.length, 'script', '')
  }

  const candidates = imageCandidates
    .map(item => ({ ...item, score: item.score + (item.url === previewUrl ? -10 : 0) }))
    .filter(item => !isLikelyDecorativeImage(item.url))
    .sort((a, b) => a.index - b.index)

  let pages = candidates
    .filter(item => item.score >= 4)
    .map(item => item.url)

  if (pages.length < 4) {
    const fallback = scriptCandidates
      .map(item => ({ ...item, score: item.score + (item.url === previewUrl ? -10 : 0) }))
      .filter(item => !isLikelyDecorativeImage(item.url))
      .filter(item => item.score >= 4)
      .map(item => item.url)
    if (fallback.length > pages.length) pages = fallback
  }
  if (!pages.length && candidates.length) {
    pages = candidates
      .filter(item => item.score >= 0)
      .map(item => item.url)
  }

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    tags: Array.from(tags),
    previewUrl: previewUrl || pages[0] || null,
    pageUrls: pages
  }
}

async function downloadImage(url, destDir, index, referer) {
  const result = await requestBuffer(url, referer)
  const ext = getImageExt(url, result.contentType)
  const out = path.join(destDir, `${String(index).padStart(3, '0')}${ext}`)
  fs.writeFileSync(out, result.buffer)
  return out
}

async function isValidComicPageImage(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size < 25 * 1024) return false
    const meta = await sharp(filePath).metadata()
    const width = Number(meta.width) || 0
    const height = Number(meta.height) || 0
    if (Math.max(width, height) < 700) return false
    if (width * height < 300000) return false
    return true
  } catch (e) {
    return true
  }
}

async function importComicFromUrl(url, category) {
  const html = isImageUrl(url) ? '' : await fetchText(url)
  const parsed = parseComicHtml(html, url)
  const comicDir = path.join(DATA_ROOT, 'comics', `${Date.now()}-${slugify(parsed.title || url)}`)
  fs.mkdirSync(comicDir, { recursive: true })

  const pages = []
  const failed = []
  const uniquePageUrls = Array.from(new Set(parsed.pageUrls))
  for (let i = 0; i < uniquePageUrls.length; i++) {
    try {
      const pagePath = await downloadImage(uniquePageUrls[i], comicDir, i + 1, url)
      if (await isValidComicPageImage(pagePath)) {
        pages.push(pagePath)
      } else {
        try { fs.unlinkSync(pagePath) } catch (e) {}
        failed.push({ url: uniquePageUrls[i], error: 'Skipped small preview image' })
      }
    } catch (e) {
      failed.push({ url: uniquePageUrls[i], error: e.message })
    }
  }

  let thumbnail = pages[0] || null
  if (parsed.previewUrl && !uniquePageUrls.includes(parsed.previewUrl)) {
    try {
      thumbnail = await downloadImage(parsed.previewUrl, comicDir, 0, url)
    } catch (e) {}
  }

  if (!pages.length) {
    try { fs.rmSync(comicDir, { recursive: true, force: true }) } catch (e) {}
    throw new Error('No comic page images found')
  }

  return {
    item: {
      id: Date.now() + Math.random(),
      name: sanitizeFileName(parsed.title || url),
      path: comicDir,
      thumbnail,
      original: url,
      sourceUrl: url,
      type: 'comic',
      category: category || 'Comics',
      tags: parsed.tags,
      favorite: false,
      description: `Источник: ${url}`,
      pages,
      dateAdded: new Date().toISOString()
    },
    failed
  }
}

async function importManualComicFromFolder(options) {
  const contentFolder = options && options.contentFolder
  const previewPath = options && options.previewPath
  const rawTitle = String((options && options.title) || '').trim()
  const title = sanitizeFileName(rawTitle)
  const category = (options && options.category) || 'Comics'

  if (!contentFolder || !fs.existsSync(contentFolder) || !fs.statSync(contentFolder).isDirectory()) {
    throw new Error('Comic content folder not found')
  }
  if (!previewPath || !fs.existsSync(previewPath) || !fs.statSync(previewPath).isFile() || !isSupportedImageFile(previewPath)) {
    throw new Error('Comic preview image not found')
  }
  if (!rawTitle) throw new Error('Comic title is required')

  const pageSources = listComicPageFiles(contentFolder)
  if (!pageSources.length) throw new Error('No supported images found in comic folder')

  const comicDir = path.join(DATA_ROOT, 'comics', `${Date.now()}-${slugify(title)}`)
  fs.mkdirSync(comicDir, { recursive: true })

  try {
    const pages = []
    const sourceToDest = new Map()

    for (let i = 0; i < pageSources.length; i++) {
      const src = pageSources[i]
      const ext = path.extname(src).toLowerCase() || '.jpg'
      const dest = path.join(comicDir, `${String(i + 1).padStart(3, '0')}${ext}`)
      fs.copyFileSync(src, dest)
      pages.push(dest)
      sourceToDest.set(getPathKey(src), dest)
    }

    const previewKey = getPathKey(previewPath)
    let thumbnail = sourceToDest.get(previewKey) || null
    if (!thumbnail) {
      const ext = path.extname(previewPath).toLowerCase() || '.jpg'
      thumbnail = path.join(comicDir, `000-preview${ext}`)
      fs.copyFileSync(previewPath, thumbnail)
    }

    const item = {
      id: Date.now() + Math.random(),
      name: title,
      path: comicDir,
      thumbnail,
      original: contentFolder,
      sourceUrl: '',
      type: 'comic',
      category,
      tags: [],
      favorite: false,
      description: `Источник: ${contentFolder}`,
      pages,
      dateAdded: new Date().toISOString()
    }

    const metaPath = path.join(APP_ROOT, 'metadata.json')
    const data = normalizeMetadata(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).data
    data.media.push(item)
    fs.writeFileSync(metaPath, JSON.stringify(data, null, 2))

    return { item, pages: pages.length }
  } catch (e) {
    try { fs.rmSync(comicDir, { recursive: true, force: true }) } catch (cleanupError) {}
    throw e
  }
}

async function generateThumbnail(filePath, mediaType){
  try{
    const ext = path.extname(filePath).toLowerCase()
    const base = path.basename(filePath, ext)
    const thumbsDir = ensureThumbsDir(mediaType)
    const out = path.join(thumbsDir, base + '.jpg')
    if(mediaType==='video'){
      // extract frame at 2 seconds
      await new Promise((resolve, reject)=>{
        const args = ['-y','-i', filePath, '-ss', '00:00:02', '-vframes', '1', '-q:v', '2', out]
        const p = spawn(ffmpegPath, args)
        p.on('error', reject)
        p.on('close', (code) => { if(code===0) resolve(); else reject(new Error('ffmpeg exit '+code)) })
      })
    } else {
      // image resize
      await sharp(filePath).resize({width:400}).jpeg({quality:70}).toFile(out)
    }
    return out
  }catch(e){
    console.error('thumbnail err', e)
    return null
  }
}

async function getVideoDuration(filePath) {
  try {
    const output = await new Promise((resolve, reject) => {
      let text = ''
      const p = spawn(ffmpegPath, ['-i', filePath])
      p.stderr.on('data', chunk => { text += chunk.toString() })
      p.on('error', reject)
      p.on('close', () => resolve(text))
    })
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (!match) return null

    const hours = Number(match[1])
    const minutes = Number(match[2])
    const seconds = Number(match[3])
    const total = Math.round(hours * 3600 + minutes * 60 + seconds)
    return Number.isFinite(total) && total > 0 ? total : null
  } catch (e) {
    console.error('duration err', e)
    return null
  }
}

async function saveVideoThumbnailFromInput(input, videoPath) {
  const ext = path.extname(videoPath || '').toLowerCase()
  const base = path.basename(videoPath || `video-${Date.now()}`, ext)
  const thumbsDir = ensureThumbsDir('video')
  const out = path.join(thumbsDir, `${base}-custom-${Date.now()}.jpg`)

  await sharp(input)
    .resize({ width: 400, withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toFile(out)

  return out
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'application/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  return 'image/jpeg'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        req.destroy()
        reject(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// Atomic read-modify-write helpers shared by IPC handlers and the web (cast)
// API. Reading the file fresh each time avoids clobbering changes that another
// renderer or device wrote between our read and write.
function readMetadataFromDisk() {
  const p = path.join(APP_ROOT, 'metadata.json')
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
    return normalizeMetadata(obj).data
  } catch (e) {
    const empty = { media: [], tags: [] }
    fs.writeFileSync(p, JSON.stringify(empty, null, 2))
    return empty
  }
}

function writeMetadataToDisk(data) {
  const p = path.join(APP_ROOT, 'metadata.json')
  const normalized = normalizeMetadata(data)
  fs.writeFileSync(p, JSON.stringify(normalized.data, null, 2))
  return normalized.data
}

function findMediaItem(data, id) {
  return data.media.find(m => String(m.id) === String(id))
}

// Remove the on-disk files backing a media item. Metadata is left untouched
// here so callers can splice the record themselves after a successful delete.
function removeMediaFiles(item) {
  if (!item) return
  if (item.type === 'comic') {
    try { if (item.path && fs.existsSync(item.path)) fs.rmSync(item.path, { recursive: true, force: true }) } catch (e) { console.error('rm comic dir', e) }
  } else {
    try { if (item.path && fs.existsSync(item.path)) fs.unlinkSync(item.path) } catch (e) { console.error('rm file', e) }
    try { if (item.thumbnail && fs.existsSync(item.thumbnail)) fs.unlinkSync(item.thumbnail) } catch (e) { console.error('rm thumb', e) }
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function getLocalIpAddresses() {
  const nets = os.networkInterfaces()
  const result = []
  for (const [name, adapterAddresses] of Object.entries(nets)) {
    for (const info of adapterAddresses || []) {
      if (info.family === 'IPv4' && !info.internal) {
        result.push({ name, address: info.address })
      }
    }
  }
  if (!result.length) return ['127.0.0.1']

  const score = item => {
    const name = String(item.name || '').toLowerCase()
    const address = item.address
    let value = 0
    if (/wi-?fi|wireless|wlan|беспровод/.test(name)) value += 50
    if (/ethernet|lan|сеть/.test(name)) value += 20
    if (/virtual|vbox|vmware|hyper-v|tun|tap|vpn|singbox/.test(name)) value -= 40
    if (/^192\.168\.(?!56\.)/.test(address)) value += 30
    if (/^10\./.test(address)) value += 20
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) value += 10
    if (/^169\.254\./.test(address)) value -= 50
    return value
  }

  return Array.from(new Set(
    result
      .sort((a, b) => score(b) - score(a))
      .map(item => item.address)
  ))
}

function getCastUrls() {
  return getLocalIpAddresses().map(address => `http://${address}:${castServerPort}/`)
}

function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(statErr && statErr.code === 'ENOENT' ? 404 : 500)
      res.end(statErr && statErr.code === 'ENOENT' ? 'Not found' : 'Server error')
      return
    }

    const range = req.headers.range
    const contentType = getMimeType(filePath)
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/)
      const start = match && match[1] ? Number(match[1]) : 0
      const end = match && match[2] ? Number(match[2]) : stat.size - 1
      if (!match || start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes'
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

async function handleCastRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = requestUrl.pathname
    const method = (req.method || 'GET').toUpperCase()

    // Allow access from any device on the LAN (the cast server is meant to be
    // reached from phones/tablets on the same network).
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/api/metadata' && method === 'GET') {
      sendJson(res, 200, readMetadataFromDisk())
      return
    }

    // Full metadata replacement (renderer's writeMetadata). Used for bulk
    // edits, tag/category management, etc. Read-modify-write keeps it in sync
    // with concurrent IPC writes from the desktop renderer.
    if (pathname === '/api/metadata' && method === 'POST') {
      const body = await readJsonBody(req)
      const saved = writeMetadataToDisk(body)
      sendJson(res, 200, { ok: true, data: saved })
      return
    }

    // Atomic favorite toggle for a single item.
    if (pathname === '/api/toggle-favorite' && method === 'POST') {
      const body = await readJsonBody(req)
      const data = readMetadataFromDisk()
      const item = findMediaItem(data, body.id)
      if (!item) return sendJson(res, 404, { error: 'not found' })
      item.favorite = !!body.favorite
      writeMetadataToDisk(data)
      sendJson(res, 200, { ok: true, favorite: item.favorite })
      return
    }

    // Update editable fields of a single item: name, category, tags, description.
    if (pathname === '/api/update-media' && method === 'POST') {
      const body = await readJsonBody(req)
      const data = readMetadataFromDisk()
      const item = findMediaItem(data, body.id)
      if (!item) return sendJson(res, 404, { error: 'not found' })
      if (typeof body.name === 'string' && body.name.trim()) item.name = body.name.trim()
      if (typeof body.category === 'string' && body.category.trim()) item.category = body.category.trim()
      if (Array.isArray(body.tags)) item.tags = body.tags.map(tag => String(tag).trim()).filter(Boolean)
      if (typeof body.description === 'string') item.description = body.description
      if (Array.isArray(body.tags)) {
        body.tags.forEach(tag => {
          if (!data.tags.includes(tag)) data.tags.push(tag)
        })
      }
      writeMetadataToDisk(data)
      sendJson(res, 200, { ok: true, data })
      return
    }

    // Delete a single media item and its file(s) from disk.
    if (pathname === '/api/delete-media' && method === 'POST') {
      const body = await readJsonBody(req)
      const data = readMetadataFromDisk()
      const idx = data.media.findIndex(m => String(m.id) === String(body.id))
      if (idx === -1) return sendJson(res, 404, { error: 'not found' })
      const item = data.media[idx]
      removeMediaFiles(item)
      data.media.splice(idx, 1)
      writeMetadataToDisk(data)
      sendJson(res, 200, { ok: true })
      return
    }

    // Merge resolved video durations without clobbering other fields.
    if (pathname === '/api/update-durations' && method === 'POST') {
      const body = await readJsonBody(req)
      const data = readMetadataFromDisk()
      if (body && typeof body === 'object') {
        for (const id of Object.keys(body)) {
          const item = findMediaItem(data, id)
          if (item) item.duration = body[id]
        }
        writeMetadataToDisk(data)
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/media') {
      const mediaPath = requestUrl.searchParams.get('path') || ''
      if (!mediaPath || !isPathInside(DATA_ROOT, mediaPath)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      serveStaticFile(req, res, mediaPath)
      return
    }

    const rendererRoot = path.join(__dirname, 'renderer')
    const relPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    const staticPath = path.resolve(rendererRoot, relPath)
    if (!isPathInside(rendererRoot, staticPath)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    serveStaticFile(req, res, staticPath)
  } catch (e) {
    sendJson(res, 500, { error: e.message })
  }
}

function startCastServer() {
  if (castServer && castServerPort) {
    const urls = getCastUrls()
    return Promise.resolve({ url: urls[0], urls, port: castServerPort })
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(handleCastRequest)
    const onListening = () => {
      castServer = server
      castServerPort = server.address().port
      const urls = getCastUrls()
      resolve({ url: urls[0], urls, port: castServerPort })
    }
    server.on('error', err => {
      if (err.code === 'EADDRINUSE' && !castServerPort) {
        server.listen(0, '0.0.0.0', onListening)
        return
      }
      reject(err)
    })
    server.listen(CAST_PORT, '0.0.0.0', onListening)
  })
}

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled) return null
  return res.filePaths[0]
})

ipcMain.handle('list-import-files', async (event, srcFolder, mediaType) => {
  try {
    return listSupportedFiles(srcFolder, mediaType)
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('read-metadata', async () => {
  const p = path.join(APP_ROOT, 'metadata.json')
  try {
    const text = fs.readFileSync(p, 'utf8')
    let obj = JSON.parse(text)
    const normalized = normalizeMetadata(obj)
    if (normalized.changed) fs.writeFileSync(p, JSON.stringify(normalized.data, null, 2))
    return normalized.data
  } catch (e) {
    const empty = { media: [], tags: [] }
    fs.writeFileSync(p, JSON.stringify(empty, null, 2))
    return empty
  }
})

ipcMain.handle('get-cast-url', async () => {
  try {
    return await startCastServer()
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('write-metadata', async (event, data) => {
  const p = path.join(APP_ROOT, 'metadata.json')
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return true
})

// Atomic favorite toggle: read-modify-write on disk so favorite flags survive
// even when the renderer's in-memory copy is racing with other writes (e.g.
// background duration lookups that rewrite the whole metadata file).
ipcMain.handle('toggle-favorite', async (event, id, favorite) => {
  const p = path.join(APP_ROOT, 'metadata.json')
  try {
    let obj
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) {
      obj = { media: [], tags: [] }
    }
    const normalized = normalizeMetadata(obj)
    const data = normalized.data
    const item = data.media.find(m => String(m.id) === String(id))
    if (!item) return { error: 'not found' }

    item.favorite = !!favorite
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
    return { ok: true, favorite: item.favorite }
  } catch (e) {
    return { error: e.message }
  }
})

// Merge resolved video durations into the on-disk metadata without clobbering
// unrelated fields (e.g. favorites toggled concurrently). Accepts a map of
// id -> durationSeconds.
ipcMain.handle('update-durations', async (event, durations) => {
  const p = path.join(APP_ROOT, 'metadata.json')
  try {
    let obj
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) {
      obj = { media: [], tags: [] }
    }
    const normalized = normalizeMetadata(obj)
    const data = normalized.data
    if (!durations || typeof durations !== 'object') return { ok: true }

    let changed = false
    for (const id of Object.keys(durations)) {
      const item = data.media.find(m => String(m.id) === String(id))
      if (item && item.duration !== durations[id]) {
        item.duration = durations[id]
        changed = true
      }
    }
    if (changed) fs.writeFileSync(p, JSON.stringify(data, null, 2))
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('move-file', async (event, srcPath, category, mediaType) => {
  try {
    const destDir = path.join(DATA_ROOT, mediaType === 'photo' ? 'photos' : 'videos', category)
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
    const base = path.basename(srcPath)
    let dest = path.join(destDir, base)
    // avoid overwrite
    let i = 1
    while (fs.existsSync(dest)) {
      const ext = path.extname(base)
      const name = path.basename(base, ext)
      dest = path.join(destDir, `${name}_${i}${ext}`)
      i++
    }
    try {
      fs.renameSync(srcPath, dest)
    } catch (e) {
      fs.copyFileSync(srcPath, dest)
      fs.unlinkSync(srcPath)
    }
    const thumb = await generateThumbnail(dest, mediaType)
    const duration = mediaType === 'video' ? await getVideoDuration(dest) : null
    return { path: dest, thumbnail: thumb, duration }
  } catch (e) {
    return {error: e.message}
  }
})

ipcMain.handle('move-folder', async (event, srcFolder, category, mediaType) => {
  try {
    const entries = listSupportedFiles(srcFolder, mediaType).map(filePath => path.basename(filePath))
    const moved = []
    for (const name of entries) {
      const src = path.join(srcFolder, name)
      const stat = fs.statSync(src)
      if (!stat.isFile()) continue
      const ext = path.extname(name).toLowerCase()
      const destDir = path.join(DATA_ROOT, mediaType === 'photo' ? 'photos' : 'videos', category)
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
      let dest = path.join(destDir, name)
      let i = 1
      while (fs.existsSync(dest)) {
        const base = path.basename(name, ext)
        dest = path.join(destDir, `${base}_${i}${ext}`)
        i++
      }
      try {
        fs.renameSync(src, dest)
      } catch (e) {
        fs.copyFileSync(src, dest)
        fs.unlinkSync(src)
      }
      // generate thumbnail
      const thumb = await generateThumbnail(dest, mediaType)
      const duration = mediaType === 'video' ? await getVideoDuration(dest) : null
      moved.push({ path: dest, thumbnail: thumb, duration })
    }
    return moved
  } catch (e) {
    return {error: e.message}
  }
})

ipcMain.handle('select-files', async (event, mediaType) => {
  try {
    const filters = mediaType === 'photo'
      ? [{ name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','bmp'] }]
      : [{ name: 'Videos', extensions: ['mp4','mov','webm','mkv','avi'] }]
    const res = await dialog.showOpenDialog({ properties: ['openFile','multiSelections'], filters })
    if (res.canceled) return []
    return res.filePaths
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('select-comic-links-file', async () => {
  try {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text files', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('select-comic-preview-file', async () => {
  try {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('import-manual-comic', async (event, options) => {
  try {
    return await importManualComicFromFolder(options || {})
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('import-comics-file', async (event, filePath, category) => {
  try {
    const inputPath = filePath || path.join(__dirname, 'ссылки.txt')
    if (!fs.existsSync(inputPath)) return { error: 'Links file not found' }

    const links = fs.readFileSync(inputPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => /^https?:\/\//i.test(line))

    const metaPath = path.join(APP_ROOT, 'metadata.json')
    const data = normalizeMetadata(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).data
    const imported = []
    const errors = []

    event.sender.send('comic-import-progress', {
      done: 0,
      total: links.length,
      imported: 0,
      failed: 0,
      current: '',
      errors: []
    })

    for (let index = 0; index < links.length; index++) {
      const link = links[index]
      event.sender.send('comic-import-progress', {
        done: index,
        total: links.length,
        imported: imported.length,
        failed: errors.length,
        current: link,
        errors
      })

      if (data.media.some(item => item.type === 'comic' && item.sourceUrl === link)) {
        errors.push({ url: link, error: 'Already imported' })
        event.sender.send('comic-import-progress', {
          done: index + 1,
          total: links.length,
          imported: imported.length,
          failed: errors.length,
          current: link,
          errors
        })
        continue
      }
      try {
        const result = await importComicFromUrl(link, category)
        data.media.push(result.item)
        result.item.tags.forEach(tag => {
          if (!data.tags.includes(tag)) data.tags.push(tag)
        })
        imported.push(result.item)
        fs.writeFileSync(metaPath, JSON.stringify(data, null, 2))
      } catch (e) {
        errors.push({ url: link, error: e.message })
      }
      event.sender.send('comic-import-progress', {
        done: index + 1,
        total: links.length,
        imported: imported.length,
        failed: errors.length,
        current: link,
        errors
      })
    }

    return { imported, errors, total: links.length }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('remove-comic-page', async (event, comicId, pagePath) => {
  try {
    const metaPath = path.join(APP_ROOT, 'metadata.json')
    const data = normalizeMetadata(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).data
    const item = data.media.find(media => String(media.id) === String(comicId))
    if (!item || item.type !== 'comic') return { error: 'Comic not found' }

    const resolvedComicDir = path.resolve(item.path || '')
    const resolvedPage = path.resolve(pagePath || '')
    if (!resolvedPage.startsWith(resolvedComicDir + path.sep)) return { error: 'Page is outside comic folder' }

    item.pages = (item.pages || []).filter(page => path.resolve(page) !== resolvedPage)
    if (path.resolve(item.thumbnail || '') === resolvedPage) item.thumbnail = item.pages[0] || null
    fs.writeFileSync(metaPath, JSON.stringify(data, null, 2))

    try {
      if (fs.existsSync(resolvedPage)) fs.unlinkSync(resolvedPage)
    } catch (e) {
      return { error: e.message }
    }

    return { item }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('get-video-duration', async (event, videoPath) => {
  try {
    return { duration: await getVideoDuration(videoPath) }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('select-video-thumbnail', async (event, videoPath) => {
  try {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','bmp'] }]
    })
    if (res.canceled || !res.filePaths.length) return null

    const out = await saveVideoThumbnailFromInput(res.filePaths[0], videoPath)
    return { thumbnail: out }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('paste-video-thumbnail', async (event, videoPath) => {
  try {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { error: 'Clipboard does not contain an image' }

    const out = await saveVideoThumbnailFromInput(image.toPNG(), videoPath)
    return { thumbnail: out }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('delete-media', async (event, id) => {
  try {
    const data = readMetadataFromDisk()
    const idx = data.media.findIndex(m => m.id === id || String(m.id) === String(id))
    if (idx === -1) return { error: 'not found' }
    removeMediaFiles(data.media[idx])
    data.media.splice(idx, 1)
    writeMetadataToDisk(data)
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('save-file', async (event, relPath, dataURL) => {
  const full = path.join(APP_ROOT, relPath)
  const matches = dataURL.match(/^data:(.+);base64,(.+)$/)
  if (!matches) return {error:'bad data'}
  const buf = Buffer.from(matches[2], 'base64')
  fs.writeFileSync(full, buf)
  return full
})

// Atomic per-item field update for the desktop renderer, mirroring the web
// cast endpoint. Accepts { id, name, category, tags, description }.
ipcMain.handle('update-media', async (event, changes) => {
  try {
    const data = readMetadataFromDisk()
    const item = findMediaItem(data, changes && changes.id)
    if (!item) return { error: 'not found' }
    if (typeof changes.name === 'string' && changes.name.trim()) item.name = changes.name.trim()
    if (typeof changes.category === 'string' && changes.category.trim()) item.category = changes.category.trim()
    if (Array.isArray(changes.tags)) {
      item.tags = changes.tags.map(tag => String(tag).trim()).filter(Boolean)
      changes.tags.forEach(tag => { if (!data.tags.includes(tag)) data.tags.push(tag) })
    }
    if (typeof changes.description === 'string') item.description = changes.description
    writeMetadataToDisk(data)
    return { ok: true, data }
  } catch (e) {
    return { error: e.message }
  }
})
