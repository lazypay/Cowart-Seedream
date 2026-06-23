# Cowart Seedream

Cowart Seedream 是 [Cowart](https://github.com/zhongerxin/Cowart) 的**配套独立插件**：用你自己的图像 API 生图，并把结果放进正在运行的 Cowart 画布。默认走**豆包 Seedream（火山方舟 Volcengine Ark）**，也支持任意 **OpenAI 兼容**接口。

> 🟢 **新手请先看：[手把手新手教程 → TUTORIAL.md](./TUTORIAL.md)**（零基础、可复制粘贴）。

它的意义是：**没有内置生图额度也能继续干活**。Cowart 自带的 `cowart-image-gen` 用内置模型（消耗额度）；这个插件用你自己的 key，二者互补、互不冲突。

- 不修改 Cowart 仓库的任何文件，单独安装、单独升级。
- 只依赖 Cowart 正在运行的本地画布服务（HTTP `/api/canvas`）。
- **零 npm 依赖**：内置了 tldraw 排序所需的 `fractional-indexing`（CC0），`node ./mcp/server.mjs` 即跑，跨平台。

## 它能做什么

- 选中一个 `AI 图片` holder → 按比例严格生图并**填充/替换** holder（默认 `into`，无裁剪不变形）。
- 把生成图**放在锚点旁边**（`right`/`left`/`below`），用于标注改图、出变体——不动原图与标注。
- 没有选中任何东西时，在当前页放一张**独立图片**。
- **图生图**：用 holder/锚点的已有图、或你提供的本地截图/远程 URL 作为参考图。

底层只暴露一个 MCP 工具：`generate_seedream_image`。

## 安装

推荐 clone/放置到 Codex personal marketplace 默认引用的位置：

```bash
# 放到 ~/plugins/cowart-seedream（与 cowart 同级）
# Windows 上 ~ 即 C:\Users\<你>\
```

在 `~/.agents/plugins/marketplace.json` 的 `personal` 市场里追加一条（与 cowart 并列）：

```json
{
  "name": "cowart-seedream",
  "source": {
    "source": "local",
    "path": "./plugins/cowart-seedream"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

然后注册并安装（personal 市场若已注册可跳过第一行）：

```bash
codex plugin marketplace add ~
codex plugin add cowart-seedream@personal
```

安装后建议**新开一个 Codex 对话**，让新的 skill 和 MCP 工具完整加载。无需 `npm install`（零依赖）。

## 配置（环境变量）

把变量设为**本机环境变量**后重启 Codex。Windows 上即使只设了用户环境变量，插件也会从 `HKCU\Environment` 注册表兜底读取。

provider 选择规则：显式 `COWART_IMAGE_PROVIDER`（或工具入参 `provider`）优先；否则按 base URL 自动判别（含 `volces.com`/`ark`/`/api/v3` → 豆包，其余自定义地址 → OpenAI 兼容）；都没配则默认豆包。

**provider 专属变量优先、通用变量兜底**，这样一份配置切换 provider 不会串：

| provider | key（按序优先） | base URL（按序优先） | model（按序优先） |
| --- | --- | --- | --- |
| `doubao` | `ARK_API_KEY` → `DOUBAO_API_KEY` → `COWART_IMAGE_API_KEY` | `ARK_BASE_URL` → `COWART_IMAGE_BASE_URL`(仅当像方舟地址) → `https://ark.cn-beijing.volces.com/api/v3` | `DOUBAO_MODEL` → `COWART_IMAGE_MODEL`(仅当含 doubao/seedream) → `doubao-seedream-5-0-260128` |
| `openai` | `OPENAI_API_KEY` → `GAISC_API_KEY` → `COWART_IMAGE_API_KEY` | `COWART_IMAGE_BASE_URL` → `GAISC_BASE_URL` → `https://sub.g-aisc.com/v1` | `COWART_IMAGE_MODEL` → `gpt-image-2` |

### 豆包（火山方舟）

1. 在火山方舟控制台开通 Seedream 图像生成、拿到 API Key。
2. 设置环境变量：

   ```powershell
   # PowerShell（持久化到用户环境变量），设完重启 Codex
   setx COWART_IMAGE_PROVIDER "doubao"
   setx ARK_API_KEY "你的火山方舟Key"
   # 可选覆盖模型：setx COWART_IMAGE_MODEL "doubao-seedream-5-0-260128"
   ```

   > 用 `ARK_API_KEY` 而非 `COWART_IMAGE_API_KEY`，可与已有的 g-aisc 配置共存：豆包模式会忽略指向 g-aisc 的 `COWART_IMAGE_BASE_URL`，自动用方舟默认地址。

3. 若控制台给的是“推理接入点” `ep-xxxx` 而非公共模型名，把 `COWART_IMAGE_MODEL` 设成该接入点 id。

> 说明：豆包 `WxH` 尺寸总像素须在 `2560x1440 ~ 4096x4096`、宽高比在 `[1/16,16]`。插件会把常见比例吸附到官方推荐尺寸（1:1→2048×2048、16:9→2560×1440、3:2→2496×1664…），其余按比例算合法尺寸；也可用 `size` 传 `1K/2K/4K` 或显式 `2048x2048`。

### OpenAI 兼容第三方

```powershell
setx COWART_IMAGE_PROVIDER "openai"
setx COWART_IMAGE_API_KEY "你的key"
setx COWART_IMAGE_BASE_URL "https://你的兼容接口/v1"
setx COWART_IMAGE_MODEL "gpt-image-2"
```

## 使用

1. 先让 Cowart 打开画布（`cowart:cowart-open-canvas`），默认 `http://127.0.0.1:43217`。
2. 在画布里创建并选中一个 `AI 图片` holder。
3. 在 Codex 里说，例如：

   ```text
   用我自己的豆包接口，给选中的 Cowart AI 图片框生成一张……
   ```

   或显式触发：

   ```text
   Use $cowart-seedream:cowart-seedream-image to fill the selected holder with: <描述>
   ```

标注改图：对画布图片做标注 → 把图片连同标注一起选中（或提供截图）→ 让它按标注在原图旁边生成修订图。

## 想让它成为默认生图方式？

两个 skill 默认共存，由你的每次意图决定用哪个。若你长期没额度、想让第三方接口成为默认，可在 Codex 里**停用** `cowart:cowart-image-gen`，只保留本插件；或每次显式 `@cowart-seedream`。

## 工作原理

```
你的描述
  → generate_seedream_image (本插件 MCP)
      → 读取 Cowart 选区(canvas/cowart-selection.json) 得到 holder 比例
      → 调你的图像 API（豆包 /images/generations 或 OpenAI 兼容 /images/generations|edits）
      → 取回位图(b64 或下载 url)
      → 通过 Cowart HTTP /api/canvas 写入资源与图形（into 填充 / beside 旁置 / standalone）
```

全程不触碰 Cowart 源码，只用其稳定的 HTTP 画布接口。

## 致谢

- 画布与工作流来自 [Cowart](https://github.com/zhongerxin/Cowart)（基于 tldraw）。
- 排序键内置自 [`fractional-indexing`](https://github.com/rocicorp/fractional-indexing)（CC0-1.0）。
