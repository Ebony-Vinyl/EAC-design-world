import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { browserExecutable } from '../src/browser.mjs';
import { localDataDirectory } from '../src/local-runtime.mjs';

test('Windows discovers system and per-user browsers on non-C drives with Unicode and spaces', () => {
  const env = { ProgramFiles: 'D:\\Program Files', 'ProgramFiles(x86)': 'D:\\Program Files (x86)', LOCALAPPDATA: 'E:\\Users\\测试 用户\\AppData\\Local' };
  for (const [base, suffix] of [
    [env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'],
    [env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    [env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
    [env.LOCALAPPDATA, 'Chromium\\Application\\chrome.exe'],
  ]) {
    const expected = win32.join(base, suffix);
    assert.equal(browserExecutable({ platform: 'win32', env, exists: file => file === expected }), expected);
  }
  const custom = 'F:\\浏览器 目录\\chrome.exe';
  assert.equal(browserExecutable({ platform: 'win32', env: { ...env, EAC_BROWSER: custom }, exists: () => true }), custom);
});

test('Windows missing LocalAppData uses the user AppData directory, and missing browsers remain unavailable', () => {
  const home = 'D:\\Users\\测试';
  const expected = win32.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(browserExecutable({ platform: 'win32', env: {}, home, exists: file => file === expected }), expected);
  assert.equal(browserExecutable({ platform: 'win32', env: {}, home, exists: () => false }), null);
});

test('data directories use target-platform path rules, including Windows UNC and relative overrides', () => {
  const windows = { platform: 'win32', home: 'D:\\Users\\测试', cwd: 'D:\\Projects\\EAC' };
  assert.equal(localDataDirectory({ ...windows, env: {} }), 'D:\\Users\\测试\\AppData\\Local\\EAC-design-world');
  assert.equal(localDataDirectory({ ...windows, env: { LOCALAPPDATA: 'E:\\用户数据' } }), 'E:\\用户数据\\EAC-design-world');
  assert.equal(localDataDirectory({ ...windows, env: { EAC_DATA_DIR: '..\\数据' } }), 'D:\\Projects\\数据');
  assert.equal(localDataDirectory({ ...windows, env: { EAC_DATA_DIR: '\\\\server\\share\\EAC data' } }), '\\\\server\\share\\EAC data');
  assert.equal(localDataDirectory({ platform: 'darwin', home: '/Users/test', env: {} }), '/Users/test/Library/Application Support/EAC-design-world');
  assert.equal(localDataDirectory({ platform: 'linux', home: '/home/test', env: { XDG_DATA_HOME: '/data' } }), '/data/EAC-design-world');
});
