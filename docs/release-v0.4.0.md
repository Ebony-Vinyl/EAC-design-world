# EAC design world v0.4.0

发布日期：2026-10-18。本版继续作为开发预览发布。

## 本版变化

- 接入 Shotcraft 的 150 个镜头、10 类动效、59 个精选和 124 张配方，保留源码、封面、本地预览视频、实测时长与来源记录。
- 模板库新增来源入口、分类和用途搜索、精选筛选、持久化选片单、批量加入、复制及下载。
- 在独立工作台中将选片导入项目素材，继续使用既有时间线剪辑和视频导出。
- 可见区域动态预览最多同时播放 3 个视频；离屏、后台及打开详情时暂停，关闭时释放媒体资源。
- 预览播放器支持播放、暂停、重播、时间进度和横竖屏等比缩放，加载失败时提供回退及重试。
- 修复 Edge 中隔离预览加载本地运行时脚本的问题；保留来源隔离和写入 API 限制。
- 修复长说明遮挡弹窗操作按钮、选择取消与 Harness 选中缩略图，改善手机布局和键盘操作。
- 模板库加载后读取轻量状态，避免每次轮询都扫描镜头文件和重新处理目录。
- 首次发布同名 npm 包，包含预构建界面及 Shotcraft 预览，不包含用户数据、依赖目录、私钥或受限可选库。

## 安装

GitHub Release 提供以下产物：

| 文件 | 用途 |
| --- | --- |
| `eac-design-world-v0.4.0-plugin.zip` | 插件源码、构建后的界面、设计库、Shotcraft 源码和视频 |
| `eac-design-world-v0.4.0-media.zip` | 可选 MG 视频、字体与原有大媒体；内容与 0.3.0 媒体包相同 |
| `eac-design-world-v0.4.0-update.zip` | Ed25519 签名本地更新包，包含相邻的 `manifest.json` 和 `files/` |
| `eac-design-world-0.4.0.tgz` | 与 npm 发布相同的包 |
| `release-manifest.json` / `SHA256SUMS.txt` | 来源提交、产物大小和校验值 |

ZIP 插件包与媒体包均以 `eac-design-world/` 为根目录。已有 0.3.0 媒体包无需重复下载。

```powershell
npm install eac-design-world@0.4.0
node node_modules/eac-design-world/scripts/install-harness.mjs --dry-run
node node_modules/eac-design-world/scripts/install-harness.mjs
```

解压插件包的安装方式仍可使用 `npm ci --omit=dev` 和 `node scripts/install-harness.mjs`。已有维护中心支持签名更新包和 `updates` 渠道；本地项目与可选媒体保留。

## 验证与边界

本轮生产构建与完整测试 210 项通过，并检查真实视频播放、Shotcraft 素材导入及时间线渲染、Edge 运行时加载、隔离策略和手机显示。

Shotcraft 视频可以直接导入剪辑；原始 TSX 是 Remotion 组件，需在 Remotion 工程中注册，或定制为支持 `renderAt(t)` / `__seek(t)` 的 HTML 时间线。安装包不附带 Remotion 运行时。FFmpeg、Node、Python 和 Whisper 模型仍需自行准备，桌面录制与 SAPI 仍限 Windows。Motion Web / Onetake 受限可选原始库不随公开包发布。
