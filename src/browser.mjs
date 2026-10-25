import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

// One resolution policy for capability reporting, capture, rendering and export.
export function browserExecutable({ env = process.env, platform = process.platform, exists = existsSync, home = homedir() } = {}) {
  const explicit = env.EAC_BROWSER || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) {
    if (!exists(explicit)) throw new Error(`浏览器不存在：${explicit}；请检查 EAC_BROWSER`);
    return explicit;
  }
  const windowsRoots = [...new Set([
    env.ProgramFiles, env.PROGRAMFILES, env['ProgramFiles(x86)'], env['PROGRAMFILES(X86)'], env.ProgramW6432,
    'C:/Program Files', 'C:/Program Files (x86)',
    env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'),
  ].filter(Boolean))];
  const candidates = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : platform === 'win32' ? [
    ...windowsRoots.map(root => win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...windowsRoots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...windowsRoots.map(root => win32.join(root, 'Chromium', 'Application', 'chrome.exe')),
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(exists) || null;
}

export function browserLaunchOptions(chromium) {
  const executablePath = browserExecutable() || chromium.executablePath();
  if (!existsSync(executablePath)) throw new Error('未找到 Chromium 浏览器，请安装 Chrome 或设置 EAC_BROWSER');
  return { executablePath, headless: true };
}
