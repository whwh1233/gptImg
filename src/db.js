const DB_NAME = 'gpt2img'
const STORE = 'images'
const VERSION = 1
export const MAX_IMAGES = 60
export const MAX_TOTAL_BYTES = 400 * 1024 * 1024

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        os.createIndex('createdAt', 'createdAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listImages() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const rows = req.result || []
      rows.sort((a, b) => b.createdAt - a.createdAt)
      resolve(rows)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function addImage({
  blob,
  prompt,
  size,
  model,
  kind = 'generate',
  originBlob = null,
}) {
  const db = await openDB()
  const record = {
    blob,
    prompt,
    size,
    model,
    kind,
    originBlob,
    createdAt: Date.now(),
  }
  const id = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).add(record)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await enforceLimit()
  return { ...record, id }
}

export async function deleteImage(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function bytesOf(rec) {
  return (rec.blob?.size || 0) + (rec.originBlob?.size || 0)
}

async function enforceLimit() {
  let all = await listImages()
  if (all.length > MAX_IMAGES) {
    const extras = all.slice(MAX_IMAGES)
    for (const rec of extras) await deleteImage(rec.id)
    all = all.slice(0, MAX_IMAGES)
  }
  let total = all.reduce((s, r) => s + bytesOf(r), 0)
  if (total <= MAX_TOTAL_BYTES) return
  for (let i = all.length - 1; i >= 0 && total > MAX_TOTAL_BYTES; i--) {
    total -= bytesOf(all[i])
    await deleteImage(all[i].id)
  }
}

export async function storageStats() {
  const all = await listImages()
  const bytes = all.reduce((s, r) => s + bytesOf(r), 0)
  return { count: all.length, bytes }
}

export function b64ToBlob(b64, mime = 'image/png') {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

export async function urlToBlob(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`下载图片失败: HTTP ${r.status}`)
  return r.blob()
}
