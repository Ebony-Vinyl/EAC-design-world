import { chromium } from 'playwright';

export async function harnessRpc(method, args = {}) {
  const browser = await chromium.connectOverCDP(process.env.EAC_HARNESS_CDP || 'http://127.0.0.1:9232');
  const page = browser.contexts()[0].pages().find((item) => item.url().startsWith('dsh-app://'));
  return page.evaluate(async ({ method, args }) => {
    const response = await fetch(`api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } })
    });
    return { status: response.status, body: await response.text() };
  }, { method, args });
}
if (process.argv[1]?.endsWith('harness-rpc.mjs')) {
  try {
    const response = await harnessRpc(process.argv[2], JSON.parse(process.argv[3] || '{}'));
    const parsed = JSON.parse(response.body);
    if (process.argv[2]?.startsWith('pluginManager/list') && Array.isArray(parsed.result?.value)) {
      parsed.result.value = parsed.result.value.filter((item) => JSON.stringify(item.name || item.moduleName).includes('eac-design-world'));
    }
    console.log(JSON.stringify({ status: response.status, ...parsed }, null, 2));
  }
  finally { setTimeout(() => process.exit(0), 20); }
}
