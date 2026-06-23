# Cowart Seedream 新手教程（手把手 · 零基础）

这份教程默认你**几乎没用过命令行**，每一步都能复制粘贴。系统以 **Windows + PowerShell** 为例（Mac/Linux 把 `setx` 换成 `export` 即可）。

> 一句话：装上它，你就能用**自己的豆包/第三方 API** 在 Cowart 画布上生图，**不再消耗 Codex 内置生图额度**。

---

## 30 秒速览（老手直接看这段）

```powershell
# 1. 下载到指定目录（文件夹名必须是 cowart-seedream）
git clone https://github.com/lazypay/Cowart-Seedream.git "$HOME\plugins\cowart-seedream"

# 2. 在 ~/.agents/plugins/marketplace.json 的 personal 市场里加一条 cowart-seedream（见第二步）

# 3. 安装
codex plugin marketplace add ~
codex plugin add cowart-seedream@personal

# 4. 配豆包 key，然后重启 Codex
setx COWART_IMAGE_PROVIDER "doubao"
setx ARK_API_KEY "你的火山方舟Key"
```

装完**新开一个 Codex 对话**，选中画布里的 `AI 图片` 框，说“用我自己的接口生成 XXX”即可。

---

## 开始前你需要

1. **Codex** 已经能正常使用。
2. **Node.js 18 或更高**。检查：

   ```powershell
   node -v
   ```

   若提示“不是内部命令”或版本低于 18，去 <https://nodejs.org> 下载 LTS 版安装。
3. **已安装 Cowart 插件**（本插件是它的搭档，负责画布；本插件只负责“用你的 key 生图”）。
   Cowart 仓库：<https://github.com/zhongerxin/Cowart>
4. **一个图像 API Key**，二选一：
   - 豆包 / 火山方舟（推荐，默认）：在火山方舟控制台开通 **Seedream 图片生成**，拿到 API Key。
   - 任意 **OpenAI 兼容**第三方接口：准备好它的 `base URL` + `key`。

> 本插件**零依赖**，不需要 `npm install`，下载完就能用。

---

## 第一步：下载插件到指定位置

文件夹名**必须**是 `cowart-seedream`（市场注册时按这个名字找）：

```powershell
git clone https://github.com/lazypay/Cowart-Seedream.git "$HOME\plugins\cowart-seedream"
```

不会用 git？也可以在 GitHub 页面点 **Code → Download ZIP**，解压后把里面的内容放到：

```
C:\Users\你的用户名\plugins\cowart-seedream
```

确认这个目录下能看到 `mcp\server.mjs`、`skills\`、`.codex-plugin\` 就对了。

---

## 第二步：登记到 Codex 插件市场

用记事本打开（没有就新建）这个文件：

```
C:\Users\你的用户名\.agents\plugins\marketplace.json
```

在 `personal` 市场的 `plugins` 数组里，**加入下面这一条**（如果你已经装了 cowart，就加在它旁边）：

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

完整文件大概长这样（已有 cowart 的话就是两条并列）：

```json
{
  "name": "personal",
  "interface": { "displayName": "Personal" },
  "plugins": [
    {
      "name": "cowart",
      "source": { "source": "local", "path": "./plugins/cowart" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    },
    {
      "name": "cowart-seedream",
      "source": { "source": "local", "path": "./plugins/cowart-seedream" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

> 注意 JSON 里每条之间要有逗号，最后一条后面不要逗号，否则会报错。

---

## 第三步：安装插件

在 PowerShell 里依次运行：

```powershell
codex plugin marketplace add ~
codex plugin add cowart-seedream@personal
```

装好后**新开一个 Codex 对话**，让新的技能和工具加载进来。

---

## 第四步：配置你的 API Key

环境变量设好后**一定要重启 Codex**才生效。（Windows 上即使只用 `setx` 设了用户变量，本插件也会从注册表兜底读取。）

### 方案 A：豆包 / 火山方舟（推荐，默认）

```powershell
setx COWART_IMAGE_PROVIDER "doubao"
setx ARK_API_KEY "你的火山方舟Key"
```

- 默认模型是 `doubao-seedream-5-0-260128`。想换别的版本：

  ```powershell
  setx COWART_IMAGE_MODEL "doubao-seedream-4-5-251128"
  ```

- 如果控制台给你的是“推理接入点” `ep-xxxxxxxx` 而不是模型名，把上面的 `COWART_IMAGE_MODEL` 设成那个 `ep-...`。

### 方案 B：OpenAI 兼容第三方

```powershell
setx COWART_IMAGE_PROVIDER "openai"
setx COWART_IMAGE_API_KEY "你的key"
setx COWART_IMAGE_BASE_URL "https://你的兼容接口/v1"
setx COWART_IMAGE_MODEL "gpt-image-2"
```

> 小贴士：插件会**自动判别** provider——如果你只设了 `COWART_IMAGE_BASE_URL` 且地址里带 `volces.com`/`ark`，会当成豆包；其它自定义地址当成 OpenAI 兼容。想强制指定就设 `COWART_IMAGE_PROVIDER`。

设完，**关掉并重新打开 Codex**。

---

## 第五步：生第一张图

1. 让 Codex 打开 Cowart 画布（这一步用的是 cowart 插件）：

   ```text
   Open the Cowart canvas for this project.
   ```

   浏览器会打开 `http://127.0.0.1:43217`。

2. 在画布里放一个 **AI 图片** 框（holder），并**点选中它**。

3. 对 Codex 说（中文就行）：

   ```text
   用我自己的接口，给选中的 Cowart AI 图片框生成：一只戴墨镜的柴犬，扁平插画风
   ```

   它会按框的比例生成、无裁剪地填进这个框。完成后会告诉你用的 provider/模型、尺寸和保存路径。

就这么简单。没有额度也能一直画下去。

---

## 进阶玩法

- **旁边出变体/对照**：选中一张图，说“在它右边再生成一张换成夜景的版本”。原图不动，新图放右边。
- **标注改图（图生图）**：用 cowart 的批注工具在图上画箭头/写要求（比如箭头指头发写“短发”），把图连同批注一起选中，说“按标注改图，放在原图旁边”。它会读懂标注、保留原图主体生成修订版。
- **指定尺寸/比例**：可以说“按 16:9 生成”，或让它用 `size` 传 `2K`/`4K`/`2048x2048`。
- **保留占位框**：默认会把 `AI 图片` 框替换成可自由拖动缩放的图片；想保留框就说“保留占位框，把图放进框里”。

---

## 常见问题（FAQ）

**Q：和 cowart 自带的生图会冲突吗？**
不会。两个插件并存：cowart 自带的 `cowart-image-gen` 用 Codex 内置模型（消耗额度）；本插件用你自己的 key（不消耗额度）。每次想用哪个，在话里说清楚即可（例如“用我自己的接口/用豆包”）。想让本插件成为默认，可以在 Codex 里停用 cowart 的 `cowart-image-gen` 技能。

**Q：报错 `HTTP 503: No available compatible accounts`？**
这是你那个**第三方中转接口**暂时没有可用上游账号/额度，属于服务商侧问题。换豆包官方（方案 A）或等中转恢复、充值即可。

**Q：我设了 key，但提示找不到 key？**
`setx` 设的变量只对**之后新启动**的程序生效——请**完全关闭并重开 Codex**。还不行就确认变量名拼写正确（豆包用 `ARK_API_KEY`，OpenAI 兼容用 `COWART_IMAGE_API_KEY`）。

**Q：提示连不上画布 / Could not reach the Cowart canvas？**
先用 cowart 打开画布（“Open the Cowart canvas”）。如果 cowart 换了端口（比如 43218），在请求里带上 `cowartUrl: http://127.0.0.1:43218`。

**Q：豆包对尺寸有要求吗？**
有。用 `宽x高` 时总像素需在 `2560x1440 ~ 4096x4096` 之间、宽高比在 `1/16 ~ 16`。本插件会自动把常见比例对齐到官方推荐尺寸（1:1→2048×2048、16:9→2560×1440、3:2→2496×1664…），你一般不用管。

**Q：换成 DeepSeek 后生成了满屏问号 / “Describe your image request clearly!”？**
这是某些模型或 Windows 工具链把中文提示词变成 `????` 后，豆包照着错误提示词生成了占位图。新版插件会自动拦截这类 prompt，不再浪费生图调用。最佳实践是：你可以用中文和 Codex 说需求，但让 agent 调工具时把最终 `prompt` 翻译/扩写成英文；只有图片里确实要出现中文文字时，才把那段中文原文放进 prompt。

**Q：换成 Mimo/其他模型后，“改图”变成了全新文生图，人物和背景都变了？**
这是 agent 漏传 `editSourceFromAnchor: true`，导致工具按纯文生图执行。新版插件对 `right`/`left`/`below` 这类放在原图旁边的操作做了兜底：如果锚点本身是图片，会默认把锚点图作为参考图做图生图，除非明确传 `editSourceFromAnchor:false`。为了更稳，你仍然可以在提示里说：“请使用图生图，保留原图人物身份、构图和背景，只改标注部分，放在右边。”

**Q：生成的图片存在哪？**
和 cowart 一样，存在你当前项目目录下：`canvas/pages/<页面>/assets/`，文件名带时间戳，不会覆盖旧图。

**Q：要联网/装依赖吗？**
生图当然要联网调你的 API。但插件本身**零 npm 依赖**，不需要 `npm install`。

---

## 还想更深入？

完整参数、环境变量优先级、工作原理见 [README.md](./README.md)。

致谢：画布与工作流来自 [Cowart](https://github.com/zhongerxin/Cowart)（基于 tldraw）。
