# Asset-Fused Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th "素材生图" mode to gptImg that lets users upload assets (logos, QR codes), randomly places them on a base canvas, and uses `/v1/images/edits` with a tight mask so gpt-image-2 generates the surrounding scene while preserving asset pixels exactly.

**Architecture:** B+ approach (mask-locked composite + AI scene fill). Front-end composes a base PNG (white background with assets drawn at random "scene-plausible" anchor positions) plus a mask PNG (alpha-tight per asset, feathered 4 px). Both are sent to OpenAI-style `/v1/images/edits`. The model preserves opaque-mask pixels and inpaints the transparent surroundings according to the user prompt + a fixed English suffix that biases the model toward natural scene integration.

**Tech Stack:** Vite 8 + React 19 + plain JS (no TypeScript). HTML5 Canvas 2D + `getImageData`. Existing `addImage / consumeImageResponse / pushPending / failPending` infra in `src/App.jsx`. No test framework added (project has none today; verification is manual browser/curl as the spec dictates).

**Reference spec:** `docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md`

---

## File Structure

**New files:**
- `src/asset-fusion.js` — pure utility module: position picker, base/mask composers, FormData builder, prompt suffix constant. No React, no DOM dependencies beyond canvas.
- `experiments/preflight-mask-test.html` — standalone one-off page (not part of the Vite build) that runs the two preflight experiments from the spec. Lives outside `src/` so it doesn't ship.

**Modified files:**
- `src/App.jsx` — add `mode: 'assetGen'` support (`makeSession`, `revokeSession`, 4th tab, asset pane UI, `onAssetGen` handler, route in `onSubmitActive`). Add `onPickAssetFiles / onRemoveAsset / onClearAllAssets`. ~200 lines added; the file stays single-file (matches existing convention).
- `src/App.css` — add a small `.asset-thumb` variant block; otherwise reuse `.edit-pane / .edit-thumbs / .upload-drop`.

**Branching (optional but recommended):**
Create a feature branch before Task 1 so the new mode can be reviewed in one PR:
```bash
git checkout -b feat/asset-fusion
```

---

## Task 0: Preflight Verification (Mask Direction + QR Fidelity)

**Why first:** The spec explicitly gates the whole implementation on these two empirical checks. If the proxy returns a wrong-direction mask or fails QR fidelity, the B+ design is dead and we must redesign.

**Files:**
- Create: `experiments/preflight-mask-test.html`

- [ ] **Step 1: Create the preflight HTML**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>asset-fusion preflight</title>
<style>
  body { font: 14px system-ui; padding: 20px; max-width: 900px; margin: 0 auto; }
  fieldset { margin: 12px 0; padding: 12px; }
  input[type=text], input[type=password] { width: 360px; padding: 4px 6px; }
  button { padding: 6px 14px; margin-right: 8px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  .row > div { flex: 1; min-width: 240px; }
  canvas, img { max-width: 100%; border: 1px solid #ccc; display: block; }
  pre { background: #f5f5f5; padding: 8px; max-height: 240px; overflow: auto; }
</style></head>
<body>
<h1>asset-fusion preflight</h1>
<p>Two experiments per <code>docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md</code>.</p>

<fieldset>
  <legend>API</legend>
  Base URL: <input id="base" type="text" value="https://api.pubwhere.cn"><br>
  API Key: <input id="key" type="password" placeholder="sk-..."><br>
  Model: <input id="model" type="text" value="gpt-image-2">
</fieldset>

<fieldset>
  <legend>Experiment 1: mask direction (1024×1024)</legend>
  <p>Base: white left half + black right half. Mask: left half opaque, right half transparent.<br>
     OpenAI convention: <strong>transparent = regenerate, opaque = preserve</strong> →
     left half (opaque mask + white base) should remain WHITE, right half should become a forest.</p>
  <button id="run1">Run experiment 1</button>
  <div class="row">
    <div><h4>base</h4><canvas id="b1" width="1024" height="1024"></canvas></div>
    <div><h4>mask</h4><canvas id="m1" width="1024" height="1024"></canvas></div>
    <div><h4>result</h4><img id="r1" alt=""></div>
  </div>
  <pre id="log1"></pre>
</fieldset>

<fieldset>
  <legend>Experiment 2: QR fidelity (5 shots, 1024×1024)</legend>
  <p>Pick a real scannable QR PNG (e.g. generate one at https://qr.io pointing to any URL). Place it at the bottom-right of a white base, mask its bounding box opaque. Run 5 times with the same prompt. Scan each result with a phone — target ≥ 4/5 pass.</p>
  QR image: <input id="qrfile" type="file" accept="image/png"><br>
  <button id="run2" disabled>Run experiment 2 (5 shots)</button>
  <div id="r2"></div>
  <pre id="log2"></pre>
</fieldset>

<script type="module">
const $ = id => document.getElementById(id);
const log = (el, msg) => { el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; };

function canvasToBlob(c) { return new Promise(res => c.toBlob(res, 'image/png')); }

async function callEdits({ base, mask, prompt, size = '1024x1024' }) {
  const url = $('base').value.trim().replace(/\/+$/, '');
  const key = $('key').value.trim();
  const fd = new FormData();
  fd.append('model', $('model').value.trim());
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('n', '1');
  fd.append('response_format', 'b64_json');
  fd.append('image', base, 'base.png');
  fd.append('mask', mask, 'mask.png');
  const r = await fetch(`${url}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('no b64_json in response');
  return `data:image/png;base64,${b64}`;
}

// experiment 1
$('run1').addEventListener('click', async () => {
  const log1 = $('log1');
  log1.textContent = '';
  const b = $('b1').getContext('2d');
  b.fillStyle = '#fff'; b.fillRect(0, 0, 512, 1024);
  b.fillStyle = '#000'; b.fillRect(512, 0, 512, 1024);
  const m = $('m1').getContext('2d');
  m.clearRect(0, 0, 1024, 1024);                  // start fully transparent
  m.fillStyle = 'rgba(255,255,255,1)'; m.fillRect(0, 0, 512, 1024); // left = opaque
  // right half stays transparent (will be regenerated)
  try {
    const baseBlob = await canvasToBlob($('b1'));
    const maskBlob = await canvasToBlob($('m1'));
    log(log1, 'submitting...');
    const url = await callEdits({ base: baseBlob, mask: maskBlob, prompt: 'a forest scene with sunlight' });
    $('r1').src = url;
    log(log1, 'done. inspect: left half should still be WHITE; right half should be forest.');
  } catch (e) { log(log1, 'ERROR ' + e.message); }
});

// experiment 2
let qrImg = null;
$('qrfile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  qrImg = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = URL.createObjectURL(f); });
  $('run2').disabled = false;
});
$('run2').addEventListener('click', async () => {
  const log2 = $('log2'); log2.textContent = ''; $('r2').innerHTML = '';
  // pick a fixed QR size + position: 200x200 at bottom-right with 60px margin
  const W = 1024, H = 1024, qrSize = 200, mx = 60;
  for (let i = 1; i <= 5; i++) {
    const baseC = new OffscreenCanvas(W, H);
    const bx = baseC.getContext('2d');
    bx.fillStyle = '#fff'; bx.fillRect(0, 0, W, H);
    bx.drawImage(qrImg, W - qrSize - mx, H - qrSize - mx, qrSize, qrSize);
    const maskC = new OffscreenCanvas(W, H);
    const mx2 = maskC.getContext('2d');
    mx2.clearRect(0, 0, W, H);
    mx2.fillStyle = 'rgba(255,255,255,1)';
    mx2.fillRect(W - qrSize - mx, H - qrSize - mx, qrSize, qrSize);
    const baseBlob = await baseC.convertToBlob({ type: 'image/png' });
    const maskBlob = await maskC.convertToBlob({ type: 'image/png' });
    try {
      log(log2, `shot ${i}: submitting...`);
      const url = await callEdits({ base: baseBlob, mask: maskBlob, prompt: 'a coffee shop window at dusk, warm lights, brick wall' });
      const img = new Image(); img.src = url; img.style.width = '180px'; img.style.margin = '4px';
      $('r2').appendChild(img);
      log(log2, `shot ${i}: done`);
    } catch (e) { log(log2, `shot ${i}: ERROR ${e.message}`); }
  }
  log(log2, 'now scan the bottom-right of each result with your phone — target ≥ 4/5 pass.');
});
</script>
</body>
</html>
```

- [ ] **Step 2: Open the page and run experiment 1**

```bash
# in a separate terminal:
cd /Users/wh/person/station/gptImg
python3 -m http.server 8765
# then open http://localhost:8765/experiments/preflight-mask-test.html
```

Fill API key (the same one used by `.env.local`), click "Run experiment 1".

**Expected:** result image has WHITE left half (opaque mask preserved the white base) and a FOREST in the right half (transparent mask region was regenerated).

**Failure modes:**
- Left half becomes forest, right half stays white/black → mask convention is REVERSED for this proxy. Document, then in Task 5 swap the alpha values in `composeMask`.
- Whole image regenerated (left half also forest) → proxy/model ignores mask entirely. **HALT** and report back; the B+ approach can't proceed; we need to revisit the spec.

- [ ] **Step 3: Run experiment 2 (QR fidelity)**

Generate a real scannable QR (use https://qr.io or `qrencode` on the CLI) pointing to any URL, save as PNG, upload via the file input. Click "Run experiment 2 (5 shots)".

Wait for all 5 to finish. **Scan the bottom-right area of each result with your phone's camera.**

**Pass:** ≥ 4/5 scan to the original URL.

**Fail:** < 4/5 → gpt-image-2 is not absolutely faithful even with mask. **HALT** and report back; the design needs the mixed fallback (QR forced through Canvas overlay), which requires re-confirming with the user before continuing.

- [ ] **Step 4: Document findings and commit the experiment file**

Add a short note at the top of the spec (`docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md`) under a new `## 验证结果` section:
```markdown
## 验证结果 (YYYY-MM-DD)

- 实验 1（mask 方向）：通过 / 反向 / 失败 — 备注
- 实验 2（QR 扫描率）：N/5 通过 — 备注
```

Then commit:
```bash
git add experiments/preflight-mask-test.html docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md
git commit -m "preflight: verify gpt-image-2 mask direction and QR fidelity for B+"
```

**Gate:** only proceed to Task 1 if both experiments pass. If experiment 1 reverses, note it; Task 5 will swap the alpha. If experiment 2 fails, stop and report.

---

## Task 1: Add `assetGen` Mode Skeleton (4th Tab + Empty Pane)

**Files:**
- Modify: `src/App.jsx:107-129` (`makeSession`)
- Modify: `src/App.jsx:131-135` (`revokeSession`)
- Modify: `src/App.jsx:1075-1103` (mode tabs JSX)
- Modify: `src/App.jsx:690-695` (`onSubmitActive`)

- [ ] **Step 1: Extend `makeSession` to include `assetItems`**

Find the existing `makeSession` (around line 107) and add `assetItems: []` to the returned object:

```js
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
    assetItems: [],
    status: { msg: '', err: false },
  }
}
```

- [ ] **Step 2: Extend `revokeSession` to release asset URLs**

```js
function revokeSession(s) {
  for (const it of s.editItems) URL.revokeObjectURL(it.url)
  for (const it of s.batchItems) URL.revokeObjectURL(it.url)
  for (const it of s.assetItems) URL.revokeObjectURL(it.url)
  if (s.mask?.url) URL.revokeObjectURL(s.mask.url)
}
```

- [ ] **Step 3: Add the 4th tab in the tabs JSX**

Inside the existing `<div className="tabs" role="tablist">` block (around line 1075), add a 4th button after the 批量风格化 button:

```jsx
<button
  type="button"
  role="tab"
  aria-selected={active.mode === 'assetGen'}
  className={`tab${active.mode === 'assetGen' ? ' active' : ''}`}
  onClick={() => updateActive({ mode: 'assetGen' })}
>
  素材生图
</button>
```

- [ ] **Step 4: Stub the route in `onSubmitActive`**

Update `onSubmitActive` (around line 690) so the new mode is recognized but not yet wired:

```js
function onSubmitActive() {
  if (!active) return
  if (active.mode === 'edit') onEdit(active.id)
  else if (active.mode === 'batch') onBatch(active.id)
  else if (active.mode === 'assetGen') onAssetGen(active.id)
  else onGenerate(active.id)
}
```

(`onAssetGen` is added in Task 6; for now leave the reference — JS will not error until the user clicks generate in this mode, which they shouldn't yet because the pane is empty.)

- [ ] **Step 5: Add an empty placeholder pane**

Find the `{active.mode === 'edit' && (` block (around line 1149) and add a new sibling block right after the batch pane (find by searching for `'batch' &&`):

```jsx
{active.mode === 'assetGen' && (
  <div className="asset-pane">
    <div className="field">
      <label>素材</label>
      <div className="muted" style={{ padding: '12px 0' }}>
        素材上传 UI 即将到位（Task 2）
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 6: Verify in browser**

```bash
source ~/.nvm/nvm.sh && nvm use 22 && npm run dev
```
Open http://localhost:5173. Expected:
- Mode tabs now show 4 tabs ending in 「素材生图」
- Click 素材生图 → see the placeholder text
- Other tabs (文生图 / 图片编辑 / 批量风格化) still render their original UI unchanged
- No console errors

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(asset-gen): add assetGen mode skeleton (4th tab + placeholder pane)"
```

---

## Task 2: Asset Upload UI (Multi-File Picker, Thumbnails, Remove)

**Files:**
- Modify: `src/App.jsx` — add three handlers + replace placeholder pane content
- Modify: `src/App.css` — add `.asset-pane / .asset-thumbs / .asset-thumb` (or reuse edit ones)

- [ ] **Step 1: Add asset handlers in App.jsx**

Place these near the other file handlers (search for `onPickEditFiles` for the existing pattern). Cap at 5 items per spec.

```js
const ASSET_LIMIT = 5

function onPickAssetFiles(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  const existing = active.assetItems
  const room = ASSET_LIMIT - existing.length
  if (room <= 0) {
    setSessionStatus(active.id, { msg: `素材数量已达上限 ${ASSET_LIMIT}`, err: true })
    e.target.value = ''
    return
  }
  const picked = files.slice(0, room).map((f) => ({
    file: f,
    url: URL.createObjectURL(f),
    name: f.name,
  }))
  updateActive({ assetItems: [...existing, ...picked] })
  e.target.value = ''
  if (files.length > room) {
    setSessionStatus(active.id, {
      msg: `仅添加了前 ${room} 张，已达上限 ${ASSET_LIMIT}`,
      err: false,
    })
  }
}

function onRemoveAsset(idx) {
  const items = active.assetItems
  const it = items[idx]
  if (!it) return
  URL.revokeObjectURL(it.url)
  updateActive({ assetItems: items.filter((_, i) => i !== idx) })
}

function onClearAllAssets() {
  for (const it of active.assetItems) URL.revokeObjectURL(it.url)
  updateActive({ assetItems: [] })
}
```

- [ ] **Step 2: Replace the placeholder pane with the real UI**

Replace the entire `{active.mode === 'assetGen' && (...)}` block from Task 1 with:

```jsx
{active.mode === 'assetGen' && (
  <div className="asset-pane">
    <div className="field">
      <div className="edit-pane-head">
        <label htmlFor="assetFiles">素材（logo / 二维码，最多 {ASSET_LIMIT} 张）</label>
        <div className="edit-pane-actions">
          <label htmlFor="assetFiles" className="btn-ghost">
            {active.assetItems.length ? '继续添加' : '选择素材(可多选)'}
          </label>
          {active.assetItems.length > 0 && (
            <button
              type="button"
              className="btn-ghost danger"
              onClick={onClearAllAssets}
            >
              全部清除
            </button>
          )}
          <input
            id="assetFiles"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={onPickAssetFiles}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      {active.assetItems.length === 0 && (
        <label htmlFor="assetFiles" className="upload-drop">
          <div className="upload-icon">＋</div>
          <div>点击上传素材（PNG/JPG/WebP，建议带透明背景的 PNG 融合更自然）</div>
        </label>
      )}

      {active.assetItems.length > 0 && (
        <div className="asset-thumbs">
          {active.assetItems.map((it, i) => (
            <div key={it.url} className="asset-thumb">
              <img src={it.url} alt={it.name} title={it.name} />
              <button
                type="button"
                className="thumb-del"
                onClick={() => onRemoveAsset(i)}
                aria-label="移除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 3: Add minimal CSS**

Append to `src/App.css`:

```css
.asset-pane { margin-top: 12px; }
.asset-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.asset-thumb {
  position: relative;
  width: 96px;
  height: 96px;
  border: 1px solid var(--border, #2a2a3e);
  border-radius: 6px;
  overflow: hidden;
  background: repeating-conic-gradient(#1a1a2e 0% 25%, #222 0% 50%) 50% / 16px 16px;
}
.asset-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.asset-thumb .thumb-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
```

(Note: the checkered background pattern makes alpha-channel logos visually obvious.)

- [ ] **Step 4: Verify in browser**

Refresh http://localhost:5173. Switch to 素材生图 tab. Test:
- Click upload area → pick 3 PNG files → see 3 thumbs (transparent areas show as checkered)
- Click 「继续添加」 → pick 4 more → only 2 added, status shows "仅添加了前 2 张，已达上限 5"
- Click × on a thumb → it disappears
- Click 「全部清除」 → all gone, upload area returns

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/App.css
git commit -m "feat(asset-gen): asset upload UI with multi-file picker, thumbs, 5-item cap"
```

---

## Task 3: Implement `pickPositions` (Smart Random Placement) — Pure Function

**Files:**
- Create: `src/asset-fusion.js`

- [ ] **Step 1: Create the module with `pickPositions`**

```js
// src/asset-fusion.js
//
// Pure utilities for the assetGen mode. No React, no DOM globals beyond canvas.
// All functions are deterministic given their inputs (except where they take a
// random source, which is the global Math.random by default).

export const ASSET_FUSION_SUFFIX =
  '\n\nThe composition contains fixed visual elements (logos, codes, marks) ' +
  'that must appear as natural parts of the scene — printed on signs, posters, ' +
  'screens, packaging, fabric, walls, or other surfaces — with believable ' +
  'lighting, shadow, perspective, and surrounding materials. Build the scene to ' +
  'contextualize and integrate them.'

const ANCHORS = [
  { ax: 0.10, ay: 0.10 }, // top-left
  { ax: 0.50, ay: 0.10 }, // top-center
  { ax: 0.90, ay: 0.10 }, // top-right
  { ax: 0.10, ay: 0.50 }, // mid-left
  { ax: 0.90, ay: 0.50 }, // mid-right
  { ax: 0.10, ay: 0.90 }, // bottom-left
  { ax: 0.50, ay: 0.90 }, // bottom-center
  { ax: 0.90, ay: 0.90 }, // bottom-right
]

// Center-avoidance rect (40% × 40% centered). Asset bbox center must NOT fall
// inside this rect after jitter — keeps the model's main subject area free.
function inForbiddenCenter(cx, cy, W, H) {
  return cx > W * 0.30 && cx < W * 0.70 && cy > H * 0.30 && cy < H * 0.70
}

function rectsOverlapFrac(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  const minArea = Math.min(a.w * a.h, b.w * b.h)
  return inter / minArea
}

/**
 * Pick a {x, y, w, h} for each asset.
 *
 * @param {number} W canvas width
 * @param {number} H canvas height
 * @param {Array<{naturalWidth:number, naturalHeight:number}>} assets
 * @param {object} [opts]
 * @param {number} [opts.maxLongEdgeFrac=0.15] longest edge of asset = this * min(W,H)
 * @param {number} [opts.marginFrac=0.04] keep-out from canvas edges = this * min(W,H)
 * @param {number} [opts.jitterFrac=0.05] anchor jitter range
 * @param {number} [opts.maxAttempts=8] retries per asset
 * @param {() => number} [opts.rng=Math.random]
 * @returns {Array<{x:number, y:number, w:number, h:number}>} same length as assets
 */
export function pickPositions(W, H, assets, opts = {}) {
  const {
    maxLongEdgeFrac = 0.15,
    marginFrac = 0.04,
    jitterFrac = 0.05,
    maxAttempts = 8,
    rng = Math.random,
  } = opts

  const minSide = Math.min(W, H)
  const margin = minSide * marginFrac
  const longEdgeMax = minSide * maxLongEdgeFrac

  // Shuffle anchor pool so the first asset doesn't always land top-left.
  const pool = [...ANCHORS]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }

  const placed = []

  for (let idx = 0; idx < assets.length; idx++) {
    const a = assets[idx]
    const longest = Math.max(a.naturalWidth, a.naturalHeight) || 1
    const scale = longEdgeMax / longest
    const w = Math.round(a.naturalWidth * scale)
    const h = Math.round(a.naturalHeight * scale)

    let chosen = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const anchor = pool[(idx + attempt) % pool.length]
      const jitterX = (rng() - 0.5) * 2 * jitterFrac * W
      const jitterY = (rng() - 0.5) * 2 * jitterFrac * H
      const cx = anchor.ax * W + jitterX
      const cy = anchor.ay * H + jitterY
      let x = Math.round(cx - w / 2)
      let y = Math.round(cy - h / 2)
      // clamp to margin
      x = Math.max(margin, Math.min(W - margin - w, x))
      y = Math.max(margin, Math.min(H - margin - h, y))
      const rect = { x, y, w, h }
      const ccx = x + w / 2
      const ccy = y + h / 2
      if (inForbiddenCenter(ccx, ccy, W, H)) continue
      const collides = placed.some((p) => rectsOverlapFrac(p, rect) > 0.20)
      if (collides) continue
      chosen = rect
      break
    }
    if (!chosen) {
      // fallback: place in the next anchor regardless of constraints
      const anchor = pool[idx % pool.length]
      let x = Math.round(anchor.ax * W - w / 2)
      let y = Math.round(anchor.ay * H - h / 2)
      x = Math.max(margin, Math.min(W - margin - w, x))
      y = Math.max(margin, Math.min(H - margin - h, y))
      chosen = { x, y, w, h }
    }
    placed.push(chosen)
  }

  return placed
}
```

- [ ] **Step 2: Verify in browser console**

In the running dev server, open DevTools console on http://localhost:5173 and paste:

```js
const af = await import('/src/asset-fusion.js')
const fakeAssets = [
  { naturalWidth: 200, naturalHeight: 200 },
  { naturalWidth: 400, naturalHeight: 100 },
  { naturalWidth: 150, naturalHeight: 300 },
]
console.table(af.pickPositions(1024, 1024, fakeAssets))
```

**Expected:** 3 rectangles, all within `[0, 1024]`, longest dimension ≈ 153 (= 1024 × 0.15), no rect's center is inside `[307, 717]` × `[307, 717]` (the 40% center band). Run it 5 times — positions vary but stay inside the 8 anchor zones.

- [ ] **Step 3: Commit**

```bash
git add src/asset-fusion.js
git commit -m "feat(asset-fusion): pickPositions (smart random with 8 anchors + center avoidance)"
```

---

## Task 4: Implement `composeBaseCanvas` and Asset Loading

**Files:**
- Modify: `src/asset-fusion.js`

- [ ] **Step 1: Add `loadAssetItem` and `composeBaseCanvas`**

Append to `src/asset-fusion.js`:

```js
/**
 * Decode a File into an HTMLImageElement and detect whether it has a real
 * alpha channel (any pixel with alpha < 250 in a 64×64 sample).
 *
 * @param {File} file
 * @returns {Promise<{file:File, name:string, image:HTMLImageElement, naturalWidth:number, naturalHeight:number, hasAlpha:boolean}>}
 */
export async function loadAssetItem(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`图片解码失败: ${file.name}`))
      img.src = url
    })
    // sample alpha
    const sample = document.createElement('canvas')
    const SX = 64
    sample.width = SX
    sample.height = SX
    const sx = sample.getContext('2d')
    sx.drawImage(image, 0, 0, SX, SX)
    const data = sx.getImageData(0, 0, SX, SX).data
    let hasAlpha = false
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) { hasAlpha = true; break }
    }
    return {
      file,
      name: file.name,
      image,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      hasAlpha,
    }
  } finally {
    // image keeps its own reference; safe to revoke object URL
    URL.revokeObjectURL(url)
  }
}

/**
 * Build a white-background base canvas with each asset drawn at its rect.
 *
 * @param {number} W
 * @param {number} H
 * @param {Array<{image:HTMLImageElement}>} assets
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Promise<Blob>} PNG blob
 */
export async function composeBaseCanvas(W, H, assets, rects) {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < assets.length; i++) {
    const { image } = assets[i]
    const r = rects[i]
    ctx.drawImage(image, r.x, r.y, r.w, r.h)
  }
  return await new Promise((res) => canvas.toBlob(res, 'image/png'))
}
```

- [ ] **Step 2: Verify in browser console**

Open the running dev server, switch to 素材生图 tab, upload a PNG with transparency. In DevTools console:

```js
const af = await import('/src/asset-fusion.js')
// grab the file via React state isn't trivial — use the file picker instead:
const input = document.createElement('input')
input.type = 'file'; input.accept = 'image/*'
document.body.appendChild(input)
input.click()
// after picking a file:
input.addEventListener('change', async () => {
  const f = input.files[0]
  const item = await af.loadAssetItem(f)
  console.log('hasAlpha:', item.hasAlpha, 'size:', item.naturalWidth, '×', item.naturalHeight)
  const rects = af.pickPositions(1024, 1024, [item])
  const blob = await af.composeBaseCanvas(1024, 1024, [item], rects)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = 'base.png'; a.click()
  input.remove()
})
```

**Expected:** downloads `base.png` (1024×1024 white background with the asset placed at one of the 8 anchor positions). Open it in Preview/Finder to eyeball.

- [ ] **Step 3: Commit**

```bash
git add src/asset-fusion.js
git commit -m "feat(asset-fusion): loadAssetItem (alpha detection) + composeBaseCanvas"
```

---

## Task 5: Implement `composeMask` (Alpha-Tight + 4 px Feather)

**Files:**
- Modify: `src/asset-fusion.js`

- [ ] **Step 1: Add `composeMask`**

Append to `src/asset-fusion.js`:

```js
/**
 * Build the OpenAI-edits mask. Convention: opaque (alpha = 255) regions are
 * preserved; transparent regions are regenerated.
 *
 * For each asset:
 *   - If hasAlpha=true → draw the asset (scaled to rect) and use its own alpha
 *     channel as the mask shape (so non-logo pixels get regenerated, e.g. the
 *     model can paint the surface around the logo's actual silhouette).
 *   - If hasAlpha=false → fill the asset rect with opaque white (whole rect
 *     preserved, e.g. for square QR codes).
 *
 * A 4 px CSS blur on the drawing context produces a soft alpha edge so the
 * model has some room to blend transitions. If the proxy rejects grayscale
 * masks, set opts.feather = 0 and rerun.
 *
 * @param {number} W
 * @param {number} H
 * @param {Array<{image:HTMLImageElement, hasAlpha:boolean}>} assets
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @param {object} [opts]
 * @param {number} [opts.feather=4] blur radius in px
 * @param {boolean} [opts.invert=false] set true if the proxy reverses mask convention
 * @returns {Promise<Blob>} PNG blob
 */
export async function composeMask(W, H, assets, rects, opts = {}) {
  const { feather = 4, invert = false } = opts

  // Step 1: build a "preserve" canvas — opaque where we want to preserve.
  const preserve = document.createElement('canvas')
  preserve.width = W
  preserve.height = H
  const px = preserve.getContext('2d')
  // start fully transparent
  px.clearRect(0, 0, W, H)

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i]
    const r = rects[i]
    if (a.hasAlpha) {
      // draw the asset itself; its own alpha channel becomes the preserve shape
      px.save()
      if (feather > 0) px.filter = `blur(${feather}px)`
      px.drawImage(a.image, r.x, r.y, r.w, r.h)
      px.restore()
    } else {
      px.save()
      if (feather > 0) px.filter = `blur(${feather}px)`
      px.fillStyle = 'rgba(255,255,255,1)'
      px.fillRect(r.x, r.y, r.w, r.h)
      px.restore()
    }
  }

  // Step 2: convert to a mask PNG. The mask alpha follows the rule below:
  //   default convention (OpenAI):  preserve = opaque, regenerate = transparent
  //   inverted convention:          preserve = transparent, regenerate = opaque
  //
  // The "preserve" canvas already holds the right alpha for the default case;
  // for inverted we just XOR the alpha.
  const out = document.createElement('canvas')
  out.width = W
  out.height = H
  const ox = out.getContext('2d')
  ox.drawImage(preserve, 0, 0)

  if (invert) {
    const img = ox.getImageData(0, 0, W, H)
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255 - img.data[i]
    ox.putImageData(img, 0, 0)
  }

  // Note: also normalize RGB to white so the mask file is a clean white-on-alpha.
  // Some inspectors render alpha-only PNGs oddly; explicit white helps debug.
  const norm = ox.getImageData(0, 0, W, H)
  for (let i = 0; i < norm.data.length; i += 4) {
    if (norm.data[i + 3] > 0) {
      norm.data[i] = 255
      norm.data[i + 1] = 255
      norm.data[i + 2] = 255
    }
  }
  ox.putImageData(norm, 0, 0)

  return await new Promise((res) => out.toBlob(res, 'image/png'))
}
```

- [ ] **Step 2: Verify in browser console**

Same dev server. In DevTools console:

```js
const af = await import('/src/asset-fusion.js')
const input = document.createElement('input')
input.type = 'file'; input.accept = 'image/*'; input.click()
input.addEventListener('change', async () => {
  const item = await af.loadAssetItem(input.files[0])
  const rects = af.pickPositions(1024, 1024, [item])
  const mask = await af.composeMask(1024, 1024, [item], rects)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(mask); a.download = 'mask.png'; a.click()
})
```

Open `mask.png`. **Expected:**
- For a transparent-PNG logo: mask shows the logo's silhouette as soft white-on-transparent
- For an opaque PNG (e.g. JPG of a QR): mask shows a soft-edged white rectangle
- Edge has a visible ~4 px alpha gradient

- [ ] **Step 3: Add the FormData builder**

Append to `src/asset-fusion.js`:

```js
/**
 * Compose the FormData payload for /v1/images/edits.
 */
export function buildAssetGenFormData({ model, prompt, size, baseBlob, maskBlob }) {
  const fd = new FormData()
  fd.append('model', model)
  fd.append('prompt', prompt + ASSET_FUSION_SUFFIX)
  fd.append('size', size)
  fd.append('n', '1')
  fd.append('response_format', 'b64_json')
  fd.append('image', baseBlob, 'base.png')
  fd.append('mask', maskBlob, 'mask.png')
  return fd
}
```

- [ ] **Step 4: Commit**

```bash
git add src/asset-fusion.js
git commit -m "feat(asset-fusion): composeMask (alpha-tight + 4px feather, invert opt) + FormData builder"
```

---

## Task 6: Wire `onAssetGen` Handler (End-to-End)

**Files:**
- Modify: `src/App.jsx` — import asset-fusion, add `onAssetGen` handler

- [ ] **Step 1: Import the asset-fusion utilities**

At the top of `src/App.jsx`, near the existing imports:

```js
import {
  buildAssetGenFormData,
  composeBaseCanvas,
  composeMask,
  loadAssetItem,
  pickPositions,
} from './asset-fusion'
```

- [ ] **Step 2: Add the `onAssetGen` handler**

Place it next to `onGenerate / onEdit / onBatch` in App.jsx. The structure mirrors `onEdit` (FormData POST, AbortController, pending card with previewUrl). Asset preflight is done via `loadAssetItem` so we know `naturalWidth/Height/hasAlpha` for placement.

```js
async function onAssetGen(sid) {
  const url = baseUrl.trim().replace(/\/+$/, '')
  const key = apiKey.trim()
  const s = sessionsRef.current.find((x) => x.id === sid)
  if (!s) return
  const p = s.prompt.trim()

  if (!url) return setSessionStatus(sid, { msg: '请填写 Base URL', err: true })
  if (!key) return setSessionStatus(sid, { msg: '请填写 API Key', err: true })
  if (!p) return setSessionStatus(sid, { msg: '请填写提示词', err: true })
  if (!s.assetItems.length)
    return setSessionStatus(sid, { msg: '请上传至少 1 张素材', err: true })

  if (checkForbidden(p)) {
    return setSessionStatus(sid, {
      msg: '提示词不符合使用规范,已拒绝生成',
      err: true,
    })
  }

  const size = computeSize(s.ratio, s.quality)
  const [W, H] = size.split('x').map(Number)
  const modelUsed = s.model
  const qualityUsed = s.quality

  setSessionStatus(sid, { msg: '已提交,合成 base + mask…', err: false })
  const controller = new AbortController()
  const pkey = pushPending(
    { sid, kind: 'asset-gen', prompt: p, label: '素材生图中' },
    controller
  )

  let previewUrl = null
  try {
    // 1. decode each asset (HTMLImage + alpha detection)
    const decoded = await Promise.all(s.assetItems.map((it) => loadAssetItem(it.file)))

    // 2. pick positions, build base + mask
    const rects = pickPositions(W, H, decoded)
    const baseBlob = await composeBaseCanvas(W, H, decoded, rects)
    const maskBlob = await composeMask(W, H, decoded, rects)
    previewUrl = URL.createObjectURL(baseBlob)
    patchPending(pkey, { previewUrl, label: '请求模型中' })
    setSessionStatus(sid, { msg: '已提交,生成中…', err: false })

    // 3. POST /v1/images/edits
    const fd = buildAssetGenFormData({
      model: modelUsed,
      prompt: p,
      size,
      baseBlob,
      maskBlob,
    })
    const resp = await fetch(`${url}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: controller.signal,
    })

    // 4. consume response (stores into IndexedDB gallery, originBlob = base for debugging)
    const { count, errorMsg } = await consumeImageResponse(resp, {
      sid,
      promptText: p,
      size,
      kind: 'asset-gen',
      originBlob: baseBlob,
      modelUsed,
      qualityUsed,
    })
    if (count > 0) {
      setSessionStatus(sid, { msg: `已生成 ${count} 张`, err: false })
      popPending(pkey)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    } else {
      failPending(pkey, errorMsg || '未知错误')
      // keep previewUrl alive on the failed card; revoke on dismiss
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
```

(Note: if Task 0 found the proxy reverses mask direction, change `composeMask(W, H, decoded, rects)` to `composeMask(W, H, decoded, rects, { invert: true })`.)

- [ ] **Step 3: Verify end-to-end in browser**

Refresh dev server. In 素材生图 tab:
1. Upload one logo (PNG with alpha if possible) and one QR
2. Set ratio = 1:1, quality = 1k, model = gpt-image-2
3. Prompt: `咖啡馆橱窗角落，黄昏暖光，木质桌面`
4. Click 生成

**Expected:**
- Pending card shows "素材生图中" then "请求模型中" with a preview of the composed base
- After ~10-30s, result appears in gallery
- Result image: scene rendered around the logo and QR; logo+QR pixels intact
- Click result, zoom in: pixel fidelity in asset regions

If the result is wholly regenerated (assets gone) → mask convention is reversed. Re-run Task 0 experiment 1 to confirm, then add `{ invert: true }` to the `composeMask` call.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(asset-gen): onAssetGen handler — compose base+mask, POST edits, integrate gallery"
```

---

## Task 7: Acceptance Verification (5-Shot Validation)

**Files:** none (manual run + record findings in spec)

- [ ] **Step 1: Prepare a fixed test set**

Pick:
- 1 logo PNG with transparent background (your company brand or any)
- 1 QR code PNG that points to a known URL (you'll scan it)
- 1 prompt: `户外品牌活动现场，下午阳光，模特手持饮料，背景是白色帐篷` (or pick your own — note it down)

- [ ] **Step 2: Run 5 generations**

In 素材生图 tab, upload the 2 assets and the prompt. Click 生成 5 times sequentially (wait between to avoid rate limits).

- [ ] **Step 3: Pixel fidelity check**

For each result, open it in the gallery. Save it locally. Compare with the composed base (also saved as `originBlob` — accessible by clicking the result card → originUrl). In DevTools console on the result image:

```js
async function diff(aUrl, bUrl) {
  const [aImg, bImg] = await Promise.all([aUrl, bUrl].map(u => new Promise(r => {
    const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => r(i); i.src = u
  })))
  const c = document.createElement('canvas'); c.width = aImg.width; c.height = aImg.height
  const x = c.getContext('2d')
  x.drawImage(aImg, 0, 0)
  const aData = x.getImageData(0, 0, c.width, c.height).data
  x.drawImage(bImg, 0, 0)
  const bData = x.getImageData(0, 0, c.width, c.height).data
  let diff = 0
  for (let i = 0; i < aData.length; i++) diff += Math.abs(aData[i] - bData[i])
  return diff / (c.width * c.height)
}
```

Apply only to the asset bounding boxes. Acceptance: average per-pixel diff inside asset boxes should be effectively 0 (any diff > 5 indicates the model touched protected pixels — debug).

- [ ] **Step 4: QR scannability check**

Scan the QR region of each of the 5 results with your phone camera. Acceptance: ≥ 4/5 scan to the correct URL.

- [ ] **Step 5: Logo fusion subjective check**

Eyeball the 5 results. Acceptance: ≥ 3/5 look "painted into the scene" (edge shadows, surface continuity, not floating).

- [ ] **Step 6: Tune if needed**

If any criterion misses, try in this order:

1. QR scan rate < 4/5 → set `composeMask(..., { feather: 0 })` to use a hard mask edge (some models honor binary masks better than grayscale). Re-run.
2. Logo fusion < 3/5 → try `feather: 8` instead of 4; also try moving anchor pool to favor edges over corners (edit `ANCHORS` in `asset-fusion.js`).
3. Pixel diff > 5 inside asset region → mask is being honored "softly"; reduce feather to 0 and inspect again.

- [ ] **Step 7: Record results in the spec**

Append to `docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md` under `## 验证结果`:

```markdown
### 验收 (YYYY-MM-DD)
- 像素保真：avg diff = X
- QR 扫描：N/5
- logo 融合：N/5
- 调参：feather = ..., 其它备注
```

Commit:

```bash
git add docs/superpowers/specs/2026-05-06-asset-fused-image-gen-design.md
git commit -m "docs(asset-fusion): record MVP acceptance results"
```

---

## Task 8: Open the PR (or Push)

- [ ] **Step 1: Push the feature branch (if you used one)**

```bash
git push -u origin feat/asset-fusion
```

- [ ] **Step 2: Open a PR via gh, or merge to main if solo**

```bash
# PR route:
gh pr create --title "feat(asset-gen): asset-fused image generation (MVP)" \
  --body "$(cat <<'EOF'
## Summary
- New "素材生图" mode (4th tab) using B+ approach: mask-locked composite + AI scene fill
- gpt-image-2 preserves logo/QR pixels via tight alpha mask, generates the scene around them
- Random placement (8 anchor zones with center-avoidance), 5-asset cap, in-memory only

## Test plan
- [ ] Preflight experiments pass (mask direction, QR fidelity ≥4/5)
- [ ] Upload assets, generate 5 shots, scan QR
- [ ] Pixel diff in asset boxes ≈ 0
- [ ] Other modes (文生图/图片编辑/批量风格化) still work unchanged

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Covered by |
|---|---|
| 「方案选型 B+」 | Tasks 4–6 (compose base + tight mask + edits POST) |
| 「MVP 范围」做/不做 | Tasks 1–6 (mode tab, multi-file upload, random place, mask, suffix, gallery integration); zip / persistence / drag explicitly absent |
| 「入口：第 4 个 mode」 | Task 1 |
| 「assetItems session 字段」 | Task 1 step 1 |
| 「生成流水线 1–9」 | Task 6 step 2 (full handler) |
| 「智能随机位置 + 8 anchor」 | Task 3 |
| 「紧贴形状 mask」 | Task 5 (alpha-channel branch in `composeMask`) |
| 「mask 边缘 4 px 羽化」 | Task 5 (`feather` opt, default 4) |
| 「prompt 自动追加 suffix」 | Task 5 step 3 (`buildAssetGenFormData` appends `ASSET_FUSION_SUFFIX`) |
| 「素材数量上限 5」 | Task 2 (`ASSET_LIMIT`) |
| 「kind = 'asset-gen', originBlob = composed base」 | Task 6 (consumeImageResponse args) |
| 「错误/取消/pending 复用」 | Task 6 (mirrors `onEdit` shape) |
| 「实现前两个验证实验」 | Task 0 |
| 「验收标准 5 张验证」 | Task 7 |
| 「代理 mask 反向风险 → 翻转涂色」 | Task 5 `invert` opt + Task 6 step 2 note |
| 「灰度 mask 不支持 → 退回硬边」 | Task 7 step 6 (set `feather: 0`) |
| 「QR 扫不通 → 降级讨论」 | Task 0 step 3 (HALT) |

No spec items left without a task.

**2. Placeholder scan**

- No "TBD/TODO/implement later" anywhere in the steps
- Every code block is concrete and complete; no "similar to Task N" without re-stating
- Manual verification steps (browser console) include the exact snippet to paste
- Task 0 includes the entire preflight HTML inline; engineer doesn't need to invent it

**3. Type/signature consistency**

- `loadAssetItem(file)` returns object containing `{image, naturalWidth, naturalHeight, hasAlpha}` — used by `pickPositions` (which only reads `naturalWidth/Height`), `composeBaseCanvas` (reads `image`), and `composeMask` (reads `image`, `hasAlpha`). All consistent.
- `pickPositions` returns `{x, y, w, h}[]` — consumed by `composeBaseCanvas` and `composeMask` with the same shape.
- `buildAssetGenFormData({model, prompt, size, baseBlob, maskBlob})` — caller in Task 6 passes exactly those keys.
- `consumeImageResponse(resp, { sid, promptText, size, kind, originBlob, modelUsed, qualityUsed })` — Task 6 passes those exact keys; matches the existing signature in App.jsx:399.
- `composeMask(..., opts={feather, invert})` — Task 6 calls without opts (defaults applied); Task 7 step 6 lists exact `{feather:0}` / `{feather:8}` adjustments.

All signatures align across tasks.
