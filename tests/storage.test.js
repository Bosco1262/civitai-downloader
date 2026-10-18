'use strict';

/**
 * Unit tests for src/storage.js: library paths, library read/write, collection snapshots, legacy
 * cleanup and the global lock.
 *
 * src/storage.js 单元测试：模型库路径、模型库读写、收藏集快照、旧格式清理与全局锁。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../src/storage');
const { StateCorruptError, AppError } = require('../src/errors');

function makeConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-storage-'));
  return { dataDir, outDir: path.join(dataDir, 'downloads') };
}

test('dataPaths / libraryPath / collectionPath: 统一的数据文件路径', () => {
  const config = makeConfig();
  const p = storage.dataPaths(config, 161131);
  assert.equal(storage.libraryPath(config), path.join(config.dataDir, 'library.json'));
  assert.equal(storage.collectionPath(config, 161131), path.join(config.dataDir, 'collections', '161131.json'));
  assert.equal(p.library, path.join(config.dataDir, 'library.json'));
  assert.equal(p.log, path.join(config.dataDir, 'download-161131.log'));
  assert.equal(p.lock, path.join(config.dataDir, 'library.lock'), '锁是全局的');
  assert.equal(p.queue, path.join(config.dataDir, 'queue-161131.json'));
  assert.equal(p.targetId, '161131');
  assert.equal(p.state, undefined, '不再有按目标分文件的状态路径');
});

test('readLibrary: 文件不存在时返回空记录', () => {
  const config = makeConfig();
  const r = storage.readLibrary(config);
  assert.deepEqual(r.entries, {});
  assert.equal(r.corrupt, null);
  assert.equal(r.migrated, false);
  assert.equal(r.exists, false);
});

test('readLibrary/writeLibrary: 往返一致且写入 schemaVersion', () => {
  const config = makeConfig();
  const entries = {};
  storage.upsertVersion(entries, 42, {
    name: 'Model A',
    type: 'LORA',
    baseModel: 'SDXL',
    versionId: 123,
    versionName: 'v1',
    dirName: 'Lora/Model A',
    outDir: 'D:/models',
    files: [{ fileId: 9, name: 'a.safetensors', remoteName: 'a.safetensors', sha256: 'ab', bytes: 10 }],
  });
  storage.writeLibrary(config, entries);

  const raw = JSON.parse(fs.readFileSync(storage.libraryPath(config), 'utf8'));
  assert.equal(raw.schemaVersion, storage.LIBRARY_SCHEMA);
  assert.ok(raw.updatedAt);
  assert.ok(raw.entries['42']);

  const r = storage.readLibrary(config);
  assert.equal(r.migrated, false);
  assert.equal(r.exists, true);
  const entry = r.entries['42'];
  assert.equal(entry.type, 'LORA');
  assert.equal(entry.baseModel, 'SDXL');
  const versions = storage.entryVersions(entry);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionId, '123', 'versionId 作为键并统一为字符串');
  assert.equal(versions[0].files[0].fileId, 9);
  assert.equal(versions[0].files[0].sha256, 'AB', 'sha256 统一大写');
  assert.equal(storage.getVersion(entry, 123).dirName, 'Lora/Model A');
});

test('upsertVersion: 同一模型保留多个版本，写入互不覆盖', () => {
  const config = makeConfig();
  const entries = {};
  storage.upsertVersion(entries, 42, {
    name: 'Model A',
    versionId: 1,
    versionName: 'v1',
    dirName: 'Model A',
    outDir: 'D:/models',
    files: [{ name: 'a-v1.safetensors', sha256: 'AA', bytes: 1 }],
  });
  storage.upsertVersion(entries, 42, {
    name: 'Model A',
    versionId: 2,
    versionName: 'v2',
    dirName: 'Model A',
    outDir: 'D:/models',
    files: [{ name: 'a-v2.safetensors', sha256: 'BB', bytes: 2 }],
  });
  storage.writeLibrary(config, entries);

  const { entries: back } = storage.readLibrary(config);
  const entry = back['42'];
  assert.deepEqual(storage.versionIds(entry).sort(), ['1', '2']);
  assert.equal(storage.getVersion(entry, 1).files[0].name, 'a-v1.safetensors');
  assert.equal(storage.getVersion(entry, 2).files[0].name, 'a-v2.safetensors');
  assert.equal(storage.getVersion(entry, 2).dirName, 'Model A', '同一模型的版本共用一个目录');
  assert.equal(entry.legacy, undefined);
});

test('upsertVersion: 重复写入同一版本是覆盖更新，不产生重复', () => {
  const entries = {};
  storage.upsertVersion(entries, 7, { name: 'M', versionId: '9', outDir: 'D:/x', files: [{ name: 'a', sha256: 'AA', bytes: 1 }] });
  storage.upsertVersion(entries, 7, { name: 'M', versionId: '9', outDir: 'D:/x', files: [{ name: 'a', sha256: 'CC', bytes: 3 }] });
  assert.deepEqual(storage.versionIds(entries['7']), ['9']);
  assert.equal(storage.getVersion(entries['7'], '9').files[0].sha256, 'CC');
});

test('upsertVersion: 记录站点详情与模型字段（缺省时保留上次的值）', () => {
  const entries = {};
  const site = {
    id: 5,
    name: 'v5',
    baseModel: 'SDXL',
    publishedAt: '2024-01-02T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    trainedWords: ['lora', 'style'],
    description: 'x'.repeat(9000),
    availability: 'Public',
    stats: { downloadCount: 3 },
    files: [{ id: 1, name: 'a.safetensors', type: 'Model', primary: true }],
  };
  storage.upsertVersion(entries, 7, {
    name: 'Model',
    type: 'LORA',
    model: { creator: { username: 'alice' }, stats: { downloadCount: 10 }, nsfw: false, mode: 'Archived' },
    site,
    versionId: 5,
    dirName: 'Lora/Model',
    outDir: 'D:/x',
    files: [{ name: 'a.safetensors', sha256: 'AA', bytes: 1 }],
  });
  const rec = storage.getVersion(entries['7'], 5);
  assert.equal(rec.versionName, 'v5');
  assert.equal(rec.baseModel, 'SDXL');
  assert.equal(rec.publishedAt, '2024-01-02T00:00:00.000Z');
  assert.deepEqual(rec.trainedWords, ['lora', 'style']);
  assert.equal(rec.stats.downloadCount, 3);
  assert.equal(rec.availability, 'Public');
  assert.equal(rec.description.length, storage.SITE_TEXT_LIMIT + 1, '描述截断到上限');
  assert.ok(rec.site && rec.site.files, '原始站点对象被保留（含 files）');
  assert.equal(entries['7'].creator.username, 'alice');
  assert.equal(entries['7'].nsfw, false);
  assert.equal(entries['7'].mode, 'Archived');

  // A later partial write (for example a repair) must not drop the recorded details
  // 之后的局部写入（例如修复）不应丢掉已记录的详情
  storage.upsertVersion(entries, 7, {
    name: 'Model',
    versionId: 5,
    dirName: 'Lora/Model',
    outDir: 'D:/x',
    files: [{ name: 'a.safetensors', sha256: 'AA', bytes: 1 }],
  });
  const again = storage.getVersion(entries['7'], 5);
  assert.equal(again.versionName, 'v5');
  assert.equal(again.stats.downloadCount, 3);
  assert.ok(again.site);
  assert.equal(entries['7'].creator.username, 'alice');
});

test('removeVersion / removeModel / setPinnedVersion', () => {
  const entries = {};
  storage.upsertVersion(entries, 5, { name: 'M', versionId: 1, outDir: 'D:/x', files: [] });
  storage.upsertVersion(entries, 5, { name: 'M', versionId: 2, outDir: 'D:/x', files: [] });

  assert.equal(storage.setPinnedVersion(entries, 5, 1), true);
  assert.equal(entries['5'].pinnedVersionId, '1');
  storage.setPinnedVersion(entries, 5, null);
  assert.equal(entries['5'].pinnedVersionId, null);
  assert.equal(storage.setPinnedVersion(entries, 999, 1), false, '不存在的模型返回 false');

  const removed = storage.removeVersion(entries, 5, 1);
  assert.equal(removed.versionId, '1');
  assert.deepEqual(storage.versionIds(entries['5']), ['2']);

  const entry = storage.removeModel(entries, 5);
  assert.ok(entry);
  assert.equal(entries['5'], undefined);
  assert.equal(storage.removeVersion(entries, 5, 2), null, '已删除的模型返回 null');
});

test('newestVersion / currentVersionId: 按完成时间取最近一次，固定优先', () => {
  const entries = {};
  storage.upsertVersion(entries, 3, { name: 'M', versionId: 1, outDir: 'D:/x', files: [] });
  entries['3'].versions['1'].verifiedAt = '2026-01-01T00:00:00.000Z';
  storage.upsertVersion(entries, 3, { name: 'M', versionId: 2, outDir: 'D:/x', files: [] });
  entries['3'].versions['2'].verifiedAt = '2026-05-05T00:00:00.000Z';
  assert.equal(storage.newestVersion(entries['3']).versionId, '2');
  assert.equal(storage.currentVersionId(entries['3']), '2');
  storage.setPinnedVersion(entries, 3, 1);
  assert.equal(storage.currentVersionId(entries['3']), '1');
  assert.equal(storage.currentVersionId(null), null);
});

test('readLibrary: 缺少 entries 顶层按损坏处理', () => {
  const config = makeConfig();
  fs.writeFileSync(storage.libraryPath(config), JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.throws(() => storage.readLibrary(config), (e) => e instanceof StateCorruptError && /entries/.test(e.message));
  const tolerant = storage.readLibrary(config, { allowCorrupt: true });
  assert.deepEqual(tolerant.entries, {});
  assert.ok(tolerant.corrupt instanceof StateCorruptError);
});

test('readLibrary: schemaVersion 不是当前版本时标记 migrated', () => {
  const config = makeConfig();
  fs.writeFileSync(
    storage.libraryPath(config),
    JSON.stringify({ schemaVersion: 99, entries: { 1: { name: 'x', versions: {} } } }),
    'utf8'
  );
  const r = storage.readLibrary(config);
  assert.equal(r.migrated, true);
  assert.equal(r.entries['1'].name, 'x');
});

test('listCollectionIds: 扫描收藏集快照', () => {
  const config = makeConfig();
  storage.writeCollection(config, 222, { items: [] });
  storage.writeCollection(config, 111, { items: [] });
  assert.deepEqual(storage.listCollectionIds(config), ['111', '222']);
  assert.deepEqual(storage.listCollectionIds({ dataDir: path.join(config.dataDir, 'nope') }), []);
});

test('writeLibrary: 第二次写入保留 .bak', () => {
  const config = makeConfig();
  storage.writeLibrary(config, { a: { name: 'x', versions: {} } });
  storage.writeLibrary(config, { a: { name: 'y', versions: {} } });
  const bak = JSON.parse(fs.readFileSync(`${storage.libraryPath(config)}.bak`, 'utf8'));
  assert.equal(bak.entries.a.name, 'x');
});

test('readLibrary: 损坏文件抛错并自动备份（allowCorrupt 返回空）', () => {
  const config = makeConfig();
  fs.writeFileSync(storage.libraryPath(config), '{"a":', 'utf8');

  assert.throws(() => storage.readLibrary(config), (e) => {
    assert.ok(e instanceof StateCorruptError, '应为 StateCorruptError');
    assert.ok(e.backupFile, '应给出备份路径');
    assert.ok(fs.existsSync(e.backupFile), '备份文件应存在');
    return true;
  });

  const tolerant = storage.readLibrary(config, { allowCorrupt: true });
  assert.deepEqual(tolerant.entries, {});
  assert.ok(tolerant.corrupt instanceof StateCorruptError);
});

test('readLibrary: 顶层不是对象按损坏处理', () => {
  const config = makeConfig();
  fs.writeFileSync(storage.libraryPath(config), '[1,2,3]', 'utf8');
  assert.throws(() => storage.readLibrary(config), StateCorruptError);
});

test('writeCollection: 首次写入无变化；随后可算出新增/移除/版本变化', () => {
  const config = makeConfig();
  const first = storage.writeCollection(config, '777', {
    items: [
      { modelId: 1, name: 'A', versionId: 10 },
      { modelId: 2, name: 'B', versionId: 20 },
    ],
  });
  assert.equal(first.collectionId, '777');
  assert.deepEqual(first.changes.added, []);
  assert.deepEqual(first.changes.removed, []);
  assert.deepEqual(first.changes.versionChanged, []);
  assert.equal(first.changes.previousFetchedAt, null);

  const second = storage.writeCollection(config, '777', {
    items: [
      { modelId: 1, name: 'A', versionId: 11 },
      { modelId: 3, name: 'C', versionId: 30 },
    ],
  });
  assert.deepEqual(second.changes.added, [{ modelId: 3, name: 'C' }]);
  assert.deepEqual(second.changes.removed, [{ modelId: 2, name: 'B' }]);
  assert.deepEqual(second.changes.versionChanged, [
    { modelId: 1, name: 'A', fromVersionId: 10, toVersionId: 11 },
  ]);
  assert.equal(second.changes.previousFetchedAt, first.fetchedAt);

  const { snapshot } = storage.readCollection(config, '777');
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].versionName, null, '快照条目补齐缺失字段');
  assert.equal(snapshot.changes.added.length, 1);
});

test('cleanupLegacy: 旧格式文件移入 .data/legacy 并回报数量', () => {
  const config = makeConfig();
  fs.writeFileSync(path.join(config.dataDir, 'state-161131.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(config.dataDir, 'items-161131.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(config.dataDir, 'plan-1.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(config.dataDir, 'report-1.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(config.dataDir, 'library.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(config.dataDir, 'cookies.txt'), 'keep', 'utf8');

  const lines = [];
  const moved = storage.cleanupLegacy(config, (m) => lines.push(m));
  assert.equal(moved, 4);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /legacy/);
  for (const name of ['state-161131.json', 'items-161131.json', 'plan-1.json', 'report-1.json']) {
    assert.ok(fs.existsSync(path.join(storage.legacyDir(config), name)), `${name} 应被移动`);
  }
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'state-161131.json')));
  assert.equal(fs.readFileSync(path.join(config.dataDir, 'cookies.txt'), 'utf8'), 'keep', '其它文件不动');
  assert.ok(fs.existsSync(storage.libraryPath(config)), 'library.json 不会被当成旧文件');
});

test('cleanupLegacy: 没有旧文件时返回 0 且不写日志', () => {
  const config = makeConfig();
  const lines = [];
  assert.equal(storage.cleanupLegacy(config, (m) => lines.push(m)), 0);
  assert.deepEqual(lines, []);
});

test('acquireLock: 全局锁的互斥、释放、陈旧锁接管与 force 抢占', async () => {
  const config = makeConfig();
  const lock = storage.acquireLock(config);
  assert.equal(lock.file, path.join(config.dataDir, 'library.lock'));
  assert.ok(fs.existsSync(lock.file));

  assert.throws(() => storage.acquireLock(config), (e) => e instanceof AppError);
  assert.throws(() => storage.acquireLock(config), /另一个进程/);

  lock.release();
  const lock2 = storage.acquireLock(config);
  lock2.release();

  // Stale lock: with staleMs set to 1ms, it can be taken over after a short wait
  // 陈旧锁：staleMs 设为 1ms，稍等后即可接管
  const stale = storage.acquireLock(config, { staleMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const taken = storage.acquireLock(config, { staleMs: 1 });
  taken.release();
  assert.ok(!fs.existsSync(`${stale.file}.missing`));

  const forced = storage.acquireLock(config);
  const forced2 = storage.acquireLock(config, { force: true });
  forced2.release();
  try {
    forced.release();
  } catch (e) {
    // Ignore
    // 忽略
  }
});

test('rotateLog: 超阈值时轮转为 .1', () => {
  const config = makeConfig();
  const file = storage.dataPaths(config, 9).log;
  fs.writeFileSync(file, 'x'.repeat(100), 'utf8');
  assert.equal(storage.rotateLog(file, 1000), false);
  assert.equal(storage.rotateLog(file, 10), true);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(!fs.existsSync(file));

  fs.writeFileSync(file, 'y'.repeat(100), 'utf8');
  storage.rotateLog(file, 10);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 100, '旧的 .1 被覆盖');
});

test('createRunLogger: 落盘、计时与轮转', () => {
  const config = makeConfig();
  const lines = [];
  const logger = storage.createRunLogger(config, 3, { sink: (m) => lines.push(m) });
  logger.log('第一行');
  logger.trace('仅文件');
  logger.mark();
  const t = logger.phase('测试阶段');
  assert.ok(t >= 0);
  logger.log('第二行');

  const text = fs.readFileSync(logger.logFile, 'utf8');
  assert.match(text, /第一行/);
  assert.match(text, /仅文件/);
  assert.match(text, /第二行/);
  assert.deepEqual(lines, ['第一行', '第二行'], 'sink 只收到终端可见的行');
  assert.equal(logger.timings.length, 1);
  assert.equal(logger.timings[0].label, '测试阶段');
  assert.ok(logger.elapsedMs() >= 0);
});

test('singleModelKey: 单模型的任务标签（日志/断点清单用）', () => {
  assert.equal(storage.singleModelKey(222), 'model-222');
  assert.equal(storage.isSingleModelKey('model-222'), true);
  assert.equal(storage.isSingleModelKey('222'), false);
  assert.equal(storage.modelIdFromKey('model-222'), '222');
  assert.equal(storage.modelIdFromKey('222'), null);
});
