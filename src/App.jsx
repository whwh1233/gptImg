import { useEffect, useState } from 'react'
import './App.css'
import { checkForbidden } from './moderation'

const STORAGE_KEY = 'gpt2img_cfg_v3'
const DEFAULT_BASE_URL = 'https://api.pubwhere.cn'

const SIZES = [
  { value: '1024x1024', label: '1:1 方形 · 1024×1024' },
  { value: '1536x1024', label: '3:2 横向 · 1536×1024' },
  { value: '1024x1536', label: '2:3 竖向 · 1024×1536' },
  { value: '1792x1024', label: '16:9 宽屏 · 1792×1024' },
  { value: '1024x1792', label: '9:16 竖屏 · 1024×1792' },
  { value: '2048x2048', label: '1:1 · 2K · 2048×2048' },
]

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
  const [size, setSize] = useState(cfg.size || '1024x1024')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', err: false })
  const [images, setImages] = useState([])

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ baseUrl, apiKey, model, size })
    )
  }, [baseUrl, apiKey, model, size])

  async function onGenerate() {
    const url = baseUrl.trim().replace(/\/+$/, '')
    const key = apiKey.trim()
    const p = prompt.trim()

    if (!url) return setStatus({ msg: '请填写 Base URL', err: true })
    if (!key) return setStatus({ msg: '请填写 API Key', err: true })
    if (!p) return setStatus({ msg: '请填写提示词', err: true })

    const hit = checkForbidden(p)
    if (hit) {
      return setStatus({
        msg: `已拒绝:提示词包含${hit.label}相关内容(命中"${hit.keyword}"),请修改后重试`,
        err: true,
      })
    }

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
        setStatus({ msg: `HTTP ${resp.status}: ${detail}`, err: true })
        return
      }
      const items = Array.isArray(data?.data) ? data.data : []
      const newImgs = items
        .map((it) => {
          if (it.b64_json) return { src: `data:image/png;base64,${it.b64_json}`, prompt: p }
          if (it.url) return { src: it.url, prompt: p }
          return null
        })
        .filter(Boolean)
      if (!newImgs.length) {
        setStatus({ msg: '响应中没有图片数据', err: true })
        return
      }
      setImages((prev) => [...newImgs, ...prev])
      setStatus({ msg: `已生成 ${newImgs.length} 张`, err: false })
    } catch (e) {
      setStatus({ msg: `请求失败:${e.message}`, err: true })
    } finally {
      setBusy(false)
    }
  }

  function onPromptKeyDown(e) {
    if (e.ctrlKey && e.key === 'Enter') onGenerate()
  }

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
            <label htmlFor="size">比例 / 尺寸</label>
            <select id="size" value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="model">模型</label>
            <input
              id="model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
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

      <section className="grid">
        {images.map((img, i) => (
          <div className="card" key={img.src.slice(-40) + i}>
            <img src={img.src} alt={img.prompt} />
            <div className="meta">
              <span className="prompt-hint" title={img.prompt}>
                {img.prompt}
              </span>
              <a href={img.src} download={`gpt-image-${Date.now()}.png`}>
                下载 ↓
              </a>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
