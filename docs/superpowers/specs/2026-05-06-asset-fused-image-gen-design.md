# 素材融合生图 — 设计文档

**日期**：2026-05-06
**状态**：MVP 设计已确认，待实现规划
**所在项目**：`/Users/wh/person/station/gptImg`（Vite + React 18 SPA）

## 背景与目标

gptImg 当前支持三种生图模式：generate（纯文生图）、edit（参考图 + 可选 mask）、batch（批量 edit）。本次新增能力：**生成的图必须包含用户提供的素材（logo、二维码等），且素材必须像素级保真**——QR 必须扫得通，logo 不变形不变色。

核心约束：
- 模型固定为 `gpt-image-2`（用户走 `https://api.pubwhere.cn` 自建代理）
- 用户拒绝"后期 Canvas 合成"方案，要求素材"自然融入场景"
- MVP 阶段优先**验证模型能力**，UI 极简，位置随机

## 方案选型：B+（mask 反锁 + AI 场景填充）

### 为什么不是其它方案

| 方案 | 描述 | 不选的原因 |
|---|---|---|
| A. 后期合成 | 模型纯文生图 → Canvas 把素材叠到结果上 | 用户明确拒绝："必须让 logo 和二维码完美融合" |
| B. 模型集成 | 把素材作为 `image[]` 传给 `/v1/images/edits` 让模型画进去 | gpt-image-2 会"重画"参考图，QR 像素被破坏几乎一定扫不通 |
| **B+** | **素材合成到空白画布的指定位置 → mask 锁住素材区 → 让模型在素材周围生成场景** | **同时满足"像素保真"和"场景融合"** |
| C. 混合 | 软素材走 B、硬素材走 A | UI 复杂度高，MVP 不必要 |

### B+ 的工作原理

OpenAI `/v1/images/edits` 的 mask 约定：**mask 中透明（alpha=0）的区域 = 模型重新生成；不透明（alpha=255）区域 = 像素原样保留**。

利用这一点：
1. 准备一张白底 base 画布（尺寸等于目标输出尺寸），素材按选定位置贴到 base 上
2. 准备一张同尺寸 mask：素材所在位置涂不透明，其余涂透明
3. 一起送到 `/v1/images/edits` + 用户 prompt
4. 模型会保留素材像素不动，根据 prompt 在素材周围"画出"场景

最终结果：素材 100% 像素保真，场景由模型生成并自然包绕素材。

## MVP 范围

**做**：
- 多文件素材上传（PNG / JPG / WebP）
- 随机位置布局（智能候选）
- 紧贴素材形状的 mask
- prompt 自动追加融合 suffix
- 跑通 `/v1/images/edits` 全流程
- 入现有 IndexedDB gallery

**不做（推迟到 V2 或更晚）**：
- zip 解压上传
- 素材跨 session 持久化（IndexedDB asset store）
- 手动布局 / 拖拽 / 缩放 / 旋转
- 多实例、模板复用
- 跨 session 共享素材

## 系统设计

### 入口：新增第 4 个 mode

在现有 `mode tabs`（generate / edit / batch）旁加 **「素材生图」** tab，避免污染既有模式行为。

`makeSession` 增加 `mode: 'assetGen'`，对应 session 字段：
```js
{
  mode: 'assetGen',
  prompt: '',
  ratio, quality, model,
  assetItems: [],     // [{ id, file, url, name, hasAlpha }]
  status: { msg, err },
}
```

UI 元素（参考现有 generate mode 布局）：
- prompt 输入框
- ratio + quality 选择器
- **素材上传区**：多文件选择 / 拖拽，缩略图列表 + × 删除按钮
- 「生成」按钮

素材**只在 session 内存中**，刷新即失（MVP 不持久化）。素材数量上限 **5 个**，避免 mask 过密导致模型失去构图自由度。

### 生成流水线（核心）

点击生成时，前端依次：

```
1. 计算输出尺寸 W×H（同现有 computeSize(ratio, quality)）

2. 创建 base canvas（W×H，白底）

3. 为每个素材选定位置（智能随机，见下节）

4. 把每个素材绘制到 base canvas 对应位置（保留 PNG 透明度）

5. 创建 mask canvas（W×H，全透明背景）
   - 对每个素材：根据 hasAlpha 选择 mask 形状
     - hasAlpha=true：用 getImageData 读 alpha，alpha > 阈值（128）的像素涂不透明
     - hasAlpha=false：素材外接矩形整块涂不透明
   - mask 边缘做 4px 羽化（alpha 渐变）—— 实测 gpt-image-2 是否吃灰度 mask；
     若不支持，退回硬边

6. base 和 mask 各导出为 PNG blob

7. 拼接最终 prompt：
   userPrompt + '\n\n' + ASSET_FUSION_SUFFIX

8. POST /v1/images/edits（FormData）：
   - model: 'gpt-image-2'
   - prompt: 上一步拼好的
   - size: `${W}x${H}`
   - n: 1
   - response_format: 'b64_json'
   - image: base.png
   - mask: mask.png

9. 走现有 consumeImageResponse → 入 gallery
   - kind: 'asset-gen'
   - originBlob: 存合成后的 base canvas（用于排查 mask 摆位 bug）
```

### 智能随机位置

不用纯均匀随机（会怼脸糊主体）。用 **8 个 anchor + 抖动**：

```
anchors = [
  topLeft, topCenter, topRight,
  midLeft,             midRight,
  bottomLeft, bottomCenter, bottomRight
]
```

中心 anchor 故意不要——给模型留出主体空间。

每个素材：
1. 从 8 个 anchor 中随机选 1 个（不重复，剩素材多于 anchor 时允许重）
2. 在 anchor 位置上 ±5% 画布尺寸做抖动
3. 检查与已放置素材的碰撞；若重叠 > 20% 面积，retry 最多 5 次；仍冲突就接受
4. 素材尺寸：每个素材的最长边 = `min(W, H) × 0.15`（约画布短边 15%）

边距：素材外接框距画布边至少 `min(W, H) × 0.04`，避免出血。

### prompt suffix

固定追加（用户不可见，前端拼接）：

```
The composition contains fixed visual elements (logos, codes, marks) that must
appear as natural parts of the scene — printed on signs, posters, screens,
packaging, fabric, walls, or other surfaces — with believable lighting, shadow,
perspective, and surrounding materials. Build the scene to contextualize and
integrate them.
```

英文，因为 gpt-image-2 对英文语义指令通常更稳。如果实测中文 prompt + 英文 suffix 有冲突，再调。

### 错误处理与流程复用

- 复用现有 `pushPending / patchPending / popPending / failPending / cancelPending` 全部逻辑
- 复用现有 `consumeImageResponse`，新 kind `'asset-gen'`
- 复用现有 IndexedDB gallery（`addImage`），`originBlob` 字段存合成后的 base canvas（debug 用）
- 取消 / 错误 / 配额提示文案沿用 generate mode 的写法

### 不需要改动的部分

- `db.js`：MVP 不引入新 store，复用 `images` 表
- `moderation.js`：素材生图也走相同的 `checkForbidden` 校验 prompt
- 多 session 框架、gallery UI、Lightbox、BeforeAfter 组件、设置面板：全部不动

## 关键技术验证（实现前必跑的实验）

实现这些前端逻辑之前，**先用 Postman / curl 跑两个一次性实验**，确认 gpt-image-2 + `api.pubwhere.cn` 的 mask 行为：

### 实验 1：mask 约定方向

构造一张 1024×1024 base（白底）+ 一张同尺寸 mask（左半透明、右半不透明），prompt 随便写一句"a forest scene"。看返回结果：
- 如果**左半被改 / 右半保留** → 与 OpenAI 文档一致，按设计走
- 如果**右半被改 / 左半保留** → 反向，需要把 mask 涂法翻转
- 如果整图都被重画 → 代理或模型不支持 mask，整个 B+ 方案不成立，回头讨论降级

### 实验 2：QR 保真度

base 上贴一张真实可扫的 QR（200×200，白边距），mask 锁住 QR 区域，prompt 写"a coffee shop window"，跑 5 张：
- 用手机扫 5 张 QR，统计扫通率
- ≥ 4/5 通过 → B+ 路径成立，按设计实现
- < 4/5 → gpt-image-2 对 mask 不绝对尊重；回头改设计：QR 单独走后期 Canvas 合成（A 方案的局部应用），logo 仍走 B+。需要重新跟用户确认。

## 验收标准（MVP 跑通的判据）

实现后跑一组验证：
- **像素保真**：合成结果中素材区域与输入素材逐像素对比，diff = 0
- **QR 扫描**：手机扫，5/5 全通（实验 2 的现场复现）
- **logo 融合度**：5 张同 prompt 同素材，目测 ≥ 3 张看起来"画进去的"而非"贴上去的"
  - 判据：边缘有合理的阴影/光照过渡、素材像是出现在某个表面（招牌、海报、屏幕）、与场景透视协调
- **取消 / 错误流程**：跟 generate mode 行为一致

如果 logo 融合度不达标，可以分别试：
- 调 mask 羽化半径（4px → 8px → 12px）
- 调整 prompt suffix 措辞
- 调 anchor 位置策略（让素材更靠"语义合理"的边缘）

## 风险与回退

| 风险 | 表现 | 回退 |
|---|---|---|
| 代理对 mask 反向 | 素材区被改、场景区被锁 | 翻转 mask 涂色 |
| 模型不支持灰度 mask | API 报错或异常输出 | 退回硬边 mask |
| 模型不绝对尊重 mask | QR 扫不通 / logo 变形 | 降级混合方案：QR 强制后期合成，logo 仍走 B+ |
| 多素材构图局促 | 8 anchor 不够分 | 上限改 3 个素材 / 缩小素材尺寸 |

## V2+ 路线（仅记录，不在本次范围）

按用户实际反馈优先级再排：
- zip 解压上传
- 素材跨 session 持久化（IndexedDB 新 store + UI 面板）
- 手动布局 / 拖拽 / 缩放
- 素材模板（"这套位置 + 这组素材"保存为 preset）
- 智能放置升级（结合 prompt 内容判断"放招牌位"还是"放海报位"）
