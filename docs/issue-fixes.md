# GitHub issue 修复与验证记录

本记录对应 2026-10-25 读取到的全部开放反馈：[#4](https://github.com/Ebony-Vinyl/EAC-design-world/issues/4)、[#5](https://github.com/Ebony-Vinyl/EAC-design-world/issues/5)、[#6](https://github.com/Ebony-Vinyl/EAC-design-world/issues/6)。修复纳入 v0.6.0 源码与发布候选；实际发布状态以 GitHub Release 为准，本任务不自动关闭远端 issue。

## 最终验证

- `npm test`：**340 项通过、0 失败、0 跳过**（包含本轮新增的 8 项回归测试）。
- `npm run build`：通过。
- `git diff --check`：通过。
- 实际 pnpm 本地包安装、链接路径启动、健康检查与首次资源还原：通过。

## #4：pnpm 安装后独立服务静默退出

**已修复。** `src/server.mjs` 在判断独立运行入口时，将命令行入口路径与当前模块路径分别经过 `realpath` 后比较，不再比较符号链接路径与真实路径。普通模块导入仍只导出 `startServer()`，不会自动监听端口。

验证包含真实子进程：

- pnpm 风格 `node_modules/eac-design-world` 目录联接路径启动；
- 真实路径启动；
- `--preserve-symlinks-main` 启动；
- 导入链接路径的服务器模块，不自动启动监听。

修复前链接路径测试准确复现“无日志、退出码 0”；修复后各启动路径均得到真实 `/api/health` 响应。回归见 `tests/server-startup.test.mjs`。

同一反馈提到的安装脚本门禁也已处理：移除根包 `postinstall` 及 lockfile 对应标记；`scripts/pack-npm-runtime.mjs` 不再向发布包注入 `postinstall`。资源继续由 `src/catalog.mjs` 在首次加载时从包内还原，重新构建 npm 包时也先还原，不下载、不覆盖已有文件。`tests/npm-install.test.mjs` 与 `tests/npm-assets.test.mjs` 验证发布清单和禁用安装脚本的首次资源还原。

额外使用本机 **pnpm 11.7.0 / Node 24.11.1** 安装本地 tarball，未使用 `--ignore-scripts`，安装退出码 0；从 pnpm 生成的实际 `.pnpm/.../node_modules/` 链接启动成功，并在首次启动后从 HTTP 读取到还原资源。测试包采用当前真实 `src/` 与生产打包清单转换，移除了依赖声明以单独验证 EAC 自身生命周期；没有替代完整发布包的全依赖安装验收。证据见 `artifacts/issue-verification-20261025/pnpm-results.json`。没有声称已实测报告者的 Node 24.15.0 / pnpm 11.28.5。

## #6：`127.*` 公网域名被当作回环地址

**已修复。** 公告源的 IPv4 回环判断同时要求 `node:net` 的 `isIP(host) === 4` 和 `127.` 前缀。保留 `localhost`、IPv6 `::1` 和合法 IPv4 `127/8`；`127.0.0.1.evil.com`、`127.evil.com`、`127.0.0.1.nip.io` 等域名的明文 HTTP 配置被拒绝，回退到默认 HTTPS 源。

`tests/maintenance-feed.test.mjs` 覆盖真实回环、伪装域名、非回环内网、凭据、非法 URL 与协议，并通过可记录请求的 `fetchImpl` 验证拒绝的源根本不进入轮询。测试未访问示例中的任何公网或内网地址。

## #5：公开仓库提交邮箱隐私

**仓库本地后续提交保护已完成；账号级设置仍待所有者确认。** 通过 GitHub API 核验登录名 `Ebony-Vinyl` 与数字 ID 后，为本仓库设置 `245557608+Ebony-Vinyl@users.noreply.github.com`。`git var GIT_AUTHOR_IDENT` 与 `git var GIT_COMMITTER_IDENT` 均显示 noreply 地址。只修改本仓库 `.git/config`，没有修改全局 Git 配置或历史对象。

只读查询显示主邮箱可见性仍为 `public`。需要账号所有者在 [GitHub 邮箱设置](https://github.com/settings/emails) 中启用 **Keep my email addresses private**；也可启用阻止暴露私密邮箱的命令行推送选项。公开历史中的旧邮箱不会因当前配置改变而消失；本次没有重写提交、tag 或 release 引用。

本地 `.git/config` 不属于提交内容，因此该保护不会随着克隆自动传播。其他贡献者应使用自己的 GitHub noreply 地址。
