import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './catalog.mjs';
import { VERSION } from './version.mjs';
import { MaintenanceUpdater, PINNED_MANIFEST_PUBLIC_KEY } from './maintenance-updater.mjs';
import { AnnouncementFeed, DEFAULT_FEED_SOURCES } from './maintenance-feed.mjs';
import { watchPackage, isReloading } from './maintenance-reload.mjs';

const stateKey = Symbol.for('eac-design-world.maintenance.operations');
const shared = globalThis[stateKey] ??= new Map();
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const json = value => JSON.parse(JSON.stringify(value));

export function createMaintenance({ engine, root = ROOT, runningVersion = VERSION, mode = 'standalone', reload,
  manifestPublicKey = PINNED_MANIFEST_PUBLIC_KEY, manifestSources, feedSources = DEFAULT_FEED_SOURCES,
  fetchImpl = fetch, logger = console } = {}) {
  const dataDir = join(engine.store.root, 'maintenance');
  mkdirSync(dataDir, { recursive: true });
  const settingsFile = join(dataDir, 'settings.json');
  const operationFile = join(dataDir, 'operation.json');
  if (!shared.has(dataDir)) {
    const previous = readJson(operationFile, null);
    if (previous?.status === 'running') {
      const interrupted = { ...previous, status: 'failed', error: '维护进程已中断，请检查运行版本及备份后重试', finishedAt: Date.now() };
      shared.set(dataDir, interrupted);
      writeFileSync(operationFile, JSON.stringify(interrupted, null, 2) + '\n');
    }
  }
  const defaults = { autoReloadWatch: false, feedPollMinutes: 30, updateCheckHours: 24, announcementsAcked: [] };
  let settings = { ...defaults, ...readJson(settingsFile, {}) };
  let disposed = false;
  let watcher;
  let interval;
  let initialPoll;
  const instanceId = randomUUID(), startedAt = new Date().toISOString();
  const write = (path, value) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    renameSync(temporary, path);
  };
  const updater = new MaintenanceUpdater({ pkgDir: root, dataDir, settings: () => settings,
    runningVersion, manifestPublicKey, ...(manifestSources ? { defaultSources: manifestSources } : {}), fetchImpl,
    log: message => logger.info?.(message) });
  const feed = new AnnouncementFeed({ settings: () => settings, cacheFile: join(dataDir, 'announcements.json'), defaultSources: feedSources,
    log: message => logger.info?.(message) });
  feed.load();
  if (!feed.cache.announcements.length && existsSync(join(root, 'feed/announcements.json'))) {
    feed.load(readFileSync(join(root, 'feed/announcements.json'), 'utf8'));
    feed.cache.source = 'bundled';
  }
  const activeJobs = () => engine.store.state.jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
  const operation = () => shared.get(dataDir) || readJson(operationFile, null);
  const persistOperation = value => { shared.set(dataDir, value); write(operationFile, value); };
  engine.setMaintenanceMode(() => operation()?.status === 'running' && operation()?.type !== 'check');
  const ensureIdle = () => {
    if (activeJobs()) throw new Error('还有制作任务正在运行或排队，完成后才能更新或重载');
    if (operation()?.status === 'running' || isReloading() || updater.status().applying) throw new Error('已有维护任务正在进行');
  };
  const canReload = typeof reload === 'function';
  const status = () => {
    const update = updater.status();
    const currentOperation = operation();
    return json({ runningVersion, installedVersion: update.installedVersion, versionMismatch: update.installedVersion !== runningVersion,
      instanceId, startedAt, root, dataDir: engine.store.root, mode,
      reload: { available: canReload, watching: Boolean(watcher), last: currentOperation?.type === 'reload' ? currentOperation : null },
      busy: { activeJobs: activeJobs(), operation: currentOperation?.status === 'running' },
      updates: { ...update, signingConfigured: Boolean(manifestPublicKey), rollbackAvailable: update.rollbackAvailable ?? existsSync(join(updater.backupDir, 'snapshot.json')) },
      announcements: feed.view({ ackedIds: settings.announcementsAcked }),
      settings: { autoReloadWatch: settings.autoReloadWatch, feedPollMinutes: settings.feedPollMinutes, updateCheckHours: settings.updateCheckHours },
      operation: currentOperation });
  };
  const activate = async installed => {
    if (!canReload) throw new Error('当前未连接宿主热重载服务，请在 Harness 插件中安装更新');
    const result = await reload({ expectedVersion: installed.version });
    if (!result?.ok) throw Object.assign(new Error(result?.error || '宿主未确认重载成功'), { runtimeRestored: result?.restored === true });
    return result;
  };
  const start = (type, args = {}) => {
    if (!['reload', 'apply', 'local', 'rollback', 'check'].includes(type)) throw new Error('未知维护操作');
    if (type !== 'check') {
      if (!canReload) throw new Error('当前是独立服务，宿主热重载不可用；请在 Harness 插件中操作');
      ensureIdle();
      if (type !== 'rollback' && updater.status().recoveryRequired) throw new Error('上次更新需要恢复，请先回滚备份');
    } else if (operation()?.status === 'running') throw new Error('已有维护任务正在进行');
    const record = { id: randomUUID(), type, status: 'running', startedAt: Date.now() };
    persistOperation(record);
    setTimeout(async () => {
      try {
        const onProgress = progress => persistOperation({ ...record, progress });
        let result;
        if (type === 'check') result = await updater.check();
        else if (type === 'reload') result = await activate({ version: updater.currentVersion() });
        else if (type === 'apply') result = await updater.apply({ version: args.version, onProgress, activate });
        else if (type === 'local') result = await updater.applyLocal({ manifestPath: args.manifestPath, allowUnsigned: args.allowUnsigned === true, onProgress, activate });
        else result = await updater.rollback({ activate });
        if (result?.ok === false) throw new Error(result.error || '维护操作失败');
        persistOperation({ ...record, status: 'completed', finishedAt: Date.now(), result });
      } catch (error) {
        persistOperation({ ...record, status: 'failed', finishedAt: Date.now(), error: error.message });
      }
    }, 80);
    return { operationId: record.id, accepted: true };
  };
  const syncWatcher = () => {
    if (settings.autoReloadWatch && canReload && !watcher) watcher = watchPackage(root, { logger, onChange: () => {
      if (disposed || activeJobs() || operation()?.status === 'running') return;
      try { start('reload'); } catch (error) { logger.warn?.(error.message); }
    } });
    if ((!settings.autoReloadWatch || !canReload) && watcher) { watcher(); watcher = undefined; }
  };
  syncWatcher();
  let lastFeedPoll = Date.now(), lastUpdatePoll = Date.now();
  initialPoll = setTimeout(() => {
    if (!disposed && mode === 'harness' && feedSources.length) void feed.poll();
  }, 5000);
  initialPoll.unref?.();
  interval = setInterval(() => {
    if (disposed || operation()?.status === 'running') return;
    if (Date.now() - lastFeedPoll > settings.feedPollMinutes * 60000) { lastFeedPoll = Date.now(); void feed.poll(); }
    if (Date.now() - lastUpdatePoll > settings.updateCheckHours * 3600000) {
      lastUpdatePoll = Date.now(); if (manifestPublicKey) void updater.check().catch(() => {});
    }
  }, 60000);
  interval.unref?.();
  return {
    status, start, updater,
    async refreshAnnouncements() { await feed.poll(); return status(); },
    async acknowledge(ids) {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('公告 ID 格式无效');
      settings.announcementsAcked = [...new Set([...settings.announcementsAcked, ...ids])].slice(-500);
      write(settingsFile, settings); return status();
    },
    async settingsUpdate(input) {
      for (const key of ['feedPollMinutes', 'updateCheckHours']) {
        if (input[key] === undefined) continue;
        if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > (key === 'feedPollMinutes' ? 1440 : 720)) throw new Error(`无效维护设置：${key}`);
        settings[key] = input[key];
      }
      if (input.autoReloadWatch !== undefined) {
        if (typeof input.autoReloadWatch !== 'boolean') throw new Error('autoReloadWatch 必须是布尔值');
        if (input.autoReloadWatch && !canReload) throw new Error('宿主热重载不可用');
        settings.autoReloadWatch = input.autoReloadWatch;
      }
      write(settingsFile, settings); syncWatcher(); return status();
    },
    async close() { disposed = true; clearTimeout(initialPoll); clearInterval(interval); watcher?.(); watcher = undefined; },
  };
}
