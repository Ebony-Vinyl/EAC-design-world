#!/usr/bin/env node
import { ensureLocalRuntime } from './local-runtime.mjs';

try {
  if (!process.env.EAC_URL) {
    const runtime = await ensureLocalRuntime();
    process.env.EAC_URL = runtime.url;
    console.error(`EAC 工作台：${runtime.url}；数据：${runtime.dataDir}`);
  }
  await import('./mcp.mjs');
} catch (error) {
  console.error(`EAC MCP 启动失败：${error.message}`);
  process.exitCode = 1;
}
