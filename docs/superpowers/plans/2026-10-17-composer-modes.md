# 输入框模式与模板选择 Implementation Plan

**Goal:** 按用户提供的交互，将输入区改为模式上拉菜单、剪辑模式模板按钮与可关闭的大模板弹窗，消除窄 iframe 和多层滚动。

**Architecture:** 使用宿主正式输入栏槽位挂载紧凑控件，由宿主 React 层负责弹窗与菜单。模板库继续使用本地独立 picker 页面；首页只呈现与输入框对齐的有限推荐，不在状态栏中展开完整 iframe。选模板经原有带修订检查的输入接口加入草稿，不发送消息。

**Tech Stack:** React、宿主 UI slots/primitives、本地 Vite picker、Node test runner。

---

- [x] 检查宿主 `conversation.input.left`、首页与弹层接口，确定空白态和已有会话的一致挂载方式。
- [x] 在 `tests/plugin.test.mjs` 先更新输入栏挂载与恢复选择的契约断言，并运行确认旧实现无法满足。
- [x] 修改 `plugin/client.js`：正常/剪辑/Design（即将推出）上拉菜单，剪辑模式旁显示模板按钮；宿主层弹窗包含明确标题、关闭按钮、响应式 iframe 和加载/错误反馈；模板选中成功关闭，失败保留重试。
- [x] 修改 `ui/main.jsx` 与 `ui/styles.css`：picker 专用视口布局，固定工具区、单一列表滚动，统一选中状态，不受工作台选中项目影响。用消息桥同步初始选择与 Escape 关闭。
- [x] 加入首次模板推荐并确保不挤占底栏空间；仅通过可验证的宿主接口实现。
- [x] 运行 `node --test tests/plugin.test.mjs`、`npm test`、`npm run build`，检查实际页面的模板搜索/选择、上拉菜单、弹窗关闭与草稿保留、窄屏溢出。
- [x] 更新 `docs/harness-ai-workflow.md` 与验证证据。所有改动保持未提交；本任务未获得提交或发布授权。
