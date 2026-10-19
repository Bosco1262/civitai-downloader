'use strict';

/**
 * Regression tests for the model-library "command layer" (the data layer lives in tests/models.test.js):
 *  - models: list / JSON / search / sort / export (json and csv) / forget (including --version and --delete-files)
 *  - models: --pin / --unpin / --relayout
 *  - check: positional argument parsing (collection vs model) and the model report (offline deps)
 *  - download: reference parsing for --models / --from-file (a version reference needs an online lookup, so only parsing is tested here)
 *  - pin: pinning / unpinning / listing the library
 *  - TUI: parsing pasted input (multiple lines + commas + comments)
 *
 * 模型库命令层回归测试（数据层见模型库数据层测试文件）：
 *  - 列表 / 数据导出 / 搜索 / 排序 / 文件导出 / 删除记录（含指定版本与同时删文件）
 *  - 固定 / 取消固定 / 重排目录
 *  - 位置参数解析（收藏集与模型）与模型报告（离线依赖）
 *  - 批量引用的解析（版本号引用需要联网反查，这里只测纯解析）
 *  - 模型库的固定 / 取消固定 / 列表
 *  - 粘贴输入的解析（多行 + 逗号 + 注释）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateConfig, DEFAULTS } = require('../src/config');
const { writeLibrary, readLibrary, upsertVersion, getVersion, versionIds } = require('../src/storage');
const { setLogSink } = require('../src/util');
const models = require('../src/commands/models');
const check = require('../src/commands/check');
const pin = require('../src/commands/pin');
const download = require('../src/commands/download');

// ---------------------------------------------------------------------------
// TUI: replace prompts with scripted answers and inject offline deps into the single-model check
//
// The stub must be installed before `../src/tui/models` is required: the TUI resolves `prompts` on
// first use (not at load time), so replacing the module afterwards would leave the already-loaded
// real module in place and the flows would wait for keyboard input.
//
//
// 提示改为脚本化答案，并给单模型检查注入离线依赖
//
// 替身必须在 require('../src/tui/models') 之前装好：TUI 是「首次使用时」才解析 prompts
// （而不是加载时），装晚了真实模块已经被加载，流程会停下来等键盘输入。
// ---------------------------------------------------------------------------

const promptsPath = require.resolve('prompts');
const answers = [];
require.cache[promptsPath] = {
  id: promptsPath,
  filename: promptsPath,
  loaded: true,
  exports: () => Promise.resolve(answers.shift()),
};

const updater = require('../src/updater');
const realCheckModelUpdates = updater.checkModelUpdates;
/**
 * modelId → online model detail (set one by one in the tests)
 * modelId → 线上模型详情（测试里逐个设置）
 */
const onlineDetails = new Map();
updater.checkModelUpdates = (config, modelId, opts = {}, hooks = {}) => {
  if (opts.deps) return realCheckModelUpdates(config, modelId, opts, hooks);
  return realCheckModelUpdates(
    config,
    modelId,
    { ...opts, deps: { fetchModelDetail: async () => onlineDetails.get(String(modelId)) } },
    hooks
  );
};

// Every TUI module must be loaded after the stub above, so the flow modules (and the shared
// `pages` helpers they use) resolve the scripted answers.
//
// 所有 TUI 模块都必须在替身之后加载，这样各流程模块（以及它们用的 `pages` 助手）
// 才会走脚本化答案。
const tuiModels = require('../src/tui/models');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-modelscli-${tag}-`));
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
  return config;
}

/**
 * Create a downloaded version on disk and in the library.
 * 在磁盘与模型库里造一个已下载版本
 */
function seed(
  config,
  modelId,
  { versionId, versionName, fileName, content = 'data', dirName, outDir, name }
) {
  const dir = path.join(outDir || config.outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
  const { entries } = readLibrary(config);
  upsertVersion(entries, modelId, {
    name: name || `Model ${modelId}`,
    type: 'LORA',
    versionId,
    versionName,
    dirName,
    outDir: outDir || config.outDir,
    files: [
      {
        fileId: 1,
        name: fileName,
        remoteName: fileName,
        sha256: 'A'.repeat(64),
        bytes: Buffer.byteLength(content),
        downloadUrl: `https://example.invalid/${versionId}/${fileName}`,
      },
    ],
  });
  writeLibrary(config, entries);
  return dir;
}

/**
 * Freeze each version's completion time afterwards, so that "newest version" is not ambiguous within the same millisecond.
 * 造完后把各版本的完成时间写死，避免同毫秒导致「最新版本」不确定
 */
function setVerifiedAt(config, modelId, times) {
  const { entries } = readLibrary(config);
  for (const [versionId, at] of Object.entries(times)) {
    if (entries[modelId] && entries[modelId].versions[versionId]) {
      entries[modelId].versions[versionId].verifiedAt = at;
    }
  }
  writeLibrary(config, entries);
}

/**
 * Capture console output (models/pin listings go through console.log, actions through util.log).
 * 捕获 console 输出（models/pin 的列表走 console.log，动作走 util.log）
 */
async function capture(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  const prevCode = process.exitCode;
  // usage() and friends set exitCode to 1: isolate that here so the whole test process exit code stays clean
  // usage() 之类会把 exitCode 设成 1：这里隔离掉，避免污染整个测试进程的退出码
  process.exitCode = 0;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exitCode = prevCode;
  }
  return lines.join('\n');
}

test.before(() => setLogSink(null));
test.after(() => {
  setLogSink(null);
  updater.checkModelUpdates = realCheckModelUpdates;
  delete require.cache[promptsPath];
});

// ---------------------------------------------------------------------------
// models: reading and organizing
// models：读取与整理
// ---------------------------------------------------------------------------

test('models: collectModels 汇总版本数、总大小、固定与目录', () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.safetensors', content: 'aaaa', dirName: 'M900' });
  seed(config, 900, { versionId: 6, versionName: 'v6', fileName: 'b.safetensors', content: 'bb', dirName: 'M900/v6' });
  seed(config, 901, { versionId: 7, versionName: 'v7', fileName: 'c.safetensors', content: 'ccc', dirName: 'M901' });
  setVerifiedAt(config, 900, { 5: '2024-01-01T00:00:00.000Z', 6: '2024-02-01T00:00:00.000Z' });

  const all = models.collectModels(config);
  assert.equal(all.length, 2);
  const m900 = all.find((m) => m.modelId === '900');
  assert.equal(m900.name, 'Model 900');
  assert.equal(m900.type, 'LORA');
  assert.equal(m900.versions.length, 2);
  assert.equal(m900.totalBytes, 6);
  assert.equal(m900.dir, path.join(config.outDir, 'M900/v6'), '目录取最近完成的版本');
  assert.equal(m900.pinnedVersionId, null);
});

test('models: filterModels 按名称与模型 ID 过滤，sortModels 支持 name/size/recent', () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'a', dirName: 'A' });
  seed(config, 901, { versionId: 7, versionName: 'v7', fileName: 'b.bin', content: 'bbbbb', dirName: 'B' });
  const all = models.collectModels(config);

  assert.equal(models.filterModels(all, '901').length, 1);
  assert.equal(models.filterModels(all, 'model 900').length, 1);
  assert.equal(models.filterModels(all, 'nope').length, 0);
  assert.equal(models.filterModels(all, '').length, 2);

  assert.deepEqual(
    models.sortModels(all, 'name').map((m) => m.modelId),
    ['900', '901']
  );
  assert.deepEqual(
    models.sortModels(all, 'size').map((m) => m.modelId),
    ['901', '900']
  );
  assert.equal(models.sortModels(all, 'recent').length, 2);
});

// ---------------------------------------------------------------------------
// models: output and export
// models：输出与导出
// ---------------------------------------------------------------------------

test('models: --json 输出 {exportedAt,count,models[]} 结构', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'A' });

  const out = await capture(() => models.main(config, { positionals: [], flags: { json: true } }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.models[0].modelId, '900');
  assert.equal(parsed.models[0].versions[0].versionId, '5');
  assert.equal(parsed.models[0].versions[0].files[0].name, 'a.bin');
  assert.equal(parsed.models[0].totalBytes, 4);
  assert.ok(parsed.exportedAt);
});

test('models: 列表输出包含名称/模型ID/版本/大小/固定/目录，空记录不报错', async () => {
  const config = makeConfig();
  const empty = await capture(() => models.main(config, { positionals: [], flags: {} }));
  assert.match(empty, /模型库暂无下载记录/);

  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'A' });
  const out = await capture(() => models.main(config, { positionals: [], flags: {} }));
  assert.match(out, /模型库 1 项/);
  assert.match(out, /Model 900/);
  assert.match(out, /modelId=900/);
  assert.match(out, /未固定/);
  assert.match(out, /v5（5，4 B）/);
  assert.match(out, /目录: /);
});

test('models: --export 写 .json 与 .csv（含表头与 pinned 列）', async () => {
  const config = makeConfig();
  seed(config, 900, {
    versionId: 5,
    versionName: 'v=5',
    fileName: 'a,b.bin',
    content: 'aaaa',
    dirName: 'A',
    name: 'Model, with comma',
  });
  await capture(() => models.main(config, { positionals: [], flags: { pin: '900=5' } }));

  const jsonFile = path.join(config.root, 'out.json');
  await capture(() => models.main(config, { positionals: [], flags: { export: jsonFile } }));
  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.equal(data.count, 1);
  assert.equal(data.models[0].pinnedVersionId, '5');
  assert.equal(data.models[0].versions[0].files[0].name, 'a,b.bin');

  const csvFile = path.join(config.root, 'out.csv');
  await capture(() => models.main(config, { positionals: [], flags: { export: csvFile } }));
  const csv = fs.readFileSync(csvFile, 'utf8').trim().split('\n');
  assert.equal(csv[0], models.CSV_COLUMNS.join(','));
  assert.equal(csv.length, 2);
  assert.ok(csv[1].startsWith('900,"Model, with comma",LORA,5,'), '含逗号的字段要加引号');
  assert.ok(csv[1].includes(',1,4,'), 'files / bytes 列');
  assert.ok(csv[1].includes(',yes,'), 'pinned 列标出固定版本');
});

test('models: --export 不支持的扩展名报错并返回用法', async () => {
  const config = makeConfig();
  const out = await capture(() =>
    models.main(config, { positionals: [], flags: { export: path.join(config.root, 'x.txt') } })
  );
  assert.match(out, /不支持的导出格式/);
  assert.match(out, /node cli\.js models/);
});

test('models: --sort 非法值报错', async () => {
  const config = makeConfig();
  const out = await capture(() => models.main(config, { positionals: [], flags: { sort: 'wat' } }));
  assert.match(out, /未知的排序方式/);
});

// ---------------------------------------------------------------------------
// models: --forget
// models：--forget（删除记录）
// ---------------------------------------------------------------------------

test('models: --forget 删除整个记录，--version 只删指定版本', () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', dirName: 'A' });
  seed(config, 900, { versionId: 6, versionName: 'v6', fileName: 'b.bin', dirName: 'A/v6' });
  seed(config, 901, { versionId: 7, versionName: 'v7', fileName: 'c.bin', dirName: 'B' });

  const removed = models.forgetModels(config, '900', { version: '5', deleteFiles: false });
  assert.equal(removed, true);
  let entries = readLibrary(config).entries;
  assert.deepEqual(versionIds(entries['900']), ['6'], '只删 v5');

  models.forgetModels(config, '901', {});
  entries = readLibrary(config).entries;
  assert.deepEqual(Object.keys(entries), ['900'], '只删掉了 901');
  assert.deepEqual(versionIds(entries['900']), ['6'], '900 的 v6 不受影响');
});

test('models: --forget --delete-files 删除记录中的文件并清理空目录', () => {
  const config = makeConfig();
  const dir = seed(config, 900, {
    versionId: 5,
    versionName: 'v5',
    fileName: 'a.bin',
    dirName: 'M900/v5',
  });
  assert.ok(fs.existsSync(path.join(dir, 'a.bin')));

  models.forgetModels(config, 'model:900', { deleteFiles: true });
  assert.equal(fs.existsSync(path.join(dir, 'a.bin')), false, '文件应被删除');
  assert.equal(fs.existsSync(dir), false, '空目录应被清理');
  assert.equal(fs.existsSync(path.join(config.outDir, 'M900')), false, '父目录也清空时一并清理');
  assert.ok(fs.existsSync(config.outDir), '下载根目录不动');
  assert.deepEqual(Object.keys(readLibrary(config).entries), []);
});

test('models: 记录不存在时 --forget 只提示、不抛错', async () => {
  const config = makeConfig();
  const out = await capture(() => models.forgetModels(config, '123456', {}));
  assert.match(out, /没有找到模型记录/);
});

// ---------------------------------------------------------------------------
// models: --pin / --unpin
// models：--pin / --unpin（固定与取消固定）
// ---------------------------------------------------------------------------

test('models: --pin 省略版本时固定最新记录的版本，--unpin 取消', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', dirName: 'A' });
  seed(config, 900, { versionId: 6, versionName: 'v6', fileName: 'b.bin', dirName: 'A' });
  setVerifiedAt(config, 900, { 5: '2024-01-01T00:00:00.000Z', 6: '2024-02-01T00:00:00.000Z' });

  const out = await capture(() => models.main(config, { positionals: [], flags: { pin: '900' } }));
  assert.match(out, /已固定: Model 900 → v6/);
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, '6');

  await capture(() => models.main(config, { positionals: [], flags: { pin: '900=5' } }));
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, '5');

  const unpinOut = await capture(() => models.main(config, { positionals: [], flags: { unpin: '900' } }));
  assert.match(unpinOut, /已取消固定/);
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, null);
});

test('models: --pin 指定未记录的版本会报错', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', dirName: 'A' });
  const out = await capture(() => models.main(config, { positionals: [], flags: { pin: '900=99' } }));
  assert.match(out, /中没有版本 99 的记录/);
});

// ---------------------------------------------------------------------------
// models: --relayout
// models：--relayout（重排目录布局）
// ---------------------------------------------------------------------------

/**
 * Seed one version with a custom hash so two versions can hold different content.
 * 造一个带自定义哈希的版本，便于让两个版本内容不同
 */
function seedWithHash(config, modelId, { versionId, versionName, fileName, sha, bytes, dirName, name }) {
  const dir = path.join(config.outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), 'x'.repeat(bytes));
  const { entries } = readLibrary(config);
  upsertVersion(entries, modelId, {
    name: name || `Model ${modelId}`,
    type: 'LORA',
    baseModel: 'SDXL',
    versionId,
    versionName,
    dirName,
    outDir: config.outDir,
    files: [
      {
        fileId: versionId,
        name: fileName,
        remoteName: fileName,
        sha256: sha,
        bytes,
        downloadUrl: `https://example.invalid/${versionId}/${fileName}`,
      },
    ],
  });
  writeLibrary(config, entries);
  return dir;
}

test('models: --relayout --dry-run 只报告、不改动磁盘与记录', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'OldDir' });

  const out = await capture(() => models.relayoutModels(config, { dryRun: true }));
  assert.equal(out, '');
  const summary = models.relayoutModels(config, { dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.models, 1);
  assert.equal(summary.files, 1);
  assert.equal(summary.moved, 0);
  assert.ok(fs.existsSync(path.join(config.outDir, 'OldDir', 'a.bin')), 'dry-run 不移动文件');
  assert.equal(readLibrary(config).entries['900'].versions['5'].dirName, 'OldDir', 'dry-run 不改记录');
});

test('models: --relayout 按当前布局移动文件并更新记录', () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'OldDir' });

  const summary = models.relayoutModels(config, {});
  assert.equal(summary.models, 1);
  assert.equal(summary.moved, 1);
  assert.equal(summary.copied, 0);
  assert.equal(summary.renamed, 0);

  const { entries } = readLibrary(config);
  const rec = getVersion(entries['900'], 5);
  assert.equal(rec.dirName, 'Lora/Model 900', '按布局 a1111 重排');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Model 900', 'a.bin')));
  assert.equal(fs.existsSync(path.join(config.outDir, 'OldDir')), false, '空目录被清理');
});

test('models: --relayout 同一目录内同名冲突时双方整版加后缀', () => {
  const config = makeConfig();
  seedWithHash(config, 901, {
    versionId: 1,
    versionName: 'v1',
    fileName: 'model.safetensors',
    sha: 'A'.repeat(64),
    bytes: 10,
    dirName: 'Flat1',
  });
  seedWithHash(config, 901, {
    versionId: 2,
    versionName: 'v2',
    fileName: 'model.safetensors',
    sha: 'B'.repeat(64),
    bytes: 20,
    dirName: 'Flat2',
  });

  const summary = models.relayoutModels(config, {});
  assert.equal(summary.renamed, 2, '两个版本各有一个文件需要改名');

  const { entries } = readLibrary(config);
  assert.equal(getVersion(entries['901'], 1).files[0].name, 'model-v1.safetensors');
  assert.equal(getVersion(entries['901'], 2).files[0].name, 'model-v2.safetensors');
  const target = path.join(config.outDir, 'Lora', 'Model 901');
  assert.deepEqual(fs.readdirSync(target).sort(), ['model-v1.safetensors', 'model-v2.safetensors']);
  assert.equal(fs.readFileSync(path.join(target, 'model-v2.safetensors'), 'utf8').length, 20, '内容随文件一起搬过去');
});

test('models: --relayout 对已是目标布局的记录是幂等的', () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'Lora/Model 900' });
  const summary = models.relayoutModels(config, {});
  assert.equal(summary.moved, 0, '已在目标目录，无需移动');
  assert.equal(readLibrary(config).entries['900'].versions['5'].dirName, 'Lora/Model 900');
});

test('check: parseTargets 区分收藏集与单模型，version:<id> 给出提示', () => {
  const parsed = check.parseTargets(['161131', 'model:900', 'https://civitai.red/models/901?modelVersionId=5']);
  assert.deepEqual(parsed.targets, [
    { kind: 'collection', id: '161131' },
    { kind: 'model', id: '900' },
    { kind: 'model', id: '901' },
  ]);
  const bad = check.parseTargets(['nope']);
  assert.equal(bad.error, 'nope');
  assert.equal(bad.versionOnly, false);
  const versionOnly = check.parseTargets(['version:5']);
  assert.equal(versionOnly.versionOnly, true);
});

test('check: checkOne 走单模型路径（不枚举收藏集）并统计问题数', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'M900' });

  const detail = {
    id: 900,
    name: 'Model 900',
    type: 'LORA',
    modelVersions: [
      {
        id: 6,
        name: 'v6',
        baseModel: 'SDXL',
        files: [
          {
            id: 2,
            name: 'b.bin',
            type: 'Model',
            primary: true,
            sizeKB: 1,
            hashes: { SHA256: 'B'.repeat(64) },
            downloadUrl: 'https://example.invalid/6/b.bin',
          },
        ],
      },
      {
        id: 5,
        name: 'v5',
        baseModel: 'SDXL',
        files: [
          {
            id: 1,
            name: 'a.bin',
            type: 'Model',
            primary: true,
            sizeKB: 1,
            hashes: { SHA256: 'A'.repeat(64) },
            downloadUrl: 'https://example.invalid/5/a.bin',
          },
        ],
      },
    ],
  };

  const report = await check.checkOne(
    config,
    { kind: 'model', id: '900' },
    { verifyFiles: false, download: false, deps: { fetchModelDetail: async () => detail } }
  );
  assert.equal(report.kind, 'model');
  assert.equal(report.modelId, '900');
  assert.equal(report.updated.length, 1, '线上有 v6 → 有更新');
  assert.equal(report.history.length, 1, '本地保留的 v5 是历史版本');
  assert.equal(report.stats.problems, 1);
  assert.ok(fs.existsSync(path.join(config.dataDir, 'report-model-900.json')), '报告缓存按 model-<id> 落盘');
});

// ---------------------------------------------------------------------------
// download: batch reference parsing
// download：批量引用解析
// ---------------------------------------------------------------------------

test('download: --models / --from-file 解析出目标，忽略注释与空行', async () => {
  const config = makeConfig();
  const file = path.join(config.root, 'refs.txt');
  fs.writeFileSync(
    file,
    ['# 注释行', '', 'model:901', 'https://civitai.red/models/902  # 行尾注释', '  model:901  '].join('\r\n'),
    'utf8'
  );

  const refs = download.readRefsFromFile(config, file);
  assert.deepEqual(refs, ['model:901', 'https://civitai.red/models/902', 'model:901'], '文件本身不做去重');

  const targets = await download.collectTargets(config, {
    positionals: [],
    flags: { models: 'model:900,https://civitai.red/models/902', 'from-file': file },
  });
  assert.deepEqual(
    targets.map((x) => (x.kind === 'collection' ? `c:${x.id}` : `m:${x.ref.modelId}:${x.ref.versionId || ''}`)),
    ['m:900:', 'm:902:', 'm:901:'],
    '重复的引用只保留一次'
  );
});

test('download: --models 里的非法项报错并返回 null（不发起下载）', async () => {
  const config = makeConfig();
  let targets = 'unset';
  const out = await capture(async () => {
    targets = await download.collectTargets(config, {
      positionals: [],
      flags: { models: 'model:900,nope' },
    });
  });
  assert.equal(targets, null);
  assert.match(out, /--models 中的项无法识别: nope/);
});

test('download: --from-file 文件不存在时抛 ConfigError', () => {
  const config = makeConfig();
  assert.throws(
    () => download.readRefsFromFile(config, path.join(config.root, 'missing.txt')),
    /无法读取 --from-file 文件/
  );
});

// ---------------------------------------------------------------------------
// pin: the model library
// pin：模型库
// ---------------------------------------------------------------------------

test('pin: model:<id> 固定/取消固定/列表', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', dirName: 'A' });
  seed(config, 900, { versionId: 6, versionName: 'v6', fileName: 'b.bin', dirName: 'A' });
  setVerifiedAt(config, 900, { 5: '2024-01-01T00:00:00.000Z', 6: '2024-02-01T00:00:00.000Z' });

  await capture(() => pin.main(config, { positionals: ['model:900'], flags: {} }));
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, '6', '省略版本 = 最新记录');

  await capture(() => pin.main(config, { positionals: ['model:900', '5'], flags: {} }));
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, '5');

  const listOut = await capture(() => pin.main(config, { positionals: ['model:900'], flags: { list: true } }));
  assert.match(listOut, /模型 900：2 个版本，其中 1 项已固定版本/);
  assert.match(listOut, /固定 v5/);

  await capture(() => pin.main(config, { positionals: ['model:900'], flags: { unpin: true } }));
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, null);
});

test('pin: 纯数字即模型 ID；无参数时列出模型库的固定情况', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', dirName: 'A' });

  assert.deepEqual(pin.resolveTarget('161131'), { modelId: '161131' });
  assert.deepEqual(pin.resolveTarget('model:900'), { modelId: '900' });
  assert.equal(pin.resolveTarget('nope'), null);

  const out = await capture(() => pin.main(config, { positionals: [], flags: { list: true } }));
  assert.match(out, /模型库：共 1 个模型，其中 0 个已固定版本/);
  assert.match(out, /node cli\.js pin/);
});

test('pin: 模型没有记录时报错退出码为 1', async () => {
  const config = makeConfig();
  const orig = { log: console.log, error: console.error };
  const prev = process.exitCode;
  console.log = () => {};
  console.error = () => {};
  process.exitCode = 0;
  try {
    await pin.main(config, { positionals: ['model:123456'], flags: {} });
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exitCode = prev;
  }
});

// ---------------------------------------------------------------------------
// TUI: parsing pasted input
// TUI：粘贴输入解析
// ---------------------------------------------------------------------------

test('tui/models: parseRefs 支持多行、逗号与注释', () => {
  assert.deepEqual(tuiModels.parseRefs('model:1\nversion:2, https://x/models/3 # 注释'), [
    'model:1',
    'version:2',
    'https://x/models/3',
  ]);
  assert.deepEqual(tuiModels.parseRefs('  \n\n '), []);
});

test('tui/models: resolveRefs 过滤非法项并去重（不联网的 model:<id> 输入）', async () => {
  const config = makeConfig();
  let printed = '';
  const orig = console.log;
  console.log = (...args) => {
    printed += args.map(String).join(' ') + '\n';
  };
  try {
    const picks = await tuiModels.resolveRefs(config, ['model:900', 'model:900', 'nope']);
    assert.deepEqual(picks, [{ modelId: '900', versionId: null }]);
    assert.match(printed, /无法识别的目标: nope/);
  } finally {
    console.log = orig;
  }
});

test('tui/models: pickModel 在没有记录时返回 null', async () => {
  const config = makeConfig();
  const orig = console.log;
  console.log = () => {};
  try {
    assert.equal(await tuiModels.pickModel(config, 'pick'), null);
  } finally {
    console.log = orig;
  }
});

// ---------------------------------------------------------------------------
// TUI: run the menu and sub-flows with a scripted answer sequence
// TUI：脚本化跑一遍菜单与子流程
// ---------------------------------------------------------------------------

/**
 * Run one flow with the given answer sequence and return the printed text.
 * The timeout guard turns "the flow asked one more question than the script provides" into a clear
 * failure instead of a test run that never finishes.
 *
 * 用给定的答案序列跑一次流程，返回打印出来的文本。
 * 超时保护把「流程多问了一个问题」变成明确的失败，而不是让整轮测试卡住。
 */
async function runFlow(fn, ...scripted) {
  answers.length = 0;
  answers.push(...scripted);
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`流程在 ${scripted.length} 个答案后仍未返回（缺少脚本化答案）`)), 5000);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([capture(fn), guard]);
  } finally {
    clearTimeout(timer);
  }
}

test('tui/models: 菜单取消不抛错；模型列表与单个模型的页面', async () => {
  const config = makeConfig();
  const cancelled = await runFlow(() => tuiModels.modelsFlow(config), {});
  assert.equal(cancelled, '');

  // Empty library: the browser opens an explanatory page instead of an empty list.
  // 模型库为空：浏览入口打开一页说明，而不是一张空列表。
  const empty = await runFlow(() => tuiModels.modelsFlow(config), { action: 'browse' });
  assert.match(empty, /本地模型库还没有记录/);

  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'A' });
  // Local model management is: the list, then the page of one model (update / verify / pin / open /
  // forget).
  //
  // 本地模型管理 = 列表 → 该模型的页面（更新 / 校验 / 固定 / 打开目录 / 删除记录）。
  const opened = await runFlow(
    () => tuiModels.modelsFlow(config),
    { action: 'browse' },
    { value: '900' },
    { action: 'back' }
  );
  assert.match(opened, /Model 900/);
  assert.match(opened, /v5/);
  assert.match(opened, /4 B/);
});

test('tui/models: 检查更新（全部 + 快速）输出报告且无变化时不下载', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'A' });
  onlineDetails.set('900', {
    id: 900,
    name: 'Model 900',
    type: 'LORA',
    modelVersions: [
      {
        id: 5,
        name: 'v5',
        baseModel: 'SDXL',
        files: [
          {
            id: 1,
            name: 'a.bin',
            type: 'Model',
            primary: true,
            sizeKB: 0.00390625,
            hashes: { SHA256: 'A'.repeat(64) },
            downloadUrl: 'https://example.invalid/5/a.bin',
          },
        ],
      },
    ],
  });
  try {
    const out = await runFlow(
      () => tuiModels.modelsFlow(config),
      { action: 'check' },
      { scope: '__all__' },
      { deep: false }
    );
    assert.match(out, /检查完成：模型 Model 900（900）/);
    assert.match(out, /全部正常/);
  } finally {
    onlineDetails.delete('900');
  }
});

test('tui/models: 固定版本与删除记录（只删记录，不动文件）', async () => {
  const config = makeConfig();
  seed(config, 900, { versionId: 5, versionName: 'v5', fileName: 'a.bin', content: 'aaaa', dirName: 'A' });

  // Everything below happens on the page of one model: pick it in the list, then choose the action.
  // Whether "pin" pins or unpins follows from the record, so there is no separate direction menu.
  //
  // 下面全部发生在单个模型的页面上：先在列表里选中它，再选动作。
  // 「固定」是固定还是取消固定由记录决定，因此没有单独的方向菜单。
  const pinned = await runFlow(
    () => tuiModels.modelsFlow(config),
    { action: 'browse' },
    { value: '900' },
    { action: 'pin' },
    { value: '5' },
    { action: 'back' }
  );
  assert.match(pinned, /已固定: Model 900 → v5/);
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, '5');

  const unpinned = await runFlow(
    () => tuiModels.modelsFlow(config),
    { action: 'browse' },
    { value: '900' },
    { action: 'pin' },
    { ok: true },
    { action: 'back' }
  );
  assert.match(unpinned, /已取消固定/);
  assert.equal(readLibrary(config).entries['900'].pinnedVersionId, null);

  const forgotten = await runFlow(
    () => tuiModels.modelsFlow(config),
    { action: 'browse' },
    { value: '900' },
    { action: 'forget' },
    { ok: true },
    { files: false }
  );
  assert.match(forgotten, /已删除 1 条模型记录/);
  assert.deepEqual(Object.keys(readLibrary(config).entries), []);
  assert.ok(fs.existsSync(path.join(config.outDir, 'A', 'a.bin')), '未选择删文件时磁盘文件保留');
});
