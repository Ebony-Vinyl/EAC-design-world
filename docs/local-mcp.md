# 本地 MCP 与可视化工作台

## 方案与边界

按单人、本机使用设计。保留 DSH 插件；Codex 通过 stdio MCP 调用现有 HTTP 后端，浏览器打开同一个 React 工作台。无需外部模型密钥。工作台只监听 127.0.0.1，源素材、项目和成品留在本机；发送给 Codex 的工具结果仍按宿主模型的数据策略处理。

决策：采用独立、可复用的后台服务，而非每个 MCP 客户端建立一套项目存储。MCP 断开后制作任务和界面继续运行。自动启动仅复用相同版本、安装路径和数据目录的服务；冲突不会终止已有进程。显式设置 EAC_URL 时仍使用原有外部服务模式。首次运行要求先安装依赖并构建界面。

本地 MCP 支持 macOS 与 Windows，共用后端与工作台。本轮不移植 DSH 原生输入框/侧栏，也不新增 macOS 桌面录屏。Mac 配音使用系统 say；Windows 保留 SAPI 配音与 gdigrab 桌面录制。转录仍要求自行配置本地 Whisper 模型。

## 安装与接入

需要 Node 22+、FFmpeg/FFprobe 7+、Chrome 或兼容 Chromium。

```sh
npm ci
npm run build
npm run mcp:local
```

最后一条启动 stdio MCP，交互终端中等待客户端输入是正常情况。Codex 应直接启动它：

```sh
codex mcp add eac-design-world -- /absolute/path/to/node /absolute/path/to/EAC-design-world/src/mcp-local.mjs
```

桌面启动环境可能没有 Homebrew 的 PATH，应使用 `--env PATH=...` 显式包含 Node 与 FFmpeg 所在目录。可以用 `--env EAC_PORT=4173`、`--env EAC_DATA_DIR=/absolute/data/path` 固定端口与数据。更新 Codex 配置后，在重新加载 MCP 的会话中使用 `workspace_info` 获取界面地址。

### Windows（PowerShell）

安装 Node 22+ 和 FFmpeg 7+，确保 `node --version`、`ffmpeg -version`、`ffprobe -version` 能运行。在仓库根目录执行：

```powershell
npm ci
npm run build
$eacNode = (Get-Command node -CommandType Application).Source
$eacEntry = (Resolve-Path '.\src\mcp-local.mjs').Path
codex mcp add eac-design-world --env "PATH=$env:Path" --env "EAC_PORT=4173" -- $eacNode $eacEntry
codex mcp get eac-design-world
```

MCP 直接启动 `node.exe` 与脚本参数，不通过 shell 拼接命令，也不要求 Codex 执行 npm.cmd；项目路径可以包含空格和中文。PATH 是配置时的快照，后来迁移 Node 或 FFmpeg 后需重新配置。浏览器依次查找 Program Files、Program Files (x86)、ProgramW6432 与 LocalAppData 中的 Edge、Chrome、Chromium，支持非 C 盘和按用户安装；也可显式设置 EAC_BROWSER。没有系统浏览器时可运行 `npx playwright install chromium` 使用 Playwright 浏览器。

若希望使用 TOML 手动配置，Windows 路径可使用单引号字面量，避免反斜杠被解释为转义：

```toml
[mcp_servers.eac-design-world]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\Projects\EAC design world\src\mcp-local.mjs']

[mcp_servers.eac-design-world.env]
EAC_PORT = '4173'
EAC_DATA_DIR = 'D:\EAC data'
```

以上路径为示例，需改为实际位置；FFmpeg/FFprobe 仍须在 Codex 启动环境的 PATH 中，推荐使用前面的命令保存实际 PATH。

也可安装构建后的 npm 包，通过包内 `eac-design-world-mcp` 命令启动。原 `npm run mcp` 保持仅连接 EAC_URL 后端的兼容行为。

## 数据与生命周期

默认地址 http://127.0.0.1:4173。默认数据目录：

- macOS：`~/Library/Application Support/EAC-design-world`
- Windows：`%LOCALAPPDATA%\EAC-design-world`，环境变量缺失时回退到 `~\AppData\Local\EAC-design-world`
- Linux：`$XDG_DATA_HOME/EAC-design-world` 或 `~/.local/share/EAC-design-world`

后台日志为数据目录中的 `server.log`。MCP 标准输出只用于协议，启动提示写到标准错误。项目保存在 `state.json`、`design/`，输出在 `outputs/`，升级代码不覆盖该目录。

服务会持续到手动退出或系统重启；没有安装登录项。需要停服或升级时，先完成任务，通过 `/api/health` 核对 name、version、pid 和 `/api/maintenance` 中的 root、dataDir、mode，确认它是独立服务后再停止。Mac 可向该 PID 发送 SIGTERM；Windows 的 Stop-Process 是终止进程，不等价于可处理的 POSIX SIGTERM，必须先确认任务队列为空。若服务由 DSH 托管，应使用 DSH 的正常退出流程。下一次 MCP 连接会重新启动独立服务。移除 Codex 接入使用 `codex mcp remove eac-design-world`，不会删除项目或停止正在运行的工作台。

## 验证

`tests/local-mcp.test.mjs` 使用真实 SDK 客户端检查自动启动、复用、断开后持久化、按模板 ID 导入，以及 Mac 配音。现有媒体、导出与浏览器测试继续验证生成文件和交互行为。FFmpeg、浏览器、模型和可选模板缺失须单独报告；不以配置存在作为验收通过。

`tests/platform-paths.test.mjs` 在任意平台验证 Windows 盘符、用户安装路径、中文与空格、UNC 路径和覆盖目录的解析。`.github/workflows/local-mcp.yml` 配置 Windows/macOS 的真实进程、浏览器录制、设计导出、任务队列和系统配音测试。添加 CI 配置不代表 CI 已执行；Windows 真机运行结果需要单独记录。
