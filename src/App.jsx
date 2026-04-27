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

export default function App() {
  const cfg = loadCfg()
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl || DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState(cfg.apiKey || DEFAULT_API_KEY)
  const [model, setModel] = useState(cfg.model || 'gpt-image-2')
  const [ratio, setRatio] = useState(cfg.ratio || '1:1')
  const [quality, setQuality] = useState(cfg.quality || '1k')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('generate')
  const [editFiles, setEditFiles] = useState([])
  const [editPreviews, setEditPreviews] = useState([])
  const [primaryIdx, setPrimaryIdx] = useState(0)
  const [maskFile, setMaskFile] = useState(null)
  const [maskPreview, setMaskPreview] = useState(null)
  const [selection, setSelection] = useState(null)
  const [batchFiles, setBatchFiles] = useState([])
  const [batchPreviews, setBatchPreviews] = useState([])
  const dragRef = useRef(null)
  const primaryImgRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', err: false })
  const [images, setImages] = useState([])
  const [stats, setStats] = useState({ count: 0, bytes: 0 })
  const [lightbox, setLightbox] = useState(null)
  const urlsRef = useRef(new Map())
  const originUrlsRef = useRef(new Map())

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ baseUrl, apiKey, model, ratio, quality })
    )
  }, [baseUrl, apiKey, model, ratio, quality])

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
        setStatus({ msg: `读取本地画廊失败: ${e.message}`, err: true })
      })
    return () => {
      mounted = false
    }
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

  useEffect(() => {
    const urls = editFiles.map((f) => URL.createObjectURL(f))
    setEditPreviews(urls)
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [editFiles])

  useEffect(() => {
    const urls = batchFiles.map((f) => URL.createObjectURL(f))
    setBatchPreviews(urls)
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [batchFiles])

  useEffect(() => {
    if (!maskFile) {
      setMaskPreview(null)
      return
    }
    const u = URL.createObjectURL(maskFile)
    setMaskPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [maskFile])

  useEffect(() => {
    if (primaryIdx >= editFiles.length) {
      setPrimaryIdx(Math.max(0, editFiles.length - 1))
    }
  }, [editFiles, primaryIdx])

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
    { promptText, size, kind = 'generate', originBlob = null }
  ) {
    const text = await resp.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      setStatus({ msg: `返回不是 JSON: ${text.slice(0, 200)}`, err: true })
      return 0
    }
    if (!resp.ok) {
      const detail =
        data?.error?.message || data?.message || data?.code || text.slice(0, 200)
      const hint =
        quality === '4k' ? '（若为尺寸问题,请尝试 2K/1K）' : ''
      setStatus({ msg: `HTTP ${resp.status}: ${detail}${hint}`, err: true })
      return 0
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
      setStatus({ msg: '响应中没有图片数据', err: true })
      return 0
    }
    for (const blob of blobs) {
      await addImage({ blob, prompt: promptText, size, model, kind, originBlob })
    }
    await refreshGallery()
    return blobs.length
  }

  async function onGenerate() {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const p = prompt.trim()

    if (!url) return setStatus({ msg: '请填写 Base URL', err: true })
    if (!key) return setStatus({ msg: '请填写 API Key', err: true })
    if (!p) return setStatus({ msg: '请填写提示词', err: true })

    if (checkForbidden(p)) {
      return setStatus({
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(ratio, quality)

    setBusy(true)
    setStatus({ msg: '正在生成,通常需要 10–60 秒…', err: false })

    try {
      const resp = await fetch(`${url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt: p, size, n: 1 }),
      })
      const n = await consumeImageResponse(resp, { promptText: p, size, kind: 'generate' })
      if (n > 0) setStatus({ msg: `已生成 ${n} 张`, err: false })
    } catch (e) {
      setStatus({ msg: `请求失败:${e.message}`, err: true })
    } finally {
      setBusy(false)
    }
  }

  async function onEdit() {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const p = prompt.trim()

    if (!url) return setStatus({ msg: '请填写 Base URL', err: true })
    if (!key) return setStatus({ msg: '请填写 API Key', err: true })
    if (!p) return setStatus({ msg: '请填写提示词', err: true })
    if (!editFiles.length) return setStatus({ msg: '请上传至少 1 张待编辑图片', err: true })

    if (checkForbidden(p)) {
      return setStatus({
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(ratio, quality)

    setBusy(true)
    setStatus({ msg: '正在编辑,通常需要 10–60 秒…', err: false })

    try {
      const fd = new FormData()
      fd.append('model', model)
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
      })
      const originBlob = editFiles[primaryIdx] || null
      const n = await consumeImageResponse(resp, {
        promptText: p,
        size,
        kind: 'edit',
        originBlob,
      })
      if (n > 0) setStatus({ msg: `已生成 ${n} 张`, err: false })
    } catch (e) {
      setStatus({ msg: `请求失败:${e.message}`, err: true })
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id) {
    try {
      await deleteImage(id)
    } catch (e) {
      setStatus({ msg: `删除失败: ${e.message}`, err: true })
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

  function onPromptKeyDown(e) {
    if (e.ctrlKey && e.key === 'Enter') {
      if (mode === 'edit') onEdit()
      else if (mode === 'batch') onBatch()
      else onGenerate()
    }
  }

  function onPickBatchFiles(e) {
    const files = Array.from(e.target.files || [])
    setBatchFiles((prev) => [...prev, ...files])
    e.target.value = ''
  }

  function onRemoveBatchFile(idx) {
    setBatchFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function onClearAllBatch() {
    setBatchFiles([])
  }

  async function onBatch() {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const p = prompt.trim()

    if (!url) return setStatus({ msg: '请填写 Base URL', err: true })
    if (!key) return setStatus({ msg: '请填写 API Key', err: true })
    if (!p) return setStatus({ msg: '请填写风格指令', err: true })
    if (!batchFiles.length)
      return setStatus({ msg: '请上传至少 1 张图片', err: true })

    if (checkForbidden(p)) {
      return setStatus({
        msg: '提示词不符合使用规范,已拒绝生成',
        err: true,
      })
    }

    const size = computeSize(ratio, quality)
    setBusy(true)

    let success = 0
    let fail = 0
    const failures = []

    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i]
      setStatus({
        msg: `批量风格化中 (${i + 1}/${batchFiles.length}) — ${file.name}…`,
        err: false,
      })
      try {
        const fd = new FormData()
        fd.append('model', model)
        fd.append('prompt', p)
        fd.append('size', size)
        fd.append('n', '1')
        fd.append('response_format', 'b64_json')
        fd.append('image', file, file.name)

        const resp = await fetch(`${url}/v1/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: fd,
        })
        const n = await consumeImageResponse(resp, {
          promptText: p,
          size,
          kind: 'edit',
          originBlob: file,
        })
        if (n > 0) success++
        else {
          fail++
          failures.push(file.name)
        }
      } catch (e) {
        fail++
        failures.push(`${file.name} (${e.message})`)
      }
    }

    setStatus({
      msg:
        fail === 0
          ? `批量完成: 成功 ${success} 张`
          : `批量完成: 成功 ${success} / 失败 ${fail}${failures.length ? ` — ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}` : ''}`,
      err: fail > 0,
    })
    setBusy(false)
  }

  function onPickEditFiles(e) {
    const files = Array.from(e.target.files || [])
    setEditFiles((prev) => [...prev, ...files])
    setSelection(null)
    e.target.value = ''
  }

  function onRemoveEditFile(idx) {
    setEditFiles((prev) => prev.filter((_, i) => i !== idx))
    if (idx === primaryIdx) {
      setSelection(null)
      setMaskFile((m) => (m && m.name === 'mask.png' ? null : m))
    }
  }

  function onClearAllEdit() {
    setEditFiles([])
    setSelection(null)
    setMaskFile(null)
  }

  function onPickMask(e) {
    const f = e.target.files?.[0] || null
    setMaskFile(f)
    setSelection(null)
    e.target.value = ''
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
    dragRef.current = p
    setSelection({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  function onSelMove(e) {
    if (!dragRef.current) return
    const p = relPos(e, e.currentTarget)
    const s = dragRef.current
    setSelection({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    })
  }

  async function onSelUp() {
    if (!dragRef.current) return
    dragRef.current = null
    const sel = selection
    const img = primaryImgRef.current
    if (!sel || !img || sel.w < 0.01 || sel.h < 0.01) {
      setSelection(null)
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
    setMaskFile(file)
  }

  function onClearSelection() {
    setSelection(null)
    setMaskFile((m) => (m && m.name === 'mask.png' ? null : m))
  }

  const currentSize = computeSize(ratio, quality)

  return (
    <div className="wrap">
      <header className="site">
        <h1 className="title">GPT-Image-2 生图</h1>
        <div className="sub">填写接口信息与提示词,点击生成即可。</div>
      </header>

      <section className="panel">
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'generate'}
            className={`tab${mode === 'generate' ? ' active' : ''}`}
            onClick={() => setMode('generate')}
          >
            文生图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={`tab${mode === 'edit' ? ' active' : ''}`}
            onClick={() => setMode('edit')}
          >
            图片编辑
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'batch'}
            className={`tab${mode === 'batch' ? ' active' : ''}`}
            onClick={() => setMode('batch')}
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
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </div>

        {mode === 'edit' && (
          <div className="edit-pane">
            <div className="field">
              <div className="edit-pane-head">
                <label htmlFor="editFiles">待编辑图片</label>
                <div className="edit-pane-actions">
                  <label htmlFor="editFiles" className="btn-ghost">
                    {editFiles.length ? '继续添加' : '选择图片(可多选)'}
                  </label>
                  {editFiles.length > 0 && (
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

              {editFiles.length === 0 && (
                <label htmlFor="editFiles" className="upload-drop">
                  <div className="upload-icon">＋</div>
                  <div>点击上传图片(可多张,首张可框选编辑区域)</div>
                </label>
              )}

              {editFiles.length > 0 && (
                <>
                  <div className="edit-thumbs">
                    {editPreviews.map((src, i) => (
                      <div
                        key={src}
                        className={`edit-thumb${i === primaryIdx ? ' is-primary' : ''}`}
                        onClick={() => {
                          setPrimaryIdx(i)
                          setSelection(null)
                        }}
                        title={
                          i === primaryIdx
                            ? '当前主图(可框选)'
                            : '点击设为主图'
                        }
                      >
                        <img src={src} alt="" />
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
                        {i === primaryIdx && (
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
                        src={editPreviews[primaryIdx]}
                        alt="primary"
                        draggable={false}
                      />
                      {selection && (
                        <div
                          className="selection-rect"
                          style={{
                            left: `${selection.x * 100}%`,
                            top: `${selection.y * 100}%`,
                            width: `${selection.w * 100}%`,
                            height: `${selection.h * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    <div className="selection-tip">
                      在主图上拖拽鼠标框选要重绘的区域,生成 mask 透明区供 AI 重画;不框选则整图重绘。
                      {selection && primaryImgRef.current && (
                        <>
                          {' '}
                          已框选 ≈
                          {Math.round(
                            selection.w * primaryImgRef.current.naturalWidth
                          )}
                          ×
                          {Math.round(
                            selection.h * primaryImgRef.current.naturalHeight
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
                  {maskFile && (
                    <button
                      type="button"
                      className="btn-ghost danger"
                      onClick={() => setMaskFile(null)}
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
              {maskPreview && (
                <div className="mask-preview">
                  <img src={maskPreview} alt="mask" />
                  <span className="file-hint">
                    {maskFile?.name === 'mask.png'
                      ? '由框选自动生成(透明区=可编辑)'
                      : maskFile?.name}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {mode === 'batch' && (
          <div className="edit-pane">
            <div className="field">
              <div className="edit-pane-head">
                <label htmlFor="batchFiles">批量输入图片</label>
                <div className="edit-pane-actions">
                  <label htmlFor="batchFiles" className="btn-ghost">
                    {batchFiles.length ? '继续添加' : '选择图片(可多选)'}
                  </label>
                  {batchFiles.length > 0 && (
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

              {batchFiles.length === 0 ? (
                <label htmlFor="batchFiles" className="upload-drop">
                  <div className="upload-icon">＋</div>
                  <div>
                    点击上传多张图片,将依次以同一风格指令重绘,得到 N 张风格化结果
                  </div>
                </label>
              ) : (
                <>
                  <div className="edit-thumbs">
                    {batchPreviews.map((src, i) => (
                      <div key={src} className="edit-thumb">
                        <img src={src} alt="" />
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
                    将对 {batchFiles.length} 张图分别调用编辑接口
                    (串行,每张约 10–60 秒),全部使用同一风格指令。
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="prompt">
            {mode === 'edit'
              ? '编辑指令'
              : mode === 'batch'
                ? '风格指令'
                : '提示词'}
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder={
              mode === 'edit'
                ? '例如:把背景改成日落海边,保持主体不变…(Ctrl+Enter 快速提交)'
                : mode === 'batch'
                  ? '例如:把所有图片转成水彩画风格,温暖色调,保留各自主体…(Ctrl+Enter 快速提交)'
                  : '例如:一只橘猫坐在窗台上,黄昏柔光,电影质感…(Ctrl+Enter 快速提交)'
            }
          />
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="ratio">比例</label>
            <select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
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
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
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
              value={model}
              onChange={(e) => setModel(e.target.value)}
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
            onClick={
              mode === 'edit'
                ? onEdit
                : mode === 'batch'
                  ? onBatch
                  : onGenerate
            }
            disabled={busy}
          >
            {busy
              ? '处理中…'
              : mode === 'edit'
                ? '生成编辑结果'
                : mode === 'batch'
                  ? `批量风格化 (${batchFiles.length} 张)`
                  : '生成图片'}
          </button>
          <div className={`status${status.err ? ' err' : ''}`}>
            {busy && <span className="spinner" />}
            <span>{status.msg}</span>
          </div>
        </div>
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
                onClick={() => onDelete(img.id)}
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
                <a href={img.url} download={`gpt-image-${img.id}.png`}>
                  下载 ↓
                </a>
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
    </div>
  )
}
