export async function api(path, options = {}) {
  const { signal, ...rest } = options;
  const response = await fetch(`/api${path}`, {
    ...rest,
    signal: signal || AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', ...rest.headers },
    ...(rest.body !== undefined ? { body: JSON.stringify(rest.body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(response.ok ? '服务返回了无法识别的数据。' : `请求失败（${response.status}），请检查 API 服务。`); }
  if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`);
  return data;
}

export function fileUrl(path) {
  if (!path || typeof path !== 'string') return '';
  if (path.startsWith('/api/files?') || path.startsWith('/vendor/') || /^https?:\/\//i.test(path)) return path;
  return `/api/files?path=${encodeURIComponent(path)}`;
}

/** Attachment URL: forces Content-Disposition on the server instead of inline preview. */
export function downloadUrl(path) {
  if (!path || typeof path !== 'string') return '';
  if (/^https?:\/\//i.test(path)) return path;
  const base = path.startsWith('/api/files?') ? path : `/api/files?path=${encodeURIComponent(path)}`;
  return `${base}${base.includes('?') ? '&' : '?'}download=1`;
}

export function outputPaths(result) {
  if (!result) return [];
  if (typeof result === 'string') return [result];
  if (Array.isArray(result)) return result.flatMap(outputPaths);
  if (typeof result !== 'object') return [];
  const keys = ['path', 'output', 'outputPath', 'outputFile', 'file', 'video', 'videoPath', 'audio', 'audioPath', 'srtPath', 'jsonPath', 'files', 'outputs', 'review'];
  return [...new Set(keys.flatMap(key => outputPaths(result[key])))];
}

export function resultWarnings(result) {
  if (!result || typeof result !== 'object') return [];
  const warnings = [result.warning, ...(Array.isArray(result.warnings) ? result.warnings : []),
    ...(Array.isArray(result.qa?.warnings) ? result.qa.warnings : []),
    ...(result.reviewRequired ? [result.reviewInstruction || '请人工复核转录文字、保留片段与成片。'] : []),
    ...(Array.isArray(result.steps) ? result.steps.flatMap(step => resultWarnings(step.result)) : [])];
  return [...new Set(warnings.filter(value => typeof value === 'string' && value.trim()))];
}

export const jobNames = {
  'record-browser': '网页录制', render: '项目渲染', compose: '原创配乐',
  voice: '旁白生成', analyze: '素材分析', 'render-template': '模板渲染',
  produce: '一键制作', 'record-desktop': '桌面录制', beats: '节拍分析',
  transcribe: '语音转录', 'rough-cut': '口播初剪', captions: '时间线字幕',
  'grade-preview': '调色对比预览', scopes: '示波器图', 'stock-download': '网络素材下载', export: '剪辑工程导出',
};

export const statusNames = {
  queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};
