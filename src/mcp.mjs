import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, productionInstructions } from './tools.mjs';
import { VERSION } from './version.mjs';

const endpoint = process.env.EAC_URL || 'http://127.0.0.1:4173';
const localTools = [...toolDefinitions, { name: 'workspace_info', description: '返回 EAC 可视化工作台、设计编辑器和画布地址；可在浏览器中打开查看同一后端的项目。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
const server = new Server({ name: 'eac-design-world', version: VERSION }, {
  capabilities: { tools: {} }, instructions: productionInstructions
});
const routes = {
  status: () => ['GET', '/api/state'],
  project_create: (a) => ['POST', '/api/projects', a],
  project_get: (a) => ['GET', `/api/projects/${encodeURIComponent(a.projectId)}`],
  asset_import: (a) => ['POST', `/api/projects/${encodeURIComponent(a.projectId)}/assets`, a],
  timeline_plan: (a) => ['POST', `/api/projects/${encodeURIComponent(a.projectId)}/plan`, a],
  timeline_update: (a) => ['PUT', `/api/projects/${encodeURIComponent(a.projectId)}/timeline`, a],
  job_submit: (a) => ['POST', '/api/jobs', a],
  job_status: (a) => ['GET', `/api/jobs/${encodeURIComponent(a.jobId)}`],
  job_cancel: (a) => ['POST', `/api/jobs/${encodeURIComponent(a.jobId)}/cancel`, {}],
  template_read: (a) => ['POST', '/api/tools/template_read', a],
  library_read: (a) => ['POST', '/api/tools/library_read', a],
  library_list: (a) => ['POST', '/api/tools/library_list', a],
  design_project_create: (a) => ['POST', '/api/design/projects', a],
  design_artifact_save: (a) => ['POST', '/api/design/artifacts', a],
  design_state: (a) => ['GET', `/api/design/state${a.sessionId ? `?sessionId=${encodeURIComponent(a.sessionId)}` : ''}`]
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: localTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === 'workspace_info') return { content: [{ type: 'text', text: JSON.stringify({ url: endpoint, designUrl: `${endpoint}/?view=design`, canvasUrl: `${endpoint}/?view=canvas` }) }] };
    const route = routes[request.params.name];
    if (!route) throw new Error('Unknown tool');
    const [method, path, data] = route(request.params.arguments || {});
    const response = await fetch(`${endpoint}${path}`, { method, headers: { 'content-type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
