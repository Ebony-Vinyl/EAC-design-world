import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolDefinitions, productionInstructions } from './tools.mjs';
import { VERSION } from './version.mjs';

export const workspaceTools = [...toolDefinitions, {
  name: 'workspace_info',
  description: '返回 EAC 可视化工作台、设计编辑器和画布地址；可在浏览器中打开查看同一后端的项目。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}];

// The MCP surface must forward exactly the arguments the engine expects. Forwarding a
// whole argument object is tempting but lets absent fields (e.g. templateId: undefined)
// turn into explicit nulls; building the body conditionally keeps "path" and "templateId"
// mutually exclusive at the HTTP boundary.
export function mcpRoute(name, args = {}) {
  const project = `/api/projects/${encodeURIComponent(args.projectId)}`;
  const routes = {
    status: () => ['GET', '/api/state'],
    project_create: () => ['POST', '/api/projects', args],
    project_get: () => ['GET', project],
    asset_import: () => ['POST', `${project}/assets`, {
      projectId: args.projectId,
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.templateId !== undefined ? { templateId: args.templateId } : {}),
    }],
    timeline_plan: () => ['POST', `${project}/plan`, args],
    timeline_update: () => ['PUT', `${project}/timeline`, args],
    color_workflow: () => ['POST', `${project}/color`, args],
    stock_search: () => ['POST', '/api/stock/search', args],
    job_submit: () => ['POST', '/api/jobs', args],
    job_status: () => ['GET', `/api/jobs/${encodeURIComponent(args.jobId)}`],
    job_cancel: () => ['POST', `/api/jobs/${encodeURIComponent(args.jobId)}/cancel`, {}],
    template_read: () => ['POST', '/api/tools/template_read', args],
    library_read: () => ['POST', '/api/tools/library_read', args],
    library_list: () => ['POST', '/api/tools/library_list', args],
    design_project_create: () => ['POST', '/api/design/projects', args],
    design_artifact_save: () => ['POST', '/api/design/artifacts', args],
    design_state: () => ['GET', `/api/design/state${args.sessionId ? `?sessionId=${encodeURIComponent(args.sessionId)}` : ''}`]
  };
  const route = routes[name];
  return route ? route() : null;
}

export function createMcpServer({ endpoint = process.env.EAC_URL || 'http://127.0.0.1:4173', request = fetch } = {}) {
  const server = new Server({ name: 'eac-design-world', version: VERSION }, {
    capabilities: { tools: {} }, instructions: productionInstructions
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workspaceTools }));
  server.setRequestHandler(CallToolRequestSchema, async (rpcRequest) => {
    try {
      if (rpcRequest.params.name === 'workspace_info') {
        return { content: [{ type: 'text', text: JSON.stringify({ url: endpoint, designUrl: `${endpoint}/?view=design`, canvasUrl: `${endpoint}/?view=canvas` }) }] };
      }
      const route = mcpRoute(rpcRequest.params.name, rpcRequest.params.arguments || {});
      if (!route) throw new Error('Unknown tool');
      const [method, path, data] = route;
      const response = await request(`${endpoint}${path}`, { method, headers: { 'content-type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
  await createMcpServer().connect(new StdioServerTransport());
}
