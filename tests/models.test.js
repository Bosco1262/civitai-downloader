'use strict';

/**
 * Core logic tests for the model library (one model, several versions):
 *  - Downloading several versions of one model → one shared directory, every record kept
 *  - Name clashes between versions → both sides get their version suffix
 *  - Switching back to an older version does not download it again
 *  - The checkModelUpdates categories (latest / updated / pinned / file changed / missing / not downloaded / history)
 *
 * 模型库（一个模型多个版本）的核心逻辑测试：
 *  - 同一模型下载多个版本 → 共用一个目录、记录各自保留
 *  - 版本之间文件名冲突 → 双方都加版本后缀
 *  - 切回旧版本不重复下载
 *  - checkModelUpdates 的各种分类（最新 / 有更新 / 已固定 / 文件变化 / 缺失 / 未下载 / 历史版本）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runDownloadJob } = require('../src/job');
const { checkModelUpdates, changedItems, summarize, reportLines, markForRedownload, checkUpdates } = require('../src/updater');
const { readLibrary, writeLibrary, upsertVersion, getVersion, versionIds } = require('../src/storage');
const { validateConfig, DEFAULTS } = require('../src/config');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-models-${tag}-`));
}

function makeConfig() {
  const root = tempDir('cfg');
  const config = validateConfig({
    ...DEFAULTS,
    site: 'http://127.0.0.1:1',
    outDir: path.join(root, 'downloads'),
    profileDir: path.join(root, 'profile'),
    userAgent: 'test-agent',
    retries: 0,
    apiRateLimit: 0,
  });
  config.root = root;
  config.dataDir = path.join(root, '.data');
  config.cookiesFile = path.join(config.dataDir, 'cookies.txt');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.cookiesFile, '# Netscape HTTP Cookie File\n', 'utf8');
  return config;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function versionObj(id, name, fileName, content, fileId) {
  return {
    id,
    name,
    baseModel: 'SDXL',
    files: [
      {
        id: fileId,
        name: fileName,
        type: 'Model',
        primary: true,
        sizeKB: content.length / 1024,
        hashes: { SHA256: sha(content) },
        downloadUrl: `https://civitai.com/api/download/models/${id}?fileId=${fileId}`,
      },
    ],
  };
}

function modelDetail(id, name, versions) {
  return { id, name, type: 'LORA', modelVersions: versions };
}

/**
 * deps used only for downloading (no browser/curl/network).
 * 只下载用的 deps（不碰浏览器/curl/网络）
 */
function downloadDeps(contentByName) {
  const fakePage = {
    url: () => 'https://civitai.red/',
    goto: async () => {},
    waitForFunction: async () => {},
    createCDPSession: async () => ({ send: async () => ({ cookies: [] }) }),
    evaluate: async () => ({ status: 200, text: '{}' }),
  };
  return {
    ensureBrowser: async () => ({ pages: async () => [], newPage: async () => fakePage, disconnect: async () => {} }),
    findSitePage: async () => fakePage,
    openUrl: async () => fakePage,
    exportCookies: async () => [],
    checkCurl: () => 'curl',
    downloadFile: async (opts) => {
      const content = contentByName[path.basename(opts.fileName)] || Buffer.from('x');
      fs.mkdirSync(opts.dir, { recursive: true });
      fs.writeFileSync(path.join(opts.dir, opts.fileName), content);
      return 'downloaded';
    },
    notify: async () => {},
  };
}

function planItem({ modelId, name, type = 'LORA', versionId, versionName, fileName, content, fileId }) {
  return {
    modelId,
    name,
    type,
    versionId,
    versionName,
    versionMeta: versionObj(versionId, versionName, fileName, content, fileId),
    files: [
      {
        fileId,
        name: fileName,
        remoteName: fileName,
        sha256: sha(content),
        bytes: content.length,
        downloadUrl: `https://civitai.com/api/download/models/${versionId}?fileId=${fileId}`,
      },
    ],
    totalBytes: content.length,
  };
}

/**
 * Run one download for a single model.
 * 为单个模型跑一次下载。
 */
function runOne(config, deps, item, extra = {}) {
  return runDownloadJob(
    config,
    {
      collectionId: `model-${item.modelId}`,
      plan: [item],
      outDir: config.outDir,
      jobs: 1,
      deps,
      ...extra,
    },
    { log: () => {} }
  );
}

// ---------------------------------------------------------------------------
// Multi-version downloads
// 多版本下载
// ---------------------------------------------------------------------------

test('多版本：同一模型下载两个版本 → 共用一个布局目录，记录都保留', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('content-v1\n'.repeat(50));
  const v2 = Buffer.from('content-v2\n'.repeat(80));
  const deps = downloadDeps({ 'm-v1.safetensors': v1, 'm-v2.safetensors': v2 });

  const first = await runOne(
    config,
    deps,
    planItem({ modelId: 900, name: 'Multi', versionId: 1, versionName: 'v1', fileName: 'm-v1.safetensors', content: v1, fileId: 11 })
  );
  assert.equal(first.done, 1);

  const second = await runOne(
    config,
    deps,
    planItem({ modelId: 900, name: 'Multi', versionId: 2, versionName: 'v2', fileName: 'm-v2.safetensors', content: v2, fileId: 12 })
  );
  assert.equal(second.done, 1);

  const { entries } = readLibrary(config);
  assert.deepEqual(versionIds(entries['900']).sort(), ['1', '2']);
  const rec1 = getVersion(entries['900'], 1);
  const rec2 = getVersion(entries['900'], 2);
  assert.equal(rec1.dirName, 'Lora/Multi', '按布局落在类型目录下（相对路径用 / 分隔）');
  assert.equal(rec2.dirName, rec1.dirName, '所有版本共用一个目录');
  assert.equal(rec2.files[0].name, 'm-v2.safetensors', '文件名不冲突时保持原名');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Multi', 'm-v1.safetensors')));
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Multi', 'm-v2.safetensors')));
});

test('多版本：同名不同内容 → 双方整版加版本后缀，旧文件名被释放', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('same-name-v1\n'.repeat(50));
  const v2 = Buffer.from('same-name-v2\n'.repeat(60));
  const deps = downloadDeps({
    'model.safetensors': v1,
    'model-v2.safetensors': v2,
    'extra.safetensors': v1,
    'extra-v2.safetensors': v2,
  });

  const itemBase = (versionId, versionName) => ({
    modelId: 901,
    name: 'Clash',
    type: 'LORA',
    versionId,
    versionName,
    files: [
      {
        fileId: versionId * 10,
        name: 'model.safetensors',
        remoteName: 'model.safetensors',
        sha256: versionId === 1 ? sha(v1) : sha(v2),
        bytes: versionId === 1 ? v1.length : v2.length,
        downloadUrl: `https://example.invalid/${versionId}/model.safetensors`,
      },
      {
        fileId: versionId * 10 + 1,
        name: 'extra.safetensors',
        remoteName: 'extra.safetensors',
        sha256: versionId === 1 ? sha(v1) : sha(v2),
        bytes: versionId === 1 ? v1.length : v2.length,
        downloadUrl: `https://example.invalid/${versionId}/extra.safetensors`,
      },
    ],
    totalBytes: v1.length,
  });

  await runOne(config, deps, itemBase(1, 'v1'));
  const dir = path.join(config.outDir, 'Lora', 'Clash');
  assert.ok(fs.existsSync(path.join(dir, 'model.safetensors')), '首个版本先用原名');

  await runOne(config, deps, itemBase(2, 'v2'));

  const { entries } = readLibrary(config);
  const rec1 = getVersion(entries['901'], 1);
  const rec2 = getVersion(entries['901'], 2);
  const names1 = rec1.files.map((f) => f.name).sort();
  const names2 = rec2.files.map((f) => f.name).sort();
  assert.deepEqual(names1, ['extra-v1.safetensors', 'model-v1.safetensors'], '旧版本整版改名并同步记录');
  assert.deepEqual(names2, ['extra-v2.safetensors', 'model-v2.safetensors'], '本次版本整版加后缀');
  assert.equal(rec1.files.find((f) => f.name === 'model-v1.safetensors').remoteName, 'model.safetensors');

  for (const name of ['model-v1.safetensors', 'model-v2.safetensors', 'extra-v1.safetensors', 'extra-v2.safetensors']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} 应在磁盘上`);
  }
  assert.equal(fs.existsSync(path.join(dir, 'model.safetensors')), false, '旧文件名不再残留');
  assert.equal(fs.existsSync(path.join(dir, 'extra.safetensors')), false);
  assert.equal(
    fs.readFileSync(path.join(dir, 'model-v2.safetensors')).length,
    v2.length,
    '内容确实各自独立'
  );
});

test('多版本：同名同内容 → 不触发改名（复用已存在的文件）', async () => {
  const config = makeConfig();
  const shared = Buffer.from('identical-content\n'.repeat(40));
  const deps = downloadDeps({ 'model.safetensors': shared });

  const item = (versionId, versionName) => ({
    modelId: 902,
    name: 'Same',
    type: 'LORA',
    versionId,
    versionName,
    files: [
      {
        fileId: 1,
        name: 'model.safetensors',
        remoteName: 'model.safetensors',
        sha256: sha(shared),
        bytes: shared.length,
        downloadUrl: 'https://example.invalid/model.safetensors',
      },
    ],
    totalBytes: shared.length,
  });

  await runOne(config, deps, item(1, 'v1'));
  await runOne(config, deps, item(2, 'v2'));

  const { entries } = readLibrary(config);
  assert.equal(getVersion(entries['902'], 1).files[0].name, 'model.safetensors');
  assert.equal(getVersion(entries['902'], 2).files[0].name, 'model.safetensors', '内容相同则共用同一个文件');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Same', 'model.safetensors')));
  assert.equal(fs.existsSync(path.join(config.outDir, 'Lora', 'Same', 'model-v2.safetensors')), false);
});

test('多版本：已加过后缀再次下载不会重复追加（幂等）', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('idem-v1\n'.repeat(30));
  const v2 = Buffer.from('idem-v2\n'.repeat(40));
  const deps = downloadDeps({
    'model.safetensors': v1,
    'model-v2.safetensors': v2,
  });
  const item = (versionId, versionName, content) => ({
    modelId: 903,
    name: 'Idem',
    type: 'LORA',
    versionId,
    versionName,
    files: [
      {
        fileId: 1,
        name: 'model.safetensors',
        remoteName: 'model.safetensors',
        sha256: sha(content),
        bytes: content.length,
        downloadUrl: 'https://example.invalid/model.safetensors',
      },
    ],
    totalBytes: content.length,
  });

  await runOne(config, deps, item(1, 'v1', v1));
  await runOne(config, deps, item(2, 'v2', v2));
  await runOne(config, deps, item(2, 'v2', v2), { force: true });

  const { entries } = readLibrary(config);
  assert.equal(getVersion(entries['903'], 2).files[0].name, 'model-v2.safetensors', '不会变成 model-v2-v2');
  assert.equal(getVersion(entries['903'], 1).files[0].name, 'model-v1.safetensors');
});

test('多版本：版本名为空时使用 v<版本ID> 作为后缀', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('noname-v1\n'.repeat(20));
  const v2 = Buffer.from('noname-v2\n'.repeat(30));
  const deps = downloadDeps({ 'model.safetensors': v1, 'model-77.safetensors': v2 });
  const item = (versionId, content) => ({
    modelId: 904,
    name: 'NoName',
    type: 'LORA',
    versionId,
    versionName: null,
    files: [
      {
        fileId: 1,
        name: 'model.safetensors',
        remoteName: 'model.safetensors',
        sha256: sha(content),
        bytes: content.length,
        downloadUrl: 'https://example.invalid/model.safetensors',
      },
    ],
    totalBytes: content.length,
  });

  await runOne(config, deps, item(1, v1));
  await runOne(config, deps, item(77, v2));
  const { entries } = readLibrary(config);
  assert.equal(getVersion(entries['904'], 1).files[0].name, 'model-v1.safetensors');
  assert.equal(getVersion(entries['904'], 77).files[0].name, 'model-v77.safetensors');
});

test('多版本：切回已下载的旧版本不会重复下载', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('content-v1\n'.repeat(50));
  const v2 = Buffer.from('content-v2\n'.repeat(80));
  const deps = downloadDeps({ 'm-v1.safetensors': v1, 'm-v2.safetensors': v2 });
  const mk = (versionId, versionName, fileName, content, fileId) =>
    planItem({ modelId: 900, name: 'Multi', versionId, versionName, fileName, content, fileId });

  await runOne(config, deps, mk(1, 'v1', 'm-v1.safetensors', v1, 11));
  await runOne(config, deps, mk(2, 'v2', 'm-v2.safetensors', v2, 12));

  const back = await runOne(config, deps, mk(1, 'v1', 'm-v1.safetensors', v1, 11));
  assert.equal(back.skipped, 1, '切回旧版本应直接跳过');
  assert.equal(back.done, 0);
});

test('多版本：--force 重新下载某版本时不影响其它版本记录', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('content-v1\n'.repeat(50));
  const v2 = Buffer.from('content-v2\n'.repeat(80));
  const deps = downloadDeps({ 'm-v1.safetensors': v1, 'm-v2.safetensors': v2 });
  const item = (versionId, versionName, fileName, content, fileId) =>
    planItem({ modelId: 900, name: 'Multi', versionId, versionName, fileName, content, fileId });

  await runOne(config, deps, item(1, 'v1', 'm-v1.safetensors', v1, 11));
  await runOne(config, deps, item(2, 'v2', 'm-v2.safetensors', v2, 12));
  const forced = await runOne(config, deps, item(2, 'v2', 'm-v2.safetensors', v2, 12), { force: true });
  assert.equal(forced.done, 1);

  const { entries } = readLibrary(config);
  assert.deepEqual(versionIds(entries['900']).sort(), ['1', '2']);
});

// ---------------------------------------------------------------------------
// checkModelUpdates
// checkModelUpdates（检查更新）
// ---------------------------------------------------------------------------

/**
 * Seed a library record for one version (the files really exist).
 * 在模型库里摆好某个版本的记录（文件真实存在）
 */
function seedVersion(config, modelId, { versionId, versionName, fileName, content, dirName, verify = true }) {
  const dir = path.join(config.outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
  const { entries } = readLibrary(config);
  upsertVersion(entries, modelId, {
    name: 'Single Model',
    type: 'LORA',
    versionId,
    versionName,
    dirName,
    outDir: config.outDir,
    files: [
      {
        fileId: 1,
        name: fileName,
        remoteName: fileName,
        sha256: sha(content),
        bytes: content.length,
        downloadUrl: `https://civitai.com/api/download/models/${versionId}?fileId=1`,
      },
    ],
  });
  writeLibrary(config, entries);
  return dir;
}

function modelDeps(detail) {
  return { fetchModelDetail: async () => detail };
}

test('checkModelUpdates: 本地就是最新版本且文件完好 → 全部正常', async () => {
  const config = makeConfig();
  const content = Buffer.from('latest\n'.repeat(20));
  seedVersion(config, 900, { versionId: 5, versionName: 'v5', fileName: 'm.safetensors', content, dirName: 'Lora/Single Model' });

  const { report } = await checkModelUpdates(
    config,
    900,
    { deps: modelDeps(modelDetail(900, 'Single Model', [versionObj(5, 'v5', 'm.safetensors', content, 1)])) },
    { log: () => {} }
  );
  report.stats = summarize(report);
  assert.equal(report.kind, 'model');
  assert.equal(report.upToDate.length, 1);
  assert.equal(report.updated.length, 0);
  assert.equal(report.stats.problems, 0);
  assert.match(reportLines(report).join('\n'), /检查完成/);
});

test('checkModelUpdates: 线上有更新版本 → 报告有更新且能生成下载计划', async () => {
  const config = makeConfig();
  const oldContent = Buffer.from('old\n'.repeat(20));
  const newContent = Buffer.from('newer\n'.repeat(30));
  seedVersion(config, 900, { versionId: 5, versionName: 'v5', fileName: 'm-v5.safetensors', content: oldContent, dirName: 'Lora/Single Model' });

  const detail = modelDetail(900, 'Single Model', [
    versionObj(6, 'v6', 'm-v6.safetensors', newContent, 2),
    versionObj(5, 'v5', 'm-v5.safetensors', oldContent, 1),
  ]);
  const { report } = await checkModelUpdates(config, 900, { deps: modelDeps(detail), verifyFiles: false }, { log: () => {} });

  assert.equal(report.updated.length, 1);
  assert.equal(report.updated[0].item.versionId, 6);
  assert.equal(report.history.length, 1, '本地保留的 v5 应作为历史版本列出');
  const items = changedItems(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].versionId, 6);
  assert.ok(items[0].files[0].downloadUrl.includes('models/6'));
});

test('checkModelUpdates: 已固定旧版本 → 报「已固定」而不是「有更新」', async () => {
  const config = makeConfig();
  const content = Buffer.from('pinned\n'.repeat(20));
  seedVersion(config, 900, { versionId: 5, versionName: 'v5', fileName: 'm-v5.safetensors', content, dirName: 'Lora/Single Model' });

  const { entries } = readLibrary(config);
  entries['900'].pinnedVersionId = '5';
  writeLibrary(config, entries);

  const detail = modelDetail(900, 'Single Model', [
    versionObj(6, 'v6', 'm-v6.safetensors', Buffer.from('x'), 2),
    versionObj(5, 'v5', 'm-v5.safetensors', content, 1),
  ]);
  const { report } = await checkModelUpdates(config, 900, { deps: modelDeps(detail) }, { log: () => {} });
  assert.equal(report.pinned.length, 1);
  assert.equal(report.updated.length, 0);
  assert.equal(changedItems(report).length, 0);
});

test('checkModelUpdates: 深度模式发现同版本重传（文件变化）', async () => {
  const config = makeConfig();
  const localContent = Buffer.from('local\n'.repeat(20));
  const onlineContent = Buffer.from('changed-online\n'.repeat(20));
  seedVersion(config, 900, { versionId: 5, versionName: 'v5', fileName: 'm.safetensors', content: localContent, dirName: 'Lora/Single Model' });

  const detail = modelDetail(900, 'Single Model', [versionObj(5, 'v5', 'm.safetensors', onlineContent, 1)]);
  const quick = await checkModelUpdates(config, 900, { deps: modelDeps(detail) }, { log: () => {} });
  assert.equal(quick.report.fileChanged.length, 0, '快速模式不比对哈希');

  const deep = await checkModelUpdates(config, 900, { deps: modelDeps(detail), verifyFiles: true }, { log: () => {} });
  assert.equal(deep.report.fileChanged.length, 1);
  assert.equal(deep.report.upToDate.length, 0);
});

test('checkModelUpdates: 本地文件被删 → 报缺失', async () => {
  const config = makeConfig();
  const content = Buffer.from('gone\n'.repeat(20));
  const dir = seedVersion(config, 900, {
    versionId: 5,
    versionName: 'v5',
    fileName: 'm.safetensors',
    content,
    dirName: 'Lora/Single Model',
  });
  fs.rmSync(path.join(dir, 'm.safetensors'));

  const detail = modelDetail(900, 'Single Model', [versionObj(5, 'v5', 'm.safetensors', content, 1)]);
  const { report } = await checkModelUpdates(config, 900, { deps: modelDeps(detail) }, { log: () => {} });
  assert.equal(report.missing.length, 1);
  assert.match(report.missing[0].reasons.join('；'), /缺失/);
});

test('checkModelUpdates: 没有本地记录 → 未下载；线上已无该版本 → 已移除', async () => {
  const config = makeConfig();
  const content = Buffer.from('x\n'.repeat(20));
  const detail = modelDetail(900, 'Single Model', [versionObj(5, 'v5', 'm.safetensors', content, 1)]);

  const empty = await checkModelUpdates(config, 900, { deps: modelDeps(detail) }, { log: () => {} });
  assert.equal(empty.report.notDownloaded.length, 1);
  assert.equal(empty.report.hasState, false);

  seedVersion(config, 900, { versionId: 77, versionName: 'v77', fileName: 'old.safetensors', content, dirName: 'Lora/Single Model' });
  const removed = await checkModelUpdates(config, 900, { deps: modelDeps(detail) }, { log: () => {} });
  assert.equal(removed.report.removed.length, 1);
  assert.equal(removed.report.removed[0].versionId, '77');
});

test('checkModelUpdates: 404 等接口错误会向上抛出（由命令层展示）', async () => {
  const config = makeConfig();
  const deps = {
    fetchModelDetail: async () => {
      const { NotFoundError } = require('../src/errors');
      throw new NotFoundError('HTTP 404');
    },
  };
  await assert.rejects(() => checkModelUpdates(config, 900, { deps }, { log: () => {} }), /404/);
});

// ---------------------------------------------------------------------------
// Reset records (used by check --download)
// 重置记录（check --download 用）
// ---------------------------------------------------------------------------

test('markForRedownload: 只重置指定版本，同模型其它版本记录保留', () => {
  const config = makeConfig();
  const entries = {};
  upsertVersion(entries, 900, { name: 'M', versionId: 1, outDir: config.outDir, dirName: 'Lora/M', files: [] });
  upsertVersion(entries, 900, { name: 'M', versionId: 2, outDir: config.outDir, dirName: 'Lora/M', files: [] });
  writeLibrary(config, entries);

  const n = markForRedownload(config, [{ modelId: '900', versionId: 2 }]);
  assert.equal(n, 1);
  const { entries: after } = readLibrary(config);
  assert.deepEqual(versionIds(after['900']), ['1'], '只删版本 2');

  const n2 = markForRedownload(config, [{ modelId: '900', versionId: 1 }]);
  assert.equal(n2, 1);
  const after2 = readLibrary(config).entries;
  assert.equal(after2['900'], undefined, '最后一个版本删掉后整条记录移除');
});

test('markForRedownload: 传字符串表示删除整个模型', () => {
  const config = makeConfig();
  const entries = {};
  upsertVersion(entries, 901, { name: 'M', versionId: 1, outDir: config.outDir, dirName: 'Lora/M', files: [] });
  upsertVersion(entries, 901, { name: 'M', versionId: 2, outDir: config.outDir, dirName: 'Lora/M', files: [] });
  writeLibrary(config, entries);

  assert.equal(markForRedownload(config, ['901']), 1);
  const after = readLibrary(config).entries;
  assert.equal(after['901'], undefined);
});

// ---------------------------------------------------------------------------
// Records without version information
// 没有版本信息的记录
// ---------------------------------------------------------------------------

test('checkUpdates: 记录里没有版本信息时按「旧记录」报告，不尝试升级', async () => {
  const config = makeConfig();
  const collectionId = '999';
  const dirName = 'Legacy Model';

  // A hand-edited library entry without versions (the new format never writes one)
  // 手工改出来的、没有版本的库记录（新格式不会写出这种条目）
  const entries = {};
  upsertVersion(entries, 900, {
    name: dirName,
    versionId: 1,
    dirName,
    outDir: config.outDir,
    files: [{ name: 'legacy.safetensors', sha256: 'AA', bytes: 1 }],
  });
  delete entries['900'].versions['1'];
  writeLibrary(config, entries);
  const { writeCollection } = require('../src/storage');
  writeCollection(config, collectionId, { items: [{ modelId: 900, name: dirName, versionId: 5 }] });

  const { report } = await checkUpdates(config, collectionId, {}, { log: () => {} });
  assert.equal(report.legacy.length, 1, '没有版本信息的记录归入 legacy');
  assert.equal(report.updated.length, 0);
  assert.ok(Array.isArray(report.upgraded) && report.upgraded.length === 0, '不再做旧记录升级');
});
