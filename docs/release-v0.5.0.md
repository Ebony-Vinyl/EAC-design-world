# EAC design world v0.5.0

发布日期：2026-10-24。本版继续作为开发预览发布，功能面与 0.4.0 一致，重点是界面设计系统与交互手感。

## 本版变化

- 界面整体从暖绿体系切换为墨蓝玻璃设计系统：白色玻璃卡片与顶栏、胶囊式导航与筛选、单一蓝色强调色、统一 ok/warn/err 状态色与细滚动条；旧调色板变量（`--teal` 等）以别名保留，既有组件无需改动。
- 嵌入 Harness 宿主时自动移除环境光背景（`data-embedded`），与宿主画布融为一体；独立打开时保留双色光场氛围。
- 新增微动效层：视图切换过渡与内容交错入场、镜头卡与迷你模板按序淡入、任务与维护面板卡片入场、运行中进度条流光、空状态图标漂浮、播放按钮呼吸、选中标签回弹；全部只动 transform/opacity，并遵循 `prefers-reduced-motion`。
- 选中标记、对话框、Toast、进度条等统一为新的蓝色渐变与阴影体系；模板/镜头封面加载完成时柔和淡入。
- 修复设计库「创作模板」卡片长标题将「使用」按钮挤出卡片、导致页面出现横向滚动条的问题（标题容器缺少 `min-width: 0`）。
- 深色预览舞台、模板源码预览播放器与维护面板公告、诊断、更新进度全部按新体系重着色。

## 安装

GitHub Release 提供以下产物：

| 文件 | 用途 |
| --- | --- |
| `eac-design-world-v0.5.0-plugin.zip` | 插件源码、构建后的界面、设计库、Shotcraft 源码和视频 |
| `eac-design-world-v0.5.0-media.zip` | 可选 MG 视频、字体与原有大媒体；内容与 0.3.0 媒体包相同 |
| `eac-design-world-v0.5.0-update.zip` | Ed25519 签名本地更新包，包含相邻的 `manifest.json` 和 `files/` |
| `eac-design-world-0.5.0.tgz` | 与 npm 发布相同的包 |
| `release-manifest.json` / `SHA256SUMS.txt` | 来源提交、产物大小和校验值 |

ZIP 插件包与媒体包均以 `eac-design-world/` 为根目录。已有 0.3.0 / 0.4.0 媒体包无需重复下载。

```powershell
npm install eac-design-world@0.5.0
node node_modules/eac-design-world/scripts/install-harness.mjs --dry-run
node node_modules/eac-design-world/scripts/install-harness.mjs
```

解压插件包的安装方式仍可使用 `npm ci --omit=dev` 和 `node scripts/install-harness.mjs`。已有 0.4.0 安装可在维护中心检查更新（签名 `updates` 渠道）或导入本版更新包；用户项目、依赖和可选媒体保留。

## 验证与边界

本轮生产构建通过，完整测试 214 项通过（其中 1 项 Windows 并发计时偶发，单独重跑通过），并对 7 个主要视图在 1440/760/390 三种宽度做了浏览器巡检：无页面错误、无控制台错误、无横向溢出。升级/回滚验证（0.3.0 → 0.5.0 签名更新后回滚）通过，详见 `release-manifest.json`。

本版未新增外部依赖，FFmpeg、Node、Python 和 Whisper 模型仍需自行准备，桌面录制与 SAPI 仍限 Windows。Motion Web / Onetake 受限可选原始库不随公开包发布。
