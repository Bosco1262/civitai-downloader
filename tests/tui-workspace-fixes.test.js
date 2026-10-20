'use strict';

/**
 * Regression tests for the download workspace fixes.
 * 下载工作台修复的回归测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const screen = require('../src/tui/screen');
const tasks = require('../src/tui/tasks');
const storage = require('../src/storage');
const download = require('../src/tui/download');
const job = require('../src/job');
const { showPlanWorkspace } = require('../src/tui/ui/planWorkspace');
const { withFakeTerminal } = require('./helpers/tui');

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-tui-fix-'));
  return {
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    configFile: path.join(root, 'config.json'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
  };
}

test('job: verifyExisting 关闭提前跳过，普通已记录行仍跳过', () => {
  const recorded = { files: [{ name: 'a.bin' }] };
  assert.equal(job.shouldSkipRecorded({}, recorded), true);
  assert.equal(job.shouldSkipRecorded({ verifyExisting: true }, recorded), false);
  assert.equal(job.shouldSkipRecorded({ force: true }, recorded), false);
  assert.equal(job.shouldSkipRecorded({}, { files: [] }), false);
});

test('download: 失败项不进入可下载计划', () => {
  const rows = [
    { modelId: '1', files: [{ name: 'a.bin' }] },
    { modelId: '2', files: [{ name: 'b.bin' }], error: 'boom' },
    null,
  ];
  assert.deepEqual(download.selectablePlan(rows), [{ modelId: '1', files: [{ name: 'a.bin' }] }]);
});

test('download: deletePlanVersions 保护 pinned 版本', () => {
  const config = tempConfig();
  try {
    const file = path.join(config.root, 'Model', 'a.bin');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    storage.writeLibrary(config, {
      1: {
        name: 'Model',
        pinnedVersionId: '1',
        versions: {
          1: { versionName: 'v1', dirName: 'Model', outDir: config.root, files: [{ name: 'a.bin' }] },
        },
      },
    });
    const count = download.deletePlanVersions(config, [{ modelId: '1', versionId: '1' }]);
    assert.equal(count, 0);
    assert.ok(fs.existsSync(file), 'pinned 文件不能被删除');
    assert.ok(storage.readLibrary(config).entries['1'].versions['1']);
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('download: deletePlanVersions 保留其它版本共享的文件', () => {
  const config = tempConfig();
  try {
    const file = path.join(config.root, 'Model', 'shared.bin');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    storage.writeLibrary(config, {
      1: {
        name: 'Model',
        versions: {
          1: { versionName: 'v1', dirName: 'Model', outDir: config.root, files: [{ name: 'shared.bin' }] },
          2: { versionName: 'v2', dirName: 'Model', outDir: config.root, files: [{ name: 'shared.bin' }] },
        },
      },
    });
    const count = download.deletePlanVersions(config, [{ modelId: '1', versionId: '1' }]);
    assert.equal(count, 1);
    assert.ok(fs.existsSync(file), 'v2 仍引用的文件必须保留');
    const entry = storage.readLibrary(config).entries['1'];
    assert.equal(entry.versions['1'], undefined);
    assert.ok(entry.versions['2']);
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('download: 回执页 Enter 回下载子菜单，Esc 回主菜单', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    tasks.reset();
    assert.equal(screen.start({ onQuit: () => {} }), true);

    const first = tasks.createTask({ kind: 'download', name: 'T1', total: 1, totalBytes: 1 });
    const firstPage = download.receiptPage(first);
    await settle();
    key('return');
    assert.equal(await firstPage, 'download');

    const second = tasks.createTask({ kind: 'download', name: 'T2', total: 1, totalBytes: 1 });
    const secondPage = download.receiptPage(second);
    await settle();
    key('escape');
    assert.equal(await secondPage, 'main');
    tasks.reset();
  });
});

test('workspace: 添加多项结果后光标回到第一项', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载模型',
      rows: [],
      selected: new Set(),
      idOf: (row) => row.modelId,
      resolveInput: async () => [
        { modelId: '1', name: 'Alpha' },
        { modelId: '2', name: 'Beta' },
      ],
    });
    await settle();
    key('x', 'x');
    key('return');
    await settle();
    key('tab');
    await settle();
    screen.render();
    const alpha = frame().find((line) => line.includes('Alpha') && line.includes('['));
    const beta = frame().find((line) => line.includes('Beta') && line.includes('['));
    assert.ok(alpha.trimStart().startsWith('▸'), alpha);
    assert.ok(!beta.trimStart().startsWith('▸'), beta);
    key('escape');
    assert.equal(await pending, null);
  });
});

test('workspace: 列表未获得焦点时不显示光标', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载模型',
      rows: [{ modelId: '1', name: 'Alpha' }],
      selected: new Set(['1']),
      idOf: (row) => row.modelId,
    });
    await settle();
    screen.render();
    const before = frame().find((line) => line.includes('Alpha'));
    assert.ok(!before.trimStart().startsWith('▸'), before);
    key('tab');
    await settle();
    screen.render();
    const after = frame().find((line) => line.includes('Alpha'));
    assert.ok(after.trimStart().startsWith('▸'), after);
    key('escape');
    assert.equal(await pending, null);
  });
});
