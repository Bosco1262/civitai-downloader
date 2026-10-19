'use strict';

/**
 * Tests for the new storage and directory-layout layer:
 *  - src/layout.js: type folders, base-model layer, composeDirName, version labels and the file-name planner
 *  - src/storage.js: library round-trip, atomic write + .bak, corruption protection, collection changes, legacy cleanup
 *  - the download job end to end: layout directories, one record per model, several versions in one directory
 *
 * 新存储与目录布局层的测试：
 *  - src/layout.js：类型目录、底模层、composeDirName、版本标签与文件名规划
 *  - src/storage.js：模型库往返、原子写 + .bak、损坏保护、收藏集变化、旧格式清理
 *  - 下载流程端到端：布局目录、一模型一记录、多版本共用一个目录
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const layout = require('../src/layout');
const storage = require('../src/storage');
const { runDownloadJob } = require('../src/job');
const { validateConfig, DEFAULTS } = require('../src/config');
const { ConfigError, StateCorruptError } = require('../src/errors');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-library-${tag}-`));
}

function makeConfig(extra = {}) {
  const root = tempDir('cfg');
  const config = validateConfig({
    ...DEFAULTS,
    site: 'http://127.0.0.1:1',
    outDir: path.join(root, 'downloads'),
    profileDir: path.join(root, 'profile'),
    userAgent: 'test-agent',
    retries: 0,
    apiRateLimit: 0,
    ...extra,
  });
  config.root = root;
  config.dataDir = path.join(root, '.data');
  config.cookiesFile = path.join(config.dataDir, 'cookies.txt');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.cookiesFile, '# Netscape HTTP Cookie File\n', 'utf8');
  return config;
}

// ---------------------------------------------------------------------------
// layout.typeFolderFor
// layout.typeFolderFor（类型目录映射）
// ---------------------------------------------------------------------------

test('layout.typeFolderFor: a1111 预设的映射与未知类型回退', () => {
  assert.equal(layout.typeFolderFor('LORA', 'a1111'), 'Lora');
  assert.equal(layout.typeFolderFor('LoCon', 'a1111'), 'Lora');
  assert.equal(layout.typeFolderFor('Checkpoint', 'a1111'), 'Stable-diffusion');
  assert.equal(layout.typeFolderFor('TextualInversion', 'a1111'), 'embeddings');
  assert.equal(layout.typeFolderFor('VAE', 'a1111'), 'VAE');
  assert.equal(layout.typeFolderFor('Controlnet', 'a1111'), 'ControlNet');
  assert.equal(layout.typeFolderFor('Upscaler', 'a1111'), 'ESRGAN');
  assert.equal(layout.typeFolderFor('MotionModule', 'a1111'), 'AnimateDiff');
  assert.equal(layout.typeFolderFor('Workflows', 'a1111'), 'workflows');
  assert.equal(layout.typeFolderFor('lora', 'a1111'), 'Lora', '大小写不敏感');
  assert.equal(layout.typeFolderFor('Something', 'a1111'), 'other');
  assert.equal(layout.typeFolderFor(null, 'a1111'), 'other');
  assert.equal(layout.typeFolderFor('LORA', undefined), 'Lora', '默认布局是 a1111');
});

test('layout.typeFolderFor: comfy 预设的映射', () => {
  assert.equal(layout.typeFolderFor('LORA', 'comfy'), 'loras');
  assert.equal(layout.typeFolderFor('Checkpoint', 'comfy'), 'checkpoints');
  assert.equal(layout.typeFolderFor('TextualInversion', 'comfy'), 'embeddings');
  assert.equal(layout.typeFolderFor('VAE', 'comfy'), 'vae');
  assert.equal(layout.typeFolderFor('Controlnet', 'comfy'), 'controlnet');
  assert.equal(layout.typeFolderFor('Upscaler', 'comfy'), 'upscale_models');
  assert.equal(layout.typeFolderFor('MotionModule', 'comfy'), 'animatediff_models');
  assert.equal(layout.typeFolderFor('Workflows', 'comfy'), 'workflows');
  assert.equal(layout.typeFolderFor('Nope', 'comfy'), 'other');
});

test('layout.typeFolderFor: custom 预设使用 typeFolders，缺键回退 other', () => {
  const map = { LORA: 'lora', Checkpoint: 'ckpt', Weird: 'x/y' };
  assert.equal(layout.typeFolderFor('LORA', 'custom', map), 'lora');
  assert.equal(layout.typeFolderFor('checkpoint', 'custom', map), 'ckpt', 'custom 同样大小写不敏感');
  assert.equal(layout.typeFolderFor('VAE', 'custom', map), 'other', '缺失的键回退 other');
  assert.equal(layout.typeFolderFor('Weird', 'custom', map), 'x_y', '目录名里的非法字符被替换');
  assert.equal(layout.typeFolderFor('LORA', 'custom'), 'other', '没有映射时回退 other');
  assert.equal(layout.typeFolderFor('LORA', 'custom', { LORA: '   ' }), 'other', '空白值视为缺失');
  assert.equal(layout.normalizeLayout('COMFT'), 'a1111', '未知布局名回落默认');
  assert.equal(layout.normalizeLayout('comfy'), 'comfy');
});

// ---------------------------------------------------------------------------
// layout.baseModelFolder
// layout.baseModelFolder（底模归一化）
// ---------------------------------------------------------------------------

test('layout.baseModelFolder: 直接用站点 Base Model 原值，空值/非法值回退 unknown', () => {
  assert.equal(layout.baseModelFolder('SDXL'), 'SDXL', '保留站点原样的大小写');
  assert.equal(layout.baseModelFolder('SDXL 1.0'), 'SDXL 1.0', '保留空格与点号，目录名与站点一致');
  assert.equal(layout.baseModelFolder('  SD 1.5  '), 'SD 1.5');
  assert.equal(layout.baseModelFolder('Flux   Dev'), 'Flux Dev', '连续空白折叠为一个空格');
  assert.equal(layout.baseModelFolder('Pony'), 'Pony');
  assert.equal(layout.baseModelFolder('My/Base:Model'), 'My_Base_Model', '非法字符替换为下划线');
  assert.equal(layout.baseModelFolder(''), 'unknown');
  assert.equal(layout.baseModelFolder('   '), 'unknown');
  assert.equal(layout.baseModelFolder('...'), 'unknown', '清理后为空则回退 unknown');
  assert.equal(layout.baseModelFolder(null), 'unknown');
  assert.equal(layout.baseModelFolder(undefined), 'unknown');
});

test('layout.baseModelFolder: 只认站点原值，不存在自定义映射', () => {
  assert.equal(layout.baseModelFolder.length, 1, 'baseModelFolder 只接收底模名一个参数');
  assert.equal(layout.baseModelFolder('SDXL'), 'SDXL');
});

// ---------------------------------------------------------------------------
// layout.composeDirName
// layout.composeDirName（相对目录拼接）
// ---------------------------------------------------------------------------

test('layout.composeDirName: 不带底模层时只有类型目录 + 模型名', () => {
  assert.equal(layout.composeDirName({ name: 'My Model', type: 'LORA' }), 'Lora/My Model');
  assert.equal(
    layout.composeDirName({ name: 'My Model', type: 'Checkpoint', layout: 'comfy' }),
    'checkpoints/My Model'
  );
  assert.equal(layout.composeDirName({ name: 'My Model', type: 'Nope' }), 'other/My Model');
  assert.equal(
    layout.composeDirName({ name: 'model', type: 'LORA', baseModel: 'SDXL', baseModelLayer: false }),
    'Lora/model',
    '开关关闭时不加底模层'
  );
});

test('layout.composeDirName: 底模层始终插入，目录名用站点原值（未知用 unknown）', () => {
  assert.equal(
    layout.composeDirName({ name: 'My Model', type: 'LORA', baseModel: 'SDXL', baseModelLayer: true }),
    'Lora/SDXL/My Model'
  );
  assert.equal(
    layout.composeDirName({ name: 'My Model', type: 'LORA', layout: 'comfy', baseModel: 'SD 1.5', baseModelLayer: true }),
    'loras/SD 1.5/My Model'
  );
  assert.equal(
    layout.composeDirName({ name: 'My Model', type: 'LORA', baseModel: '', baseModelLayer: true }),
    'Lora/unknown/My Model',
    '无法识别底模时不跳过该层'
  );
  assert.equal(
    layout.composeDirName({ name: 'x', type: 'LORA', layout: 'custom', customMap: { LORA: 'lora' }, baseModelLayer: true }),
    'lora/unknown/x'
  );
});

test('layout.composeDirName: 不含版本子目录，非法字符逐段清理', () => {
  const dir = layout.composeDirName({ name: 'A/B:C*D?', type: 'LORA' });
  assert.equal(dir.split('/').length, 2, '目录层级固定为「类型/模型」，与版本无关');
  assert.equal(dir, 'Lora/A_B_C_D_', '模型名内部的非法字符被替换（不是整体 sanitize 掉分隔符）');
  assert.equal(layout.fitDirName('D:/out', dir), dir, '短路径原样返回');
});

test('layout.versionLabel / withVersionSuffix: 标签与多扩展名', () => {
  assert.equal(layout.versionLabel('v2', 2), 'v2');
  assert.equal(layout.versionLabel(null, 77), 'v77');
  assert.equal(layout.versionLabel('a/b', 1), 'a_b');
  assert.equal(layout.withVersionSuffix('model.safetensors', 'v2'), 'model-v2.safetensors');
  assert.equal(layout.withVersionSuffix('a.b.ckpt', 'v2'), 'a.b-v2.ckpt', '只加在最后一个扩展名前');
  assert.equal(layout.withVersionSuffix('model', 'v2'), 'model-v2');
  assert.equal(layout.withVersionSuffix('model-v2.safetensors', 'v2'), 'model-v2.safetensors', '幂等');
});

// ---------------------------------------------------------------------------
// layout.planFileNames
// layout.planFileNames（版本文件名规划）
// ---------------------------------------------------------------------------

function versionRec(versionId, versionName, files) {
  return { versionId, versionName, files };
}

test('layout.planFileNames: 已进入后缀模式的目录，新版本即使不撞名也带后缀', () => {
  const entries = [
    { versionId: '1', versionName: 'v1', files: [{ name: 'model-v1.safetensors', remoteName: 'model.safetensors', sha256: 'AAAA', bytes: 10 }] },
    { versionId: '2', versionName: 'v2', files: [{ name: 'model-v2.safetensors', remoteName: 'model.safetensors', sha256: 'BBBB', bytes: 20 }] },
  ];
  const plan = layout.planFileNames({
    dir: '/d',
    version: { versionId: '3', versionName: 'v3', files: [{ name: 'model.safetensors', remoteName: 'model.safetensors', sha256: 'CCCC', bytes: 30 }] },
    entries,
  });
  assert.equal(plan.conflict, false, '本次并没有与其它版本撞名');
  assert.equal(plan.suffixMode, true, '但目录已处于后缀模式，应保持一致');
  assert.equal(plan.names[0].diskName, 'model-v3.safetensors');
  assert.deepEqual(plan.renames, [], '旧版本已带后缀，不需要再改名');
});

test('layout.planFileNames: 没有冲突时不改名', () => {
  const planned = layout.planFileNames({
    dir: 'D:/out/Lora/M',
    version: versionRec(2, 'v2', [{ name: 'other.safetensors', sha256: 'BB', bytes: 20 }]),
    entries: [versionRec(1, 'v1', [{ name: 'model.safetensors', sha256: 'AA', bytes: 10 }])],
  });
  assert.equal(planned.conflict, false);
  assert.deepEqual(planned.renames, []);
  assert.deepEqual(planned.names, [{ remoteName: 'other.safetensors', diskName: 'other.safetensors', renamed: false }]);
});

test('layout.planFileNames: 同名不同内容 → 双方整版加后缀', () => {
  const planned = layout.planFileNames({
    dir: 'D:/out/Lora/M',
    version: versionRec(2, 'v2', [
      { name: 'model.safetensors', sha256: 'BB', bytes: 20 },
      { name: 'extra.safetensors', sha256: 'BB', bytes: 20 },
    ]),
    entries: [
      versionRec(1, 'v1', [
        { name: 'model.safetensors', sha256: 'AA', bytes: 10 },
        { name: 'extra.safetensors', sha256: 'AA', bytes: 10 },
      ]),
    ],
  });
  assert.equal(planned.conflict, true);
  assert.deepEqual(planned.names.map((n) => n.diskName), ['model-v2.safetensors', 'extra-v2.safetensors']);
  assert.deepEqual(planned.renames, [
    { versionId: '1', from: 'model.safetensors', to: 'model-v1.safetensors' },
    { versionId: '1', from: 'extra.safetensors', to: 'extra-v1.safetensors' },
  ], '旧版本的全部文件都改名（整版统一）');
});

test('layout.planFileNames: 同名同内容不算冲突（缺少哈希时比大小）', () => {
  const bySha = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', [{ name: 'a.bin', sha256: 'AA', bytes: 10 }]),
    entries: [versionRec(1, 'v1', [{ name: 'a.bin', sha256: 'AA', bytes: 999 }])],
  });
  assert.equal(bySha.conflict, false, '哈希一致即内容一致');

  const byBytes = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', [{ name: 'a.bin', sha256: null, bytes: 10 }]),
    entries: [versionRec(1, 'v1', [{ name: 'a.bin', sha256: null, bytes: 10 }])],
  });
  assert.equal(byBytes.conflict, false, '都没有哈希时比大小');

  const differs = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', [{ name: 'a.bin', sha256: null, bytes: 11 }]),
    entries: [versionRec(1, 'v1', [{ name: 'a.bin', sha256: null, bytes: 10 }])],
  });
  assert.equal(differs.conflict, true, '大小不同即冲突');
});

test('layout.planFileNames: 已带后缀时不重复追加（幂等）', () => {
  const planned = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', [{ name: 'model-v2.safetensors', sha256: 'BB', bytes: 20 }]),
    entries: [versionRec(1, 'v1', [{ name: 'model-v1.safetensors', sha256: 'AA', bytes: 10 }])],
  });
  // Different names: no clash at all
  // 文件名不同：完全不算冲突
  assert.equal(planned.conflict, false);

  const again = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', [{ name: 'model.safetensors', sha256: 'BB', bytes: 20 }]),
    entries: [versionRec(1, 'v1', [{ name: 'model.safetensors', sha256: 'AA', bytes: 10 }])],
  });
  const rerun = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2, 'v2', again.names.map((n) => ({ name: n.diskName, sha256: 'BB', bytes: 20 }))),
    entries: [
      versionRec(
        1,
        'v1',
        again.renames.map((r) => ({ name: r.to, sha256: 'AA', bytes: 10 }))
      ),
    ],
  });
  assert.deepEqual(rerun.names.map((n) => n.diskName), ['model-v2.safetensors'], '不会变成 model-v2-v2');
});

test('layout.planFileNames: 版本名相同则追加版本 ID 短标签', () => {
  const planned = layout.planFileNames({
    dir: 'D:/out',
    version: versionRec(2002, 'v1.0', [{ name: 'm.safetensors', sha256: 'BB', bytes: 20 }]),
    entries: [versionRec(1001, 'v1.0', [{ name: 'm.safetensors', sha256: 'AA', bytes: 10 }])],
  });
  assert.deepEqual(planned.names.map((n) => n.diskName), ['m-v1.0-2002.safetensors']);
  assert.deepEqual(planned.renames, [{ versionId: '1001', from: 'm.safetensors', to: 'm-v1.0-1001.safetensors' }]);
});

test('layout.fitDirName: 逐段清理与缩短，分隔符保留', () => {
  const long = 'x'.repeat(400);
  const dir = `Lora/${long}/Model`;
  const fitted = layout.fitDirName('C:\\out', dir);
  assert.equal(fitted.split('/').length, 3, '仍然是三段');
  assert.ok(!fitted.includes('Lora_'), '不会把分隔符变成下划线');
  assert.ok(fitted.startsWith('Lora/'));
  assert.ok(path.join('C:\\out', fitted).length <= 250);
});

// ---------------------------------------------------------------------------
// Library read/write
// Library read/write（模型库读写）
// ---------------------------------------------------------------------------

test('storage: 模型库往返、schemaVersion 与 .bak', () => {
  const config = makeConfig();
  const entries = {};
  storage.upsertVersion(entries, 1, {
    name: 'A',
    type: 'LORA',
    baseModel: 'SDXL',
    versionId: 10,
    versionName: 'v10',
    dirName: 'Lora/A',
    outDir: config.outDir,
    files: [{ name: 'a.safetensors', sha256: 'aa', bytes: 5 }],
  });
  storage.writeLibrary(config, entries);

  const raw = JSON.parse(fs.readFileSync(storage.libraryPath(config), 'utf8'));
  assert.equal(raw.schemaVersion, storage.LIBRARY_SCHEMA);
  assert.ok(raw.updatedAt);
  const back = storage.readLibrary(config);
  assert.equal(back.migrated, false);
  assert.equal(back.entries['1'].baseModel, 'SDXL');
  assert.equal(storage.getVersion(back.entries['1'], 10).files[0].sha256, 'AA');

  storage.writeLibrary(config, {});
  assert.ok(fs.existsSync(`${storage.libraryPath(config)}.bak`), '第二次写入保留备份');
  assert.deepEqual(storage.readLibrary(config).entries, {});
  assert.equal(JSON.parse(fs.readFileSync(`${storage.libraryPath(config)}.bak`, 'utf8')).entries['1'].name, 'A');
});

test('storage: 损坏的模型库先备份再报错，allowCorrupt 返回空', () => {
  const config = makeConfig();
  fs.writeFileSync(storage.libraryPath(config), '{ broken', 'utf8');
  assert.throws(() => storage.readLibrary(config), (e) => {
    assert.ok(e instanceof StateCorruptError);
    assert.ok(fs.existsSync(e.backupFile));
    return true;
  });
  const tolerant = storage.readLibrary(config, { allowCorrupt: true });
  assert.deepEqual(tolerant.entries, {});
  assert.ok(tolerant.corrupt);
});

// ---------------------------------------------------------------------------
// Collection changes
// Collection changes（收藏集变化报告）
// ---------------------------------------------------------------------------

test('storage.writeCollection: 首次无变化，之后能算出新增/移除/版本变化', () => {
  const config = makeConfig();
  const first = storage.writeCollection(config, '1', {
    items: [{ modelId: 1, name: 'A', versionId: 10 }],
  });
  assert.deepEqual(first.changes.added, []);
  assert.deepEqual(first.changes.removed, []);
  assert.deepEqual(first.changes.versionChanged, []);
  assert.equal(first.changes.previousFetchedAt, null);

  const second = storage.writeCollection(config, '1', {
    items: [
      { modelId: 1, name: 'A', versionId: 11 },
      { modelId: 9, name: 'New', versionId: 90 },
    ],
  });
  assert.deepEqual(second.changes.added, [{ modelId: 9, name: 'New' }]);
  assert.deepEqual(second.changes.removed, []);
  assert.deepEqual(second.changes.versionChanged, [
    { modelId: 1, name: 'A', fromVersionId: 10, toVersionId: 11 },
  ]);
  assert.equal(second.changes.previousFetchedAt, first.fetchedAt);

  const third = storage.writeCollection(config, '1', { items: [{ modelId: 1, name: 'A', versionId: 11 }] });
  assert.deepEqual(third.changes.removed, [{ modelId: 9, name: 'New' }]);
  assert.deepEqual(third.changes.added, []);
  assert.deepEqual(third.changes.versionChanged, []);

  const reread = storage.readCollection(config, '1').snapshot;
  assert.equal(reread.items.length, 1);
  assert.equal(reread.changes.removed.length, 1, '变化报告随快照一起持久化');
  assert.deepEqual(storage.listCollectionIds(config), ['1']);
});

// ---------------------------------------------------------------------------
// Legacy cleanup
// Legacy cleanup（旧格式清理）
// ---------------------------------------------------------------------------

test('storage.cleanupLegacy: 旧文件移入 legacy 且不再被读取', () => {
  const config = makeConfig();
  const oldState = path.join(config.dataDir, 'state-777.json');
  fs.writeFileSync(
    oldState,
    JSON.stringify({ schemaVersion: 3, entries: { 5: { name: 'Old', versions: {} } } }),
    'utf8'
  );
  fs.writeFileSync(path.join(config.dataDir, 'items-777.json'), '{"items":[]}', 'utf8');

  const moved = storage.cleanupLegacy(config, () => {});
  assert.equal(moved, 2);
  assert.ok(!fs.existsSync(oldState), '旧 state 文件被移走');
  assert.ok(fs.existsSync(path.join(storage.legacyDir(config), 'state-777.json')));
  assert.deepEqual(storage.readLibrary(config).entries, {}, '旧的 state-*.json 一律不再被读取');
});

test('job: 首次运行时自动清理旧格式文件并提示', async () => {
  const config = makeConfig();
  fs.writeFileSync(path.join(config.dataDir, 'state-777.json'), '{}', 'utf8');
  const lines = [];
  const deps = {
    checkCurl: () => 'curl',
    notify: async () => {},
  };
  await runDownloadJob(
    config,
    {
      collectionId: '777',
      plan: [],
      items: [],
      outDir: config.outDir,
      jobs: 1,
      deps,
    },
    { log: (m) => lines.push(m) }
  ).catch(() => {});
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'state-777.json')), '旧文件被移入 legacy');
  assert.ok(
    lines.some((l) => l.includes('legacy')),
    '应有旧格式清理提示'
  );
});

// ---------------------------------------------------------------------------
// Job end to end
// Job end to end（下载流程端到端）
// ---------------------------------------------------------------------------

function downloadDeps(contentByName) {
  return {
    ensureBrowser: async () => ({ pages: async () => [], disconnect: async () => {} }),
    findSitePage: async () => ({}),
    openUrl: async () => ({}),
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

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function planItem({ modelId, name, type, baseModel, versionId, versionName, fileName, content, fileId }) {
  return {
    modelId,
    name,
    type,
    baseModel,
    versionId,
    versionName,
    files: [
      {
        fileId,
        name: fileName,
        remoteName: fileName,
        sha256: sha(content),
        bytes: content.length,
        downloadUrl: `https://example.invalid/${versionId}/${fileName}`,
      },
    ],
    totalBytes: content.length,
  };
}

test('job 端到端：同一模型两个版本 → 目录符合 layout，库里两个版本都在', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('v1-content\n'.repeat(30));
  const v2 = Buffer.from('v2-content\n'.repeat(40));
  const deps = downloadDeps({ 'm-v1.bin': v1, 'm-v2.bin': v2 });

  for (const item of [
    planItem({ modelId: 50, name: 'Layout Model', type: 'LORA', baseModel: 'SDXL', versionId: 1, versionName: 'v1', fileName: 'm-v1.bin', content: v1, fileId: 1 }),
    planItem({ modelId: 50, name: 'Layout Model', type: 'LORA', baseModel: 'SDXL', versionId: 2, versionName: 'v2', fileName: 'm-v2.bin', content: v2, fileId: 2 }),
  ]) {
    await runDownloadJob(
      config,
      { collectionId: 'model-50', plan: [item], outDir: config.outDir, jobs: 1, deps },
      { log: () => {} }
    );
  }

  const { entries } = storage.readLibrary(config);
  assert.deepEqual(storage.versionIds(entries['50']).sort(), ['1', '2']);
  assert.equal(storage.getVersion(entries['50'], 1).dirName, 'Lora/Layout Model', 'a1111 默认布局');
  assert.equal(storage.getVersion(entries['50'], 2).dirName, 'Lora/Layout Model', '同一模型共用一个目录');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Layout Model', 'm-v1.bin')));
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Layout Model', 'm-v2.bin')));
});

test('job 端到端：同一份计划里同一模型两个版本 → 两个版本都下载', async () => {
  const config = makeConfig();
  const v1 = Buffer.from('same-plan-v1\n'.repeat(20));
  const v2 = Buffer.from('same-plan-v2\n'.repeat(25));
  const deps = downloadDeps({ 'same-v1.bin': v1, 'same-v2.bin': v2 });

  const plan = [
    planItem({ modelId: 55, name: 'Twin Model', type: 'LORA', baseModel: 'SDXL', versionId: 1, versionName: 'v1', fileName: 'same-v1.bin', content: v1, fileId: 11 }),
    planItem({ modelId: 55, name: 'Twin Model', type: 'LORA', baseModel: 'SDXL', versionId: 2, versionName: 'v2', fileName: 'same-v2.bin', content: v2, fileId: 12 }),
  ];
  await runDownloadJob(
    config,
    { collectionId: 'model-55', plan, outDir: config.outDir, jobs: 2, deps },
    { log: () => {} }
  );

  const { entries } = storage.readLibrary(config);
  assert.deepEqual(storage.versionIds(entries['55']).sort(), ['1', '2'], '同一计划里的两个版本都入库');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Twin Model', 'same-v1.bin')));
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Twin Model', 'same-v2.bin')));
});

test('job 端到端：底模层开启 + 同一模型横跨两种底模 → 按底模各放一处', async () => {
  const config = makeConfig({ baseModelLayer: true });
  const sdxl = Buffer.from('sdxl-content\n'.repeat(30));
  const sd15 = Buffer.from('sd15-content\n'.repeat(20));
  const deps = downloadDeps({ 'sdxl.bin': sdxl, 'sd15.bin': sd15 });

  for (const item of [
    planItem({ modelId: 60, name: 'Mixed Model', type: 'LORA', baseModel: 'SDXL 1.0', versionId: 1, versionName: 'sdxl-v3', fileName: 'sdxl.bin', content: sdxl, fileId: 1 }),
    planItem({ modelId: 60, name: 'Mixed Model', type: 'LORA', baseModel: 'SD 1.5', versionId: 2, versionName: 'SD1.5-v3', fileName: 'sd15.bin', content: sd15, fileId: 2 }),
  ]) {
    await runDownloadJob(
      config,
      { collectionId: 'model-60', plan: [item], outDir: config.outDir, jobs: 1, deps },
      { log: () => {} }
    );
  }

  const { entries } = storage.readLibrary(config);
  assert.equal(storage.getVersion(entries['60'], 1).dirName, 'Lora/SDXL 1.0/Mixed Model');
  assert.equal(storage.getVersion(entries['60'], 2).dirName, 'Lora/SD 1.5/Mixed Model', '底模不同则各放一处');
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'SDXL 1.0', 'Mixed Model', 'sdxl.bin')));
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'SD 1.5', 'Mixed Model', 'sd15.bin')));
});

test('job 端到端：底模层开启 + 同一模型同一底模的两个版本 → 仍共用一个目录', async () => {
  const config = makeConfig({ baseModelLayer: true });
  const v1 = Buffer.from('a\n'.repeat(30));
  const v2 = Buffer.from('b\n'.repeat(20));
  const deps = downloadDeps({ 'a.bin': v1, 'b.bin': v2 });

  for (const item of [
    planItem({ modelId: 61, name: 'Same Base', type: 'LORA', baseModel: 'Pony', versionId: 1, versionName: 'v1', fileName: 'a.bin', content: v1, fileId: 1 }),
    planItem({ modelId: 61, name: 'Same Base', type: 'LORA', baseModel: 'Pony', versionId: 2, versionName: 'v2', fileName: 'b.bin', content: v2, fileId: 2 }),
  ]) {
    await runDownloadJob(
      config,
      { collectionId: 'model-61', plan: [item], outDir: config.outDir, jobs: 1, deps },
      { log: () => {} }
    );
  }

  const { entries } = storage.readLibrary(config);
  assert.equal(storage.getVersion(entries['61'], 1).dirName, 'Lora/Pony/Same Base');
  assert.equal(storage.getVersion(entries['61'], 2).dirName, 'Lora/Pony/Same Base');
});

test('job 端到端：layout=comfy + 底模层 → loras/<站点底模>/模型名', async () => {
  const config = makeConfig({ layout: 'comfy', baseModelLayer: true });
  const content = Buffer.from('comfy\n'.repeat(20));
  const deps = downloadDeps({ 'm.bin': content });

  await runDownloadJob(
    config,
    {
      collectionId: 'model-51',
      plan: [
        planItem({
          modelId: 51,
          name: 'Comfy Model',
          type: 'LORA',
          baseModel: 'SDXL',
          versionId: 1,
          versionName: 'v1',
          fileName: 'm.bin',
          content,
          fileId: 1,
        }),
      ],
      outDir: config.outDir,
      jobs: 1,
      deps,
    },
    { log: () => {} }
  );

  assert.ok(fs.existsSync(path.join(config.outDir, 'loras', 'SDXL', 'Comfy Model', 'm.bin')));
  const rec = storage.getVersion(storage.readLibrary(config).entries['51'], 1);
  assert.equal(rec.dirName, 'loras/SDXL/Comfy Model');
  assert.equal(rec.baseModel, 'SDXL');
});

test('job 端到端：枚举后写入收藏集快照并记录变化', async () => {
  const config = makeConfig();
  const content = Buffer.from('snap\n'.repeat(20));
  const deps = downloadDeps({ 'm.bin': content });
  deps.fetchCollectionItems = async () => [
    { modelId: 60, name: 'Snap Model', type: 'LORA', baseModel: 'SDXL', versionId: 5, versionName: 'v5' },
  ];
  deps.buildPlan = async (site, items) => ({
    plan: items.map((it) => ({
      ...it,
      files: [
        {
          fileId: 1,
          name: 'm.bin',
          remoteName: 'm.bin',
          sha256: sha(content),
          bytes: content.length,
          downloadUrl: 'https://example.invalid/5/m.bin',
        },
      ],
      totalBytes: content.length,
    })),
    totalBytes: content.length,
    failed: 0,
  });

  const lines = [];
  await runDownloadJob(
    config,
    { collectionId: '888', outDir: config.outDir, jobs: 1, deps },
    { log: (m) => lines.push(m) }
  );

  const { snapshot } = storage.readCollection(config, '888');
  assert.ok(snapshot, '枚举后写入成员快照');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].modelId, 60);
  assert.equal(snapshot.items[0].versionId, 5);
  assert.ok(lines.some((l) => l.includes('快照')), '日志里有快照提示');
});

// ---------------------------------------------------------------------------
// config: layout options
// config: layout options（布局相关配置项）
// ---------------------------------------------------------------------------

test('config: layout / baseModelLayer / typeFolders 的默认值与校验', () => {
  const base = validateConfig({ ...DEFAULTS });
  assert.equal(base.layout, 'a1111');
  assert.equal(base.baseModelLayer, false);
  assert.deepEqual(base.typeFolders, {});

  assert.equal(validateConfig({ ...DEFAULTS, layout: 'comfy' }).layout, 'comfy');
  assert.equal(validateConfig({ ...DEFAULTS, layout: 'CUSTOM' }).layout, 'custom', '归一化为小写');
  assert.equal(validateConfig({ ...DEFAULTS, baseModelLayer: 'yes' }).baseModelLayer, false, '只有 true 才开启');
  assert.deepEqual(
    validateConfig({ ...DEFAULTS, typeFolders: { LORA: ' lora ' } }).typeFolders,
    { LORA: 'lora' }
  );

  assert.throws(
    () => validateConfig({ ...DEFAULTS, layout: 'wat' }),
    (e) => e instanceof ConfigError && /layout/.test(e.message)
  );
  assert.throws(() => validateConfig({ ...DEFAULTS, typeFolders: [] }), /typeFolders/);
  assert.throws(() => validateConfig({ ...DEFAULTS, typeFolders: { LORA: '' } }), /typeFolders/);
});
