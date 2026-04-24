import { useEffect, useRef, useState } from 'react'
import './App.css'
import { checkForbidden } from './moderation'
import {
  MAX_IMAGES,
  addImage,
  b64ToBlob,
  deleteImage,
  listImages,
  urlToBlob,
} from './db'

const STORAGE_KEY = 'gpt2img_cfg_v4'
const DEFAULT_BASE_URL = 'https://api.pubwhere.cn'

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
  const [apiKey, setApiKey] = useState(cfg.apiKey || '')
  const [model, setModel] = useState(cfg.model || 'gpt-image-2')
  const [ratio, setRatio] = useState(cfg.ratio || '1:1')
  const [quality, setQuality] = useState(cfg.quality || '1k')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', err: false })
  const [images, setImages] = useState([])
  const urlsRef = useRef(new Map())

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
        const mapped = rows.map((r) => {
          const url = URL.createObjectURL(r.blob)
          urlsRef.current.set(r.id, url)
          return {
            id: r.id,
            url,
            prompt: r.prompt,
            size: r.size,
            model: r.model,
            createdAt: r.createdAt,
          }
        })
        setImages(mapped)
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
    return () => {
      for (const u of urls.values()) URL.revokeObjectURL(u)
      urls.clear()
    }
  }, [])

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
      const text = await resp.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        setStatus({ msg: `返回不是 JSON: ${text.slice(0, 200)}`, err: true })
        return
      }
      if (!resp.ok) {
        const detail =
          data?.error?.message || data?.message || data?.code || text.slice(0, 200)
        const hint =
          quality === '4k'
            ? '（若为尺寸问题,请尝试 2K/1K）'
            : ''
        setStatus({ msg: `HTTP ${resp.status}: ${detail}${hint}`, err: true })
        return
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
        return
      }

      const saved = []
      for (const blob of blobs) {
        const rec = await addImage({ blob, prompt: p, size, model })
        saved.push(rec)
      }

      const rows = await listImages()
      const kept = new Set(rows.map((r) => r.id))
      for (const [id, u] of urlsRef.current.entries()) {
        if (!kept.has(id)) {
          URL.revokeObjectURL(u)
          urlsRef.current.delete(id)
        }
      }
      setImages(
        rows.map((r) => {
          let url = urlsRef.current.get(r.id)
          if (!url) {
            url = URL.createObjectURL(r.blob)
            urlsRef.current.set(r.id, url)
          }
          return {
            id: r.id,
            url,
            prompt: r.prompt,
            size: r.size,
            model: r.model,
            createdAt: r.createdAt,
          }
        })
      )

      setStatus({ msg: `已生成 ${saved.length} 张`, err: false })
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
    setImages((prev) => prev.filter((img) => img.id !== id))
  }

  function onPromptKeyDown(e) {
    if (e.ctrlKey && e.key === 'Enter') onGenerate()
  }

  const currentSize = computeSize(ratio, quality)

  return (
    <div className="wrap">
      <header className="site">
        <h1 className="title">GPT-Image-2 生图</h1>
        <div className="sub">填写接口信息与提示词,点击生成即可。</div>
      </header>

      <section className="panel">
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

        <div className="field">
          <label htmlFor="prompt">提示词</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder="例如:一只橘猫坐在窗台上,黄昏柔光,电影质感…(Ctrl+Enter 快速提交)"
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
            onClick={onGenerate}
            disabled={busy}
          >
            {busy ? '生成中…' : '生成图片'}
          </button>
          <div className={`status${status.err ? ' err' : ''}`}>
            {busy && <span className="spinner" />}
            <span>{status.msg}</span>
          </div>
        </div>
      </section>

      <div className="gallery-notice">
        画廊仅保存在当前浏览器(最多 {MAX_IMAGES} 张,超出会自动删除最旧的)。清理浏览器数据或更换设备后将丢失。
      </div>

      <section className="grid">
        {images.map((img) => (
          <div className="card" key={img.id}>
            <button
              type="button"
              className="card-del"
              title="删除"
              onClick={() => onDelete(img.id)}
            >
              ×
            </button>
            <img src={img.url} alt={img.prompt} />
            <div className="meta">
              <span className="prompt-hint" title={img.prompt}>
                {img.prompt}
              </span>
              <a href={img.url} download={`gpt-image-${img.id}.png`}>
                下载 ↓
              </a>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
