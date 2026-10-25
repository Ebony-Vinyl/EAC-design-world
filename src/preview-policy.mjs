export function previewCsp(kind, origin, assetBase = "'none'") {
  const sources = origin ? [origin] : [];
  if (origin) {
    const alias = new URL(origin);
    if (alias.hostname === '127.0.0.1' || alias.hostname === 'localhost') {
      alias.hostname = alias.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      sources.push(alias.origin);
    }
  }
  const local = sources.length ? [...new Set(sources)].join(' ') : "'none'";
  if (kind === 'svg') return `sandbox; default-src 'none'; style-src 'unsafe-inline' ${local}; img-src data: blob: ${local}; font-src data: ${local}`;
  if (kind === 'markdown') return "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  return `sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' ${local}; style-src 'unsafe-inline' ${local}; img-src data: blob: ${local}; font-src data: ${local}; media-src data: blob: ${local}; connect-src 'none'; base-uri ${assetBase}; form-action 'none'`;
}
