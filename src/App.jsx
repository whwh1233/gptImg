import { useEffect, useRef, useState } from 'react'
import './App.css'
import { checkForbidden } from './moderation'
import {
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  addImage,
  b64ToBlob,
  deleteImage,
  listImages,
  urlToBlob,
} from './db'

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function BeforeAfter({ originUrl, resultUrl, alt, onZoom }) {
  return (
    <div className="ba">
      <figure className="ba-cell">
        <img
          src={originUrl}
          alt="原图"
          onClick={() => onZoom(originUrl, '原图')}
        />
        <figcaption>原图</figcaption>
      </figure>
      <figure className="ba-cell">
        <img
          src={resultUrl}
          alt={alt}
          onClick={() => onZoom(resultUrl, alt)}
        />
        <figcaption>编辑后</figcaption>
      </figure>
    </div>
  )
}

function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="关闭"
      >
        ×
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

const STORAGE_KEY = 'gpt2img_cfg_v4'
const DEFAULT_BASE_URL = 'https://api.pubwhere.cn'
const DEFAULT_API_KEY = import.meta.env.VITE_DEFAULT_API_KEY || ''

const RATIOS = [
  { value: '1:1', label: '1:1 方形', base: [1024, 1024] },
  { value: '3:2', label: '3:2 横向', base: [1536, 1024] },
  { value: '2:3', label: '2:3 竖向', base: [1024, 1536] },
  { value: '16:9', label: '16:9 宽屏', base: [1792, 1024] },
  { value: '9:16', label: '9:16 竖屏', base: [1024, 1792] },
]

const QUALITIES = [
  { value: '1k', label: '1K', mul: 1 },
  { value: '2k', label: '2K', mul: 2 },
  { value: '4k', label: '4K (部分接口可能不支持)', mul: 4 },
]

function computeSize(ratio, quality) {
  const r = RATIOS.find((x) => x.value === ratio) || RATIOS[0]
  const q = QUALITIES.find((x) => x.value === quality) || QUALITIES[0]
  return `${r.base[0] * q.mul}x${r.base[1] * q.mul}`
}

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

let _sid = 0
function nextSid() {
  return `s${Date.now().toString(36)}-${++_sid}`
}

function makeSession({
  name = '',
  mode = 'generate',
  ratio = '1:1',
  quality = '1k',
  model = 'gpt-image-2',
} = {}) {
  return {
    id: nextSid(),
    name,
    mode,
    prompt: '',
    ratio,
    quality,
    model,
    editItems: [],
    primaryIdx: 0,
    mask: null,
    selection: null,
    batchItems: [],
    status: { msg: '', err: false },
  }
}

function revokeSession(s) {
  for (const it of s.editItems) URL.revokeObjectURL(it.url)
  for (const it of s.batchItems) URL.revokeObjectURL(it.url)
  if (s.mask?.url) URL.revokeObjectURL(s.mask.url)
}

export default function App() {
  const cfg = loadCfg()
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl || DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState(cfg.apiKey || DEFAULT_API_KEY)
  const [showApiKey, setShowApiKey] = useState(false)

  const initRef = useRef(null)
  if (!initRef.current) {
    initRef.current = makeSession({
      name: '会话 1',
      ratio: cfg.ratio || '1:1',
      quality: cfg.quality || '1k',
      model: cfg.model || 'gpt-image-2',
    })
  }
  const [sessions, setSessions] = useState(() => [initRef.current])
  const [activeId, setActiveId] = useState(initRef.current.id)
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const active = sessions.find((s) => s.id === activeId) || sessions[0]

  const dragRef = useRef(null)
  const primaryImgRef = useRef(null)
  const [images, setImages] = useState([])
  const [stats, setStats] = useState({ count: 0, bytes: 0 })
  const [lightbox, setLightbox] = useState(null)
  const [copiedId, setCopiedId] = useState(null)
  const copyTimerRef = useRef(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const [pending, setPending] = useState([])
  const pendingKeyRef = useRef(0)
  const abortersRef = useRef(new Map())
  function pushPending(item, controller) {
    const key = `p${++pendingKeyRef.current}`
    if (controller) abortersRef.current.set(key, controller)
    setPending((prev) => [...prev, { ...item, key, createdAt: Date.now() }])
    return key
  }
  function patchPending(key, patch) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }
  function popPending(key) {
    abortersRef.current.delete(key)
    setPending((prev) => prev.filter((p) => p.key !== key))
  }
  function cancelPending(key) {
    const ok = window.confirm(
      '取消只会断开与服务器的连接,如果服务端已在生成,这次请求仍可能产生费用。\n\n确定要取消吗?'
    )
    if (!ok) return
    const c = abortersRef.current.get(key)
    if (c) {
      try {
        c.abort()
      } catch {
        // ignore
      }
    }
    patchPending(key, { canceling: true, label: '取消中…' })
  }
  function isSessionBusy(sid) {
    return pending.some((p) => p.sid === sid && !p.failed)
  }
  function failPending(key, error) {
    abortersRef.current.delete(key)
    setPending((prev) =>
      prev.map((p) =>
        p.key === key
          ? { ...p, failed: true, error, label: '生成失败', canceling: false }
          : p
      )
    )
  }
  function dismissPending(key) {
    abortersRef.current.delete(key)
    setPending((prev) => {
      const target = prev.find((p) => p.key === key)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((p) => p.key !== key)
    })
  }
  const urlsRef = useRef(new Map())
  const originUrlsRef = useRef(new Map())

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        baseUrl,
        apiKey,
        model: active?.model,
        ratio: active?.ratio,
        quality: active?.quality,
      })
    )
  }, [baseUrl, apiKey, active?.model, active?.ratio, active?.quality])

  useEffect(() => {
    let mounted = true
    listImages()
      .then((rows) => {
        if (!mounted) return
        let bytes = 0
        const mapped = rows.map((r) => {
          const url = URL.createObjectURL(r.blob)
          urlsRef.current.set(r.id, url)
          let originUrl = null
          if (r.originBlob) {
            originUrl = URL.createObjectURL(r.originBlob)
            originUrlsRef.current.set(r.id, originUrl)
            bytes += r.originBlob.size
          }
          bytes += r.blob.size
          return {
            id: r.id,
            url,
            originUrl,
            prompt: r.prompt,
            size: r.size,
            model: r.model,
            kind: r.kind || 'generate',
            createdAt: r.createdAt,
          }
        })
        setImages(mapped)
        setStats({ count: rows.length, bytes })
      })
      .catch((e) => {
        updateSession(activeId, {
          status: { msg: `读取本地画廊失败: ${e.message}`, err: true },
        })
      })
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const urls = urlsRef.current
    const originUrls = originUrlsRef.current
    return () => {
      for (const u of urls.values()) URL.revokeObjectURL(u)
      urls.clear()
      for (const u of originUrls.values()) URL.revokeObjectURL(u)
      originUrls.clear()
    }
  }, [])

  function updateSession(id, patch) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id
          ? typeof patch === 'function'
            ? patch(s)
            : { ...s, ...patch }
          : s
      )
    )
  }
  function updateActive(patch) {
    updateSession(activeId, patch)
  }
  function setSessionStatus(id, status) {
    updateSession(id, { status })
  }

  function addSessionTab() {
    const last = sessions[sessions.length - 1]
    const s = makeSession({
      name: `会话 ${sessions.length + 1}`,
      ratio: last?.ratio || '1:1',
      quality: last?.quality || '1k',
      model: last?.model || 'gpt-image-2',
    })
    setSessions((prev) => [...prev, s])
    setActiveId(s.id)
  }

  function closeSession(id) {
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id)
      if (target) revokeSession(target)
      if (prev.length <= 1) {
        const fresh = makeSession({
          name: '会话 1',
          ratio: target?.ratio,
          quality: target?.quality,
          model: target?.model,
        })
        setActiveId(fresh.id)
        return [fresh]
      }
      const next = prev.filter((s) => s.id !== id)
      if (id === activeId) {
        const idx = prev.findIndex((s) => s.id === id)
        const fallback = next[Math.max(0, idx - 1)] || next[0]
        setActiveId(fallback.id)
      }
      return next
    })
  }

  function renameSession(id) {
    const s = sessions.find((x) => x.id === id)
    if (!s) return
    const next = window.prompt('会话名称', s.name)
    if (next == null) return
    const trimmed = next.trim()
    if (!trimmed) return
    updateSession(id, { name: trimmed })
  }

  async function refreshGallery() {
    const rows = await listImages()
    const kept = new Set(rows.map((r) => r.id))
    for (const [id, u] of urlsRef.current.entries()) {
      if (!kept.has(id)) {
        URL.revokeObjectURL(u)
        urlsRef.current.delete(id)
      }
    }
    for (const [id, u] of originUrlsRef.current.entries()) {
      if (!kept.has(id)) {
        URL.revokeObjectURL(u)
        originUrlsRef.current.delete(id)
      }
    }
    let bytes = 0
    setImages(
      rows.map((r) => {
        let url = urlsRef.current.get(r.id)
        if (!url) {
          url = URL.createObjectURL(r.blob)
          urlsRef.current.set(r.id, url)
        }
        let originUrl = originUrlsRef.current.get(r.id) || null
        if (!originUrl && r.originBlob) {
          originUrl = URL.createObjectURL(r.originBlob)
          originUrlsRef.current.set(r.id, originUrl)
        }
        bytes += r.blob.size + (r.originBlob?.size || 0)
        return {
          id: r.id,
          url,
          originUrl,
          prompt: r.prompt,
          size: r.size,
          model: r.model,
          kind: r.kind || 'generate',
          createdAt: r.createdAt,
        }
      })
    )
    setStats({ count: rows.length, bytes })
  }

  async function consumeImageResponse(
    resp,
    { sid, promptText, size, kind = 'generate', originBlob = null, modelUsed, qualityUsed }
  ) {
    const text = await resp.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      const msg = `返回不是 JSON: ${text.slice(0, 200)}`
      setSessionStatus(sid, { msg, err: true })
      return { count: 0, errorMsg: msg }
    }
    if (!resp.ok) {
      const detail =
        data?.error?.message || data?.message || data?.code || text.slice(0, 200)
      const hint = qualityUsed === '4k' ? '（若为尺寸问题,请尝试 2K/1K）' : ''
      const msg = `HTTP ${resp.status}: ${detail}${hint}`
      setSessionStatus(sid, { msg, err: true })
      return { count: 0, errorMsg: msg }
    }
    const items = Array.isArray(data?.data) ? data.data : []
    const blobs = []
    for (const it of items) {
      try {
        if (it.b64_json) blobs.push(b64ToBlob(it.b64_json))
        else if (it.url) blobs.push(await urlToBlob(it.url))
      } catch (e) {
        console.error('convert image failed', e)
      }
    }
    if (!blobs.length) {
      const msg = '响应中没有图片数据'
      setSessionStatus(sid, { msg, err: true })
      return { count: 0, errorMsg: msg }
    }
    for (const blob of blobs) {
      await addImage({ blob, prompt: promptText, size, model: modelUsed, kind, originBlob })
    }
    await refreshGallery()
    return { count: blobs.length, errorMsg: '' }
  }

  async function onGenerate(sid) {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const s = sessionsRef.current.find((x) => x.id === sid)
    if (!s) return
    const p = s.prompt.trim()

    if (!url) return setSessionStatus(sid, { msg: '请填写 Base URL', err: true })
    if (!key) return setSessionStatus(sid, { msg: '请填写 API Key', err: true })
    if (!p) return setSessionStatus(sid, { msg: '请填写提示词', err: true })

    if (checkForbidden(p)) {
      return setSessionStatus(sid, {
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(s.ratio, s.quality)
    const modelUsed = s.model
    const qualityUsed = s.quality

    setSessionStatus(sid, { msg: '已提交,生成中…', err: false })
    const controller = new AbortController()
    const pkey = pushPending(
      { sid, kind: 'generate', prompt: p, label: '生成中' },
      controller
    )

    try {
      const resp = await fetch(`${url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: modelUsed, prompt: p, size, n: 1 }),
        signal: controller.signal,
      })
      const { count, errorMsg } = await consumeImageResponse(resp, {
        sid,
        promptText: p,
        size,
        kind: 'generate',
        modelUsed,
        qualityUsed,
      })
      if (count > 0) {
        setSessionStatus(sid, { msg: `已生成 ${count} 张`, err: false })
        popPending(pkey)
      } else {
        failPending(pkey, errorMsg || '未知错误')
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        setSessionStatus(sid, { msg: '已取消', err: false })
        popPending(pkey)
      } else {
        const msg = `请求失败:${e.message}`
        setSessionStatus(sid, { msg, err: true })
        failPending(pkey, msg)
      }
    }
  }

  async function onEdit(sid) {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const s = sessionsRef.current.find((x) => x.id === sid)
    if (!s) return
    const p = s.prompt.trim()

    if (!url) return setSessionStatus(sid, { msg: '请填写 Base URL', err: true })
    if (!key) return setSessionStatus(sid, { msg: '请填写 API Key', err: true })
    if (!p) return setSessionStatus(sid, { msg: '请填写提示词', err: true })
    if (!s.editItems.length)
      return setSessionStatus(sid, { msg: '请上传至少 1 张待编辑图片', err: true })

    if (checkForbidden(p)) {
      return setSessionStatus(sid, {
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(s.ratio, s.quality)
    const modelUsed = s.model
    const qualityUsed = s.quality
    const editFiles = s.editItems.map((it) => it.file)
    const primaryIdx = Math.min(s.primaryIdx, editFiles.length - 1)
    const maskFile = s.mask?.file || null

    setSessionStatus(sid, { msg: '已提交,编辑中…', err: false })
    const originBlob = editFiles[primaryIdx] || null
    const previewUrl = originBlob ? URL.createObjectURL(originBlob) : null
    const controller = new AbortController()
    const pkey = pushPending(
      { sid, kind: 'edit', prompt: p, label: '编辑中', previewUrl },
      controller
    )

    try {
      const fd = new FormData()
      fd.append('model', modelUsed)
      fd.append('prompt', p)
      fd.append('size', size)
      fd.append('n', '1')
      fd.append('response_format', 'b64_json')
      for (const f of editFiles) fd.append('image', f, f.name)
      if (maskFile) fd.append('mask', maskFile, maskFile.name)

      const resp = await fetch(`${url}/v1/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: controller.signal,
      })
      const { count, errorMsg } = await consumeImageResponse(resp, {
        sid,
        promptText: p,
        size,
        kind: 'edit',
        originBlob,
        modelUsed,
        qualityUsed,
      })
      if (count > 0) {
        setSessionStatus(sid, { msg: `已生成 ${count} 张`, err: false })
        popPending(pkey)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
      } else {
        failPending(pkey, errorMsg || '未知错误')
        // keep previewUrl alive for the failed card; revoke when dismissed
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        setSessionStatus(sid, { msg: '已取消', err: false })
        popPending(pkey)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
      } else {
        const msg = `请求失败:${e.message}`
        setSessionStatus(sid, { msg, err: true })
        failPending(pkey, msg)
      }
    }
  }

  async function onBatch(sid) {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const s = sessionsRef.current.find((x) => x.id === sid)
    if (!s) return
    const p = s.prompt.trim()

    if (!url) return setSessionStatus(sid, { msg: '请填写 Base URL', err: true })
    if (!key) return setSessionStatus(sid, { msg: '请填写 API Key', err: true })
    if (!p) return setSessionStatus(sid, { msg: '请填写风格指令', err: true })
    if (!s.batchItems.length)
      return setSessionStatus(sid, { msg: '请上传至少 1 张图片', err: true })

    if (checkForbidden(p)) {
      return setSessionStatus(sid, {
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(s.ratio, s.quality)
    const modelUsed = s.model
    const qualityUsed = s.quality
    const files = s.batchItems.map((it) => it.file)

    let success = 0
    let fail = 0
    let canceled = false
    const failures = []
    const controller = new AbortController()
    const pkey = pushPending(
      {
        sid,
        kind: 'batch',
        prompt: p,
        label: `批量 0/${files.length}`,
      },
      controller
    )

    for (let i = 0; i < files.length; i++) {
      if (controller.signal.aborted) {
        canceled = true
        break
      }
      const file = files[i]
      setSessionStatus(sid, {
        msg: `批量风格化中 (${i + 1}/${files.length}) — ${file.name}…`,
        err: false,
      })
      patchPending(pkey, { label: `批量 ${i + 1}/${files.length}` })
      try {
        const fd = new FormData()
        fd.append('model', modelUsed)
        fd.append('prompt', p)
        fd.append('size', size)
        fd.append('n', '1')
        fd.append('response_format', 'b64_json')
        fd.append('image', file, file.name)

        const resp = await fetch(`${url}/v1/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: fd,
          signal: controller.signal,
        })
        const { count, errorMsg } = await consumeImageResponse(resp, {
          sid,
          promptText: p,
          size,
          kind: 'edit',
          originBlob: file,
          modelUsed,
          qualityUsed,
        })
        if (count > 0) success++
        else {
          fail++
          failures.push(`${file.name}${errorMsg ? ` — ${errorMsg}` : ''}`)
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          canceled = true
          break
        }
        fail++
        failures.push(`${file.name} (${e.message})`)
      }
    }

    const summary = canceled
      ? `已取消: 完成 ${success} / 已跳过 ${files.length - success - fail}`
      : fail === 0
        ? `批量完成: 成功 ${success} 张`
        : `批量完成: 成功 ${success} / 失败 ${fail}${failures.length ? ` — ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}` : ''}`
    setSessionStatus(sid, { msg: summary, err: !canceled && fail > 0 })
    if (!canceled && fail > 0) {
      failPending(pkey, summary)
    } else {
      popPending(pkey)
    }
  }

  function onSubmitActive() {
    if (!active) return
    if (active.mode === 'edit') onEdit(active.id)
    else if (active.mode === 'batch') onBatch(active.id)
    else onGenerate(active.id)
  }

  function triggerDownload(img) {
    const a = document.createElement('a')
    a.href = img.url
    a.download = `gpt-image-${img.id}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function performDelete(id) {
    try {
      await deleteImage(id)
    } catch (e) {
      setSessionStatus(activeId, { msg: `删除失败: ${e.message}`, err: true })
      return
    }
    const u = urlsRef.current.get(id)
    if (u) {
      URL.revokeObjectURL(u)
      urlsRef.current.delete(id)
    }
    const ou = originUrlsRef.current.get(id)
    if (ou) {
      URL.revokeObjectURL(ou)
      originUrlsRef.current.delete(id)
    }
    setImages((prev) => prev.filter((img) => img.id !== id))
    refreshGallery()
  }

  function onDelete(img) {
    setConfirmDel(img)
  }

  async function onConfirmDelete(action) {
    const img = confirmDel
    if (!img) return
    if (action === 'cancel') {
      setConfirmDel(null)
      return
    }
    if (action === 'download') {
      triggerDownload(img)
      // give the browser a tick to start the download before tearing down the URL
      await new Promise((r) => setTimeout(r, 50))
    }
    setConfirmDel(null)
    await performDelete(img.id)
  }

  function onPromptKeyDown(e) {
    if (e.ctrlKey && e.key === 'Enter') {
      onSubmitActive()
    }
  }

  async function copyText(text) {
    if (!text) return false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // fall through to legacy
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  async function onCopyPrompt(id, text) {
    const ok = await copyText(text)
    if (!ok) return
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    setCopiedId(id)
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1500)
  }

  async function onUsePrompt(text) {
    if (!text) return
    updateActive({ prompt: text })
    setActiveId(activeId)
  }

  async function onSendToEdit(img) {
    try {
      const blob = await urlToBlob(img.url)
      const ext = blob.type?.split('/')[1] || 'png'
      const file = new File([blob], `gallery-${img.id}.${ext}`, {
        type: blob.type || 'image/png',
      })
      const item = { file, url: URL.createObjectURL(file) }
      updateActive((cur) => {
        for (const it of cur.editItems) URL.revokeObjectURL(it.url)
        if (cur.mask) URL.revokeObjectURL(cur.mask.url)
        return {
          ...cur,
          mode: 'edit',
          prompt: img.prompt || cur.prompt,
          editItems: [item],
          primaryIdx: 0,
          mask: null,
          selection: null,
          status: { msg: '已载入到编辑模式', err: false },
        }
      })
    } catch (e) {
      setSessionStatus(activeId, {
        msg: `载入到编辑模式失败: ${e.message}`,
        err: true,
      })
    }
  }

  function onPickEditFiles(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const items = files.map((f) => ({ file: f, url: URL.createObjectURL(f) }))
    updateActive((cur) => ({
      ...cur,
      editItems: [...cur.editItems, ...items],
      selection: null,
    }))
    e.target.value = ''
  }

  function onRemoveEditFile(idx) {
    updateActive((cur) => {
      const removed = cur.editItems[idx]
      if (removed) URL.revokeObjectURL(removed.url)
      const editItems = cur.editItems.filter((_, i) => i !== idx)
      let mask = cur.mask
      let selection = cur.selection
      let primaryIdx = cur.primaryIdx
      if (idx === cur.primaryIdx) {
        selection = null
        if (mask?.file?.name === 'mask.png') {
          URL.revokeObjectURL(mask.url)
          mask = null
        }
      }
      if (primaryIdx >= editItems.length) {
        primaryIdx = Math.max(0, editItems.length - 1)
      }
      return { ...cur, editItems, mask, selection, primaryIdx }
    })
  }

  function onClearAllEdit() {
    updateActive((cur) => {
      for (const it of cur.editItems) URL.revokeObjectURL(it.url)
      let mask = cur.mask
      if (mask) {
        URL.revokeObjectURL(mask.url)
        mask = null
      }
      return { ...cur, editItems: [], primaryIdx: 0, mask, selection: null }
    })
  }

  function onPickMask(e) {
    const f = e.target.files?.[0] || null
    if (!f) return
    updateActive((cur) => {
      if (cur.mask) URL.revokeObjectURL(cur.mask.url)
      return {
        ...cur,
        mask: { file: f, url: URL.createObjectURL(f) },
        selection: null,
      }
    })
    e.target.value = ''
  }

  function onRemoveMask() {
    updateActive((cur) => {
      if (cur.mask) URL.revokeObjectURL(cur.mask.url)
      return { ...cur, mask: null }
    })
  }

  function relPos(evt, el) {
    const r = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (evt.clientY - r.top) / r.height)),
    }
  }

  function onSelDown(e) {
    if (!primaryImgRef.current) return
    e.preventDefault()
    const p = relPos(e, e.currentTarget)
    dragRef.current = { sid: activeId, x: p.x, y: p.y }
    updateActive({ selection: { x: p.x, y: p.y, w: 0, h: 0 } })
  }

  function onSelMove(e) {
    if (!dragRef.current) return
    if (dragRef.current.sid !== activeId) return
    const p = relPos(e, e.currentTarget)
    const s = dragRef.current
    updateActive({
      selection: {
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      },
    })
  }

  async function onSelUp() {
    if (!dragRef.current) return
    const drag = dragRef.current
    dragRef.current = null
    if (drag.sid !== activeId) return
    const cur = sessionsRef.current.find((x) => x.id === activeId)
    const sel = cur?.selection
    const img = primaryImgRef.current
    if (!sel || !img || sel.w < 0.01 || sel.h < 0.01) {
      updateActive({ selection: null })
      return
    }
    const W = img.naturalWidth
    const H = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.clearRect(
      Math.round(sel.x * W),
      Math.round(sel.y * H),
      Math.round(sel.w * W),
      Math.round(sel.h * H)
    )
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) return
    const file = new File([blob], 'mask.png', { type: 'image/png' })
    updateActive((c) => {
      if (c.mask) URL.revokeObjectURL(c.mask.url)
      return { ...c, mask: { file, url: URL.createObjectURL(file) } }
    })
  }

  function onClearSelection() {
    updateActive((cur) => {
      let mask = cur.mask
      if (mask?.file?.name === 'mask.png') {
        URL.revokeObjectURL(mask.url)
        mask = null
      }
      return { ...cur, selection: null, mask }
    })
  }

  function onPickBatchFiles(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const items = files.map((f) => ({ file: f, url: URL.createObjectURL(f) }))
    updateActive((cur) => ({ ...cur, batchItems: [...cur.batchItems, ...items] }))
    e.target.value = ''
  }

  function onRemoveBatchFile(idx) {
    updateActive((cur) => {
      const removed = cur.batchItems[idx]
      if (removed) URL.revokeObjectURL(removed.url)
      return { ...cur, batchItems: cur.batchItems.filter((_, i) => i !== idx) }
    })
  }

  function onClearAllBatch() {
    updateActive((cur) => {
      for (const it of cur.batchItems) URL.revokeObjectURL(it.url)
      return { ...cur, batchItems: [] }
    })
  }

  const currentSize = active ? computeSize(active.ratio, active.quality) : ''
  const activeBusy = active ? isSessionBusy(active.id) : false
  const activePendingCount = active
    ? pending.filter((p) => p.sid === active.id && !p.failed).length
    : 0
  const submitLabel =
    active?.mode === 'edit'
      ? '生成编辑结果'
      : active?.mode === 'batch'
        ? `批量风格化 (${active.batchItems.length} 张)`
        : '生成图片'

  function sessionTitle(s) {
    if (s.name) return s.name
    return `会话 ${sessions.findIndex((x) => x.id === s.id) + 1}`
  }
  function sessionDot(s) {
    if (isSessionBusy(s.id)) return 'running'
    if (s.status?.err) return 'err'
    if (s.status?.msg) return 'ok'
    return 'idle'
  }
  const DOT_LABEL = {
    idle: '空闲',
    running: '运行中',
    ok: '已完成',
    err: '出错',
  }

  return (
    <div className="wrap">
      <header className="site">
        <h1 className="title">GPT-Image-2 生图</h1>
        <div className="sub">填写接口信息与提示词,点击生成即可。</div>
      </header>

      <section className="panel">
        <div className="session-bar" role="tablist" aria-label="会话">
          {sessions.map((s) => {
            const dot = sessionDot(s)
            const label = DOT_LABEL[dot]
            return (
              <div
                key={s.id}
                className={`session-tab${s.id === activeId ? ' active' : ''} dot-${dot}`}
                role="tab"
                aria-selected={s.id === activeId}
                onClick={() => setActiveId(s.id)}
                onDoubleClick={() => renameSession(s.id)}
                title={`${sessionTitle(s)} · ${label}（单击切换 · 双击重命名）`}
              >
                <span className="session-dot" title={label} aria-label={label} />
                <span className="session-name">{sessionTitle(s)}</span>
                <span className={`session-state st-${dot}`}>{label}</span>
                <button
                  type="button"
                  className="session-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeSession(s.id)
                  }}
                  aria-label="关闭会话"
                  title="关闭"
                >
                  ×
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="session-add"
            onClick={addSessionTab}
            title="新建会话"
          >
            + 新建会话
          </button>
          <div className="session-legend" aria-hidden="true">
            <span className="lg-item"><span className="lg-dot lg-idle" />空闲</span>
            <span className="lg-item"><span className="lg-dot lg-running" />运行中</span>
            <span className="lg-item"><span className="lg-dot lg-ok" />已完成</span>
            <span className="lg-item"><span className="lg-dot lg-err" />出错</span>
          </div>
        </div>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={active.mode === 'generate'}
            className={`tab${active.mode === 'generate' ? ' active' : ''}`}
            onClick={() => updateActive({ mode: 'generate' })}
          >
            文生图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active.mode === 'edit'}
            className={`tab${active.mode === 'edit' ? ' active' : ''}`}
            onClick={() => updateActive({ mode: 'edit' })}
          >
            图片编辑
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active.mode === 'batch'}
            className={`tab${active.mode === 'batch' ? ' active' : ''}`}
            onClick={() => updateActive({ mode: 'batch' })}
          >
            批量风格化
          </button>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="baseUrl">Base URL</label>
            <input
              id="baseUrl"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.pubwhere.cn"
            />
          </div>
          <div className="field">
            <label htmlFor="apiKey">API Key</label>
            <div className="input-with-affix">
              <input
                id="apiKey"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <button
                type="button"
                className="affix-btn"
                onClick={() => setShowApiKey((v) => !v)}
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                title={showApiKey ? '隐藏' : '显示'}
              >
                {showApiKey ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {active.mode === 'edit' && (
          <div className="edit-pane">
            <div className="field">
              <div className="edit-pane-head">
                <label htmlFor="editFiles">待编辑图片</label>
                <div className="edit-pane-actions">
                  <label htmlFor="editFiles" className="btn-ghost">
                    {active.editItems.length ? '继续添加' : '选择图片(可多选)'}
                  </label>
                  {active.editItems.length > 0 && (
                    <button
                      type="button"
                      className="btn-ghost danger"
                      onClick={onClearAllEdit}
                    >
                      全部清除
                    </button>
                  )}
                  <input
                    id="editFiles"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={onPickEditFiles}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              {active.editItems.length === 0 && (
                <label htmlFor="editFiles" className="upload-drop">
                  <div className="upload-icon">＋</div>
                  <div>点击上传图片(可多张,首张可框选编辑区域)</div>
                </label>
              )}

              {active.editItems.length > 0 && (
                <>
                  <div className="edit-thumbs">
                    {active.editItems.map((it, i) => (
                      <div
                        key={it.url}
                        className={`edit-thumb${i === active.primaryIdx ? ' is-primary' : ''}`}
                        onClick={() =>
                          updateActive({ primaryIdx: i, selection: null })
                        }
                        title={
                          i === active.primaryIdx
                            ? '当前主图(可框选)'
                            : '点击设为主图'
                        }
                      >
                        <img src={it.url} alt="" />
                        <button
                          type="button"
                          className="thumb-del"
                          title="移除"
                          onClick={(e) => {
                            e.stopPropagation()
                            onRemoveEditFile(i)
                          }}
                        >
                          ×
                        </button>
                        {i === active.primaryIdx && (
                          <span className="thumb-badge">主图</span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="selection-stage">
                    <div
                      className="selection-canvas"
                      onMouseDown={onSelDown}
                      onMouseMove={onSelMove}
                      onMouseUp={onSelUp}
                      onMouseLeave={onSelUp}
                    >
                      <img
                        ref={primaryImgRef}
                        src={active.editItems[active.primaryIdx]?.url}
                        alt="primary"
                        draggable={false}
                      />
                      {active.selection && (
                        <div
                          className="selection-rect"
                          style={{
                            left: `${active.selection.x * 100}%`,
                            top: `${active.selection.y * 100}%`,
                            width: `${active.selection.w * 100}%`,
                            height: `${active.selection.h * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    <div className="selection-tip">
                      在主图上拖拽鼠标框选要重绘的区域,生成 mask 透明区供 AI 重画;不框选则整图重绘。
                      {active.selection && primaryImgRef.current && (
                        <>
                          {' '}
                          已框选 ≈
                          {Math.round(
                            active.selection.w * primaryImgRef.current.naturalWidth
                          )}
                          ×
                          {Math.round(
                            active.selection.h * primaryImgRef.current.naturalHeight
                          )}
                          {' '}px
                          <button
                            type="button"
                            className="btn-link"
                            onClick={onClearSelection}
                          >
                            清除框选
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="field mask-field">
              <div className="edit-pane-head">
                <label htmlFor="maskFile">自定义蒙版(可选,会覆盖框选)</label>
                <div className="edit-pane-actions">
                  <label htmlFor="maskFile" className="btn-ghost">
                    上传蒙版
                  </label>
                  {active.mask && (
                    <button
                      type="button"
                      className="btn-ghost danger"
                      onClick={onRemoveMask}
                    >
                      移除蒙版
                    </button>
                  )}
                  <input
                    id="maskFile"
                    type="file"
                    accept="image/*"
                    onChange={onPickMask}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>
              {active.mask && (
                <div className="mask-preview">
                  <img src={active.mask.url} alt="mask" />
                  <span className="file-hint">
                    {active.mask.file.name === 'mask.png'
                      ? '由框选自动生成(透明区=可编辑)'
                      : active.mask.file.name}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {active.mode === 'batch' && (
          <div className="edit-pane">
            <div className="field">
              <div className="edit-pane-head">
                <label htmlFor="batchFiles">批量输入图片</label>
                <div className="edit-pane-actions">
                  <label htmlFor="batchFiles" className="btn-ghost">
                    {active.batchItems.length ? '继续添加' : '选择图片(可多选)'}
                  </label>
                  {active.batchItems.length > 0 && (
                    <button
                      type="button"
                      className="btn-ghost danger"
                      onClick={onClearAllBatch}
                    >
                      全部清除
                    </button>
                  )}
                  <input
                    id="batchFiles"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={onPickBatchFiles}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              {active.batchItems.length === 0 ? (
                <label htmlFor="batchFiles" className="upload-drop">
                  <div className="upload-icon">＋</div>
                  <div>
                    点击上传多张图片,将依次以同一风格指令重绘,得到 N 张风格化结果
                  </div>
                </label>
              ) : (
                <>
                  <div className="edit-thumbs">
                    {active.batchItems.map((it, i) => (
                      <div key={it.url} className="edit-thumb">
                        <img src={it.url} alt="" />
                        <button
                          type="button"
                          className="thumb-del"
                          title="移除"
                          onClick={() => onRemoveBatchFile(i)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="selection-tip">
                    将对 {active.batchItems.length} 张图分别调用编辑接口
                    (串行,每张约 10–60 秒),全部使用同一风格指令。
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="prompt">
            {active.mode === 'edit'
              ? '编辑指令'
              : active.mode === 'batch'
                ? '风格指令'
                : '提示词'}
          </label>
          <textarea
            id="prompt"
            value={active.prompt}
            onChange={(e) => updateActive({ prompt: e.target.value })}
            onKeyDown={onPromptKeyDown}
            placeholder={
              active.mode === 'edit'
                ? '例如:把背景改成日落海边,保持主体不变…(Ctrl+Enter 快速提交)'
                : active.mode === 'batch'
                  ? '例如:把所有图片转成水彩画风格,温暖色调,保留各自主体…(Ctrl+Enter 快速提交)'
                  : '例如:一只橘猫坐在窗台上,黄昏柔光,电影质感…(Ctrl+Enter 快速提交)'
            }
          />
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="ratio">比例</label>
            <select
              id="ratio"
              value={active.ratio}
              onChange={(e) => updateActive({ ratio: e.target.value })}
            >
              {RATIOS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="quality">清晰度</label>
            <select
              id="quality"
              value={active.quality}
              onChange={(e) => updateActive({ quality: e.target.value })}
            >
              {QUALITIES.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="model">模型</label>
            <input
              id="model"
              type="text"
              value={active.model}
              onChange={(e) => updateActive({ model: e.target.value })}
            />
          </div>
          <div className="field">
            <label>最终尺寸</label>
            <div className="size-preview">{currentSize}</div>
          </div>
        </div>

        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={onSubmitActive}
          >
            {submitLabel}
            {activePendingCount > 0 && (
              <span className="pending-badge">{activePendingCount}</span>
            )}
          </button>
          <div className={`status${active.status?.err ? ' err' : ''}`}>
            {activeBusy && <span className="spinner" />}
            <span>{active.status?.msg}</span>
          </div>
        </div>

        {activePendingCount > 0 && (
          <div className="inline-tip">
            ⓘ 当前会话有 {activePendingCount} 个任务在生成中。你可以继续修改提示词点「{submitLabel}」再来一张,也可以
            <button
              type="button"
              className="btn-link"
              onClick={addSessionTab}
            >
              新建会话
            </button>
            并行尝试不同思路。
          </div>
        )}

        {sessions.some((s) => isSessionBusy(s.id) && s.id !== activeId) && (
          <div className="bg-running">
            后台运行中:
            {sessions
              .filter((s) => isSessionBusy(s.id) && s.id !== activeId)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="bg-chip"
                  onClick={() => setActiveId(s.id)}
                  title="切换到该会话"
                >
                  <span className="spinner" /> {sessionTitle(s)}
                </button>
              ))}
          </div>
        )}
      </section>

      <div className="gallery-notice">
        <div>
          画廊仅保存在当前浏览器,清理浏览器数据或更换设备后将丢失。
          上限 {MAX_IMAGES} 张 / {fmtMB(MAX_TOTAL_BYTES)},满后自动删除最旧的。
        </div>
        <div className="usage-bar" title={`${stats.count} 张 · ${fmtMB(stats.bytes)}`}>
          <div
            className="usage-fill"
            style={{
              width: `${Math.min(100, (stats.bytes / MAX_TOTAL_BYTES) * 100).toFixed(1)}%`,
            }}
          />
          <span className="usage-text">
            {stats.count}/{MAX_IMAGES} 张 · {fmtMB(stats.bytes)}/{fmtMB(MAX_TOTAL_BYTES)}
          </span>
        </div>
      </div>

      <section className="grid">
        {pending
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((p) => {
            const sName =
              sessions.find((s) => s.id === p.sid)?.name || ''
            return (
              <div
                className={`card ${p.failed ? 'is-failed' : 'is-pending'}`}
                key={p.key}
              >
                <span
                  className={`kind-badge ${p.failed ? 'failed' : 'pending'}`}
                  title={p.failed ? p.error : undefined}
                >
                  {p.failed ? '✗ 失败' : `⋯ ${p.label}`}
                </span>
                <button
                  type="button"
                  className="card-del"
                  title={
                    p.failed
                      ? '关闭失败提示'
                      : p.canceling
                        ? '正在取消…'
                        : '取消任务'
                  }
                  onClick={() =>
                    p.failed ? dismissPending(p.key) : cancelPending(p.key)
                  }
                  disabled={!p.failed && p.canceling}
                >
                  ×
                </button>
                <div className="pending-stage">
                  {p.previewUrl ? (
                    <>
                      <img src={p.previewUrl} alt="原图" />
                      <div
                        className={`pending-overlay${p.failed ? ' is-failed' : ''}`}
                      >
                        {p.failed ? (
                          <>
                            <span className="pending-fail-icon">✗</span>
                            <span className="pending-text">生成失败</span>
                          </>
                        ) : (
                          <>
                            <span className="spinner big" />
                            <span className="pending-text">{p.label}</span>
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <div
                      className={`pending-empty${p.failed ? ' is-failed' : ''}`}
                    >
                      {p.failed ? (
                        <>
                          <span className="pending-fail-icon">✗</span>
                          <span className="pending-text">生成失败</span>
                        </>
                      ) : (
                        <>
                          <span className="spinner big" />
                          <span className="pending-text">{p.label}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {p.failed && p.error && (
                  <div className="pending-error" title={p.error}>
                    {p.error}
                  </div>
                )}
                <div className="meta">
                  <span className="prompt-hint" title={p.prompt}>
                    {p.prompt}
                  </span>
                  <div className="meta-actions">
                    {sName && (
                      <span className="meta-tag" title="所属会话">
                        {sName}
                      </span>
                    )}
                    {p.failed ? (
                      <>
                        <button
                          type="button"
                          className="meta-btn"
                          onClick={() => onUsePrompt(p.prompt)}
                          title="把提示词回填到当前会话以便重试"
                        >
                          重试
                        </button>
                        <button
                          type="button"
                          className="meta-btn meta-btn-danger"
                          onClick={() => dismissPending(p.key)}
                          title="移除该失败记录"
                        >
                          移除
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="meta-btn meta-btn-danger"
                        onClick={() => cancelPending(p.key)}
                        disabled={p.canceling}
                        title="取消该任务"
                      >
                        {p.canceling ? '取消中…' : '取消'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        {images.map((img) => {
          const isEdit = img.kind === 'edit'
          const hasCompare = isEdit && img.originUrl
          return (
            <div className={`card${isEdit ? ' is-edit' : ' is-gen'}`} key={img.id}>
              <span className={`kind-badge${isEdit ? ' edit' : ' gen'}`}>
                {isEdit ? '✎ 编辑' : '✦ 生成'}
              </span>
              <button
                type="button"
                className="card-del"
                title="删除"
                onClick={() => onDelete(img)}
              >
                ×
              </button>
              {hasCompare ? (
                <BeforeAfter
                  originUrl={img.originUrl}
                  resultUrl={img.url}
                  alt={img.prompt}
                  onZoom={(src, alt) => setLightbox({ src, alt })}
                />
              ) : (
                <img
                  src={img.url}
                  alt={img.prompt}
                  className="zoomable"
                  onClick={() => setLightbox({ src: img.url, alt: img.prompt })}
                />
              )}
              <div className="meta">
                <span className="prompt-hint" title={img.prompt}>
                  {img.prompt}
                </span>
                <div className="meta-actions">
                  <button
                    type="button"
                    className="meta-btn"
                    onClick={() => onCopyPrompt(img.id, img.prompt)}
                    title="复制提示词"
                  >
                    {copiedId === img.id ? '已复制 ✓' : '复制'}
                  </button>
                  <button
                    type="button"
                    className="meta-btn"
                    onClick={() => onUsePrompt(img.prompt)}
                    title="填入当前会话的提示词"
                  >
                    用此词
                  </button>
                  <button
                    type="button"
                    className="meta-btn"
                    onClick={() => onSendToEdit(img)}
                    title="在当前会话以此图与提示词进入编辑模式"
                  >
                    去编辑
                  </button>
                  <a
                    className="meta-btn"
                    href={img.url}
                    download={`gpt-image-${img.id}.png`}
                  >
                    下载 ↓
                  </a>
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {lightbox && (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      {confirmDel && (
        <div
          className="modal-mask"
          role="dialog"
          aria-modal="true"
          onClick={() => onConfirmDelete('cancel')}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">删除这张图?</div>
            <div className="modal-body">
              <img
                src={confirmDel.url}
                alt=""
                className="modal-thumb"
              />
              <div className="modal-text">
                <div className="modal-prompt" title={confirmDel.prompt}>
                  {confirmDel.prompt || '(无提示词)'}
                </div>
                <div className="modal-hint">
                  画廊只在本浏览器中保存,删除后无法恢复。需要先下载保存吗?
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onConfirmDelete('cancel')}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-ghost danger"
                onClick={() => onConfirmDelete('delete')}
              >
                直接删除
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => onConfirmDelete('download')}
              >
                下载并删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
