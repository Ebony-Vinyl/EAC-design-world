# EAC design world v0.3.0 · 开发预览版

发布日期：2026-10-18。

## 本版变化

- 顶部导航新增独立「插件维护」入口，移除设置页和宿主外层的重复入口。
- 提供版本检查、Ed25519 签名更新、本地更新包、备份回滚、真实宿主热重载与公告已读记录。
- 修复更新回滚的文件所有权记录，保留用户自建文件及更新后新增的文件；旧备份不再授权清理未知文件。
- 输出 HTML / HTM / SVG 使用隔离预览策略，阻止调用工作台写入 API。
- 编辑器保留文件、视图切换与页面刷新前的未保存草稿，阻止过期读取覆盖当前文件。
- 文件名冲突明确提示；修改文件名时另存为新文件，保留原成品。
- 工作台优先预览当前项目成片，支持与所选模板切换；导出可解析相对 vendor 资源。
- 统一弹窗 Escape、焦点约束与焦点返回，改善模板筛选、窄屏布局及动效反馈，支持减少动态效果。
- 修复宿主工具严格 JSON 返回、内置 MG 模板读取和旧运行服务版本检查。
- 支持本地导入 Motion Web / Onetake 可选动效来源；受许可限制的原始内容不随公开产物分发。

## 下载与安装

- `eac-design-world-v0.3.0-plugin.zip`：源码、预构建 Web UI、模板、设计体系和许可说明。不包含 `node_modules`。
- `eac-design-world-v0.3.0-media.zip`：可选大媒体，合并解压到插件目录。
- `eac-design-world-v0.3.0-update.zip`：签名维护更新包。解压后在维护中心选择其中 `manifest.json`，保留相邻 `files/`。
- `SHA256SUMS.txt`：产物校验值。

插件包与媒体包根目录均为 `eac-design-world/`。

```powershell
cd eac-design-world
npm ci --omit=dev
npm run doctor
node scripts/install-harness.mjs --dry-run
node scripts/install-harness.mjs
```

0.1.0 没有维护接口，首次升级需解压新插件包、安装依赖并重新加载 Harness。保留已有 `.eac`、项目与素材，不需要重建配置。独立使用可执行 `npm start`，打开 `http://127.0.0.1:4173`。

## 已知边界

- 本版继续作为开发预览发布。Windows SAPI 与桌面录制仅支持 Windows。
- 独立服务不具备 Harness 模块重载能力，安装和回滚操作须在宿主中执行。
- 草稿暂存属于当前浏览器会话，不替代正式保存或跨设备同步。
- PDF / PNG 受本地字体与素材可用性影响；PPTX 为整页图像，逐元素编辑需保留 HTML。
- Whisper 模型、Python、FFmpeg、Node 与 Node 依赖需自行准备。
- 上游内容中的外部生成需求与素材占位符仍需补充；技术检查不等于艺术质量验收。
- 可选非商业动效来源和未取得再分发许可的文件不进入源码或发布包。

## 发布前验证

- `npm run build`：通过。
- `node --test --test-concurrency=1 tests/*.test.mjs`：193 项通过，0 失败、0 跳过。
- `node scripts/verify-picker.mjs`：6 组浏览器验证全部通过，覆盖嵌入式消息、弹窗关闭顺序和窄屏布局。
- 确认签名私钥与插件内置公钥匹配，待发布文件不包含私钥、访问凭据或受限可选库。

较早的一次全量运行中编辑器首次打开曾超时，随后定向与上述完整串行复跑均通过，未放宽断言。详细审查与修复说明见 [本地审查记录](review-2026-10-17.md)。实际压缩包的升级、回滚与远端校验结果在 GitHub Release 中补充。
