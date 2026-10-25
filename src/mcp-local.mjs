#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureLocalRuntime } from './local-runtime.mjs';

try {
  if (!process.env.EAC_URL) {
    const runtime = await ensureLocalRuntime();
    process.env.EAC_URL = runtime.url;
    console.error(`EAC 工作台：${runtime.url}；数据：${runtime.dataDir}`);
  }
  // mcp.mjs exports createMcpServer and only self-connects when run directly; the local
  // launcher must connect the stdio transport itself.
  const { createMcpServer } = await import('./mcp.mjs');
  await createMcpServer().connect(new StdioServerTransport());
} catch (error) {
  console.error(`EAC MCP 启动失败：${error.message}`);
  process.exitCode = 1;
}
