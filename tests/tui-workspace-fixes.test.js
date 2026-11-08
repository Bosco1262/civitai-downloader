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

const i18n = require('../src/i18n');
const screen = require('../src/tui/screen');
const report = require('../src/tui/report');
const tasks = require('../src/tui/tasks');
const storage = require('../src/storage');
const download = require('../src/tui/download');
const models = require('../src/tui/models');
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

test('download: 回执页提供查看任务 / 继续下载 / 返回主菜单，Esc 只回上一级', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    tasks.reset();
    assert.equal(screen.start({ onQuit: () => {} }), true);

    const first = tasks.createTask({ kind: 'download', name: 'T1', total: 1, totalBytes: 1 });
    const firstPage = download.receiptPage(first);
    await settle();
    key('down');
    key('return');
    assert.equal(await firstPage, 'download');

    const second = tasks.createTask({ kind: 'download', name: 'T2', total: 1, totalBytes: 1 });
    const secondPage = download.receiptPage(second);
    await settle();
    key('escape');
    assert.equal(await secondPage, 'download');

    const third = tasks.createTask({ kind: 'download', name: 'T3', total: 1, totalBytes: 1 });
    const thirdPage = download.receiptPage(third);
    await settle();
    key('down');
    key('down');
    key('return');
    assert.equal(await thirdPage, 'main');
    tasks.reset();
  });
});

test('models: 裸数字按模型 ID 处理，而不是收藏集 ID', () => {
  assert.equal(models.normalizeModelInput('2458426'), 'model:2458426');
  assert.equal(
    models.normalizeModelInput('https://civitai.red/models/2458426/anima'),
    'https://civitai.red/models/2458426/anima'
  );
});

test('workspace: 输入后显示模型标题，版本页返回后清空并回到列表', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载模型',
      inputLabel: '模型 ID 或模型页 URL',
      resultLabel: '模型标题',
      rows: [],
      selected: new Set(),
      idOf: (row) => String(row.modelId),
      resolveInput: async () => [
        { modelId: '1', name: 'Illustrious-XL', versionId: '0.1', versionName: 'v0.1' },
      ],
      openRow: async (row) => [row],
    });
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('模型标题'), frame().join('\n'));
    assert.ok(frame().join('\n').includes('已选 0/0 项'), frame().join('\n'));
    key('x', 'x');
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('模型标题  Illustrious-XL'), frame().join('\n'));
    assert.ok(frame().join('\n').includes('已选 1/1 项'), frame().join('\n'));
    key('tab');
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('▸ [✓] Illustrious-XL'), frame().join('\n'));
    assert.ok(!frame().join('\n').includes('▸ 确认选择'), frame().join('\n'));
    assert.ok(!frame().join('\n').includes('模型标题  Illustrious-XL'), frame().join('\n'));
    key('escape');
    assert.equal(await pending, null);
  });
});

test('workspace: 同一模型的多个版本合并为一行', () => {
  const groups = download.groupPlanRows([
    { modelId: '1', name: 'Anima', versionId: '11', versionName: 'v1', totalBytes: 10 },
    { modelId: '1', name: 'Anima', versionId: '12', versionName: 'v2', totalBytes: 20 },
    { modelId: '2', name: 'Other', versionId: '21', versionName: 'v3', totalBytes: 30 },
    { modelId: '2', name: 'Other', versionId: '21', versionName: 'v3', totalBytes: 30 },
    { modelId: '3', name: 'Bad', versionId: '31', error: 'failed' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].versions.length, 2);
  assert.equal(groups[0].versionName, 'v1/v2');
  assert.ok(groups[0].detail.includes('30 B'), groups[0].detail);
  assert.equal(groups[0].totalBytes, 30);
  assert.equal(groups[1].versions.length, 1);
});

test('workspace: 行说明保留版本名，且版本名排在最前（窄终端先丢体积）', () => {
  const groups = download.groupPlanRows([
    {
      modelId: '1',
      name: 'Anima',
      versionId: '11',
      versionName: 'v1',
      baseModel: 'SDXL',
      totalBytes: 10,
      access: { kind: 'public', requiresEntitlement: false },
    },
    {
      modelId: '1',
      name: 'Anima',
      versionId: '12',
      versionName: 'v2',
      baseModel: 'SDXL',
      totalBytes: 20,
      access: { kind: 'public', requiresEntitlement: false },
    },
  ]);
  assert.equal(groups.length, 1);
  const bullet = require('../src/tui/layout').glyphs().bullet;
  assert.equal(groups[0].detail, ['v1/v2', 'SDXL', '30 B'].join(` ${bullet} `));
  assert.ok(groups[0].detail.includes('v1'), groups[0].detail);
  assert.ok(groups[0].detail.includes('30 B'), groups[0].detail);
});

test('workspace: 版本页返回空数组时行保留、复选框变空', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载模型',
      rows: [{ modelId: '1', name: 'Alpha', versionId: '11', versionName: 'v1' }],
      selected: new Set(['1']),
      idOf: (row) => String(row.modelId),
      openRow: async () => [],
    });
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('▸ [✓] Alpha'), frame().join('\n'));
    key('return');
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('Alpha'), `行不应从列表里消失：\n${text}`);
    assert.ok(text.includes('▸ [ ] Alpha'), `复选框应变回空：\n${text}`);
    assert.ok(text.includes('已选 0/1 项'), text);
    key('escape');
    assert.equal(await pending, null);
  });
});

test('workspace: 行未勾选时 openRow 收到的 selected 不含该模型', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    let seen = null;
    const pending = showPlanWorkspace({
      title: '下载模型',
      rows: [{ modelId: '1', name: 'Alpha', versionId: '11', versionName: 'v1' }],
      selected: new Set(),
      idOf: (row) => String(row.modelId),
      openRow: async (row, state) => {
        seen = new Set(state.selected);
        return [row];
      },
    });
    await settle();
    key('return');
    await settle();
    assert.ok(seen, 'openRow 应被调用');
    assert.equal(seen.has('1'), false, '未勾选的行不应带着自己的版本进版本页');
    key('escape');
    assert.equal(await pending, null);
  });
});

test('confirm: 列表区 Enter 无效，Tab 到按钮后确认；Esc 返回选择', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const data = {
      chosen: [{ modelId: '1', versionId: '1', name: 'Alpha', versionName: 'v1' }],
      deletions: [],
      outDir: '/tmp',
      jobs: 1,
    };
    const first = download.workspaceConfirmPage({}, data);
    await settle();
    screen.render();
    assert.ok(!frame().join('\n').includes('界面渲染失败'), frame().join('\n'));
    // Rows Enter must not move focus or start the download.
    // 列表区 Enter 不应移动焦点，也不应开始下载。
    key('return');
    await settle();
    key('tab');
    key('return');
    assert.equal(await first, true);

    const second = download.workspaceConfirmPage({}, data);
    await settle();
    key('escape');
    assert.equal(await second, 'back');
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
      resolveInput: async () => [],
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

test('report: 长只读正文默认从顶部开始，Tab 可到操作区', async () => {
  await withFakeTerminal(
    async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
      const page = report.showReportPage({}, {
        title: '长报告',
        summary: [
          { label: '范围', value: '全部模型' },
          { label: '异常', value: '15' },
        ],
        sections: [
          {
            title: '异常明细',
            rows: Array.from({ length: 15 }, (_, index) => ({
              label: `异常 ${index + 1}`,
              detail: '文件缺失',
            })),
          },
        ],
        actions: [
          { label: '修复', run: () => report.BACK },
          { label: '返回', run: () => report.BACK },
        ],
      });
      await settle();
      screen.render();
      const top = frame().join('\n');
      assert.ok(top.includes('范围') && top.includes('异常 1'), top);
      assert.ok(!top.includes('▸ 修复'), top);

      key('tab');
      await settle();
      screen.render();
      const actions = frame().join('\n');
      assert.ok(actions.includes('▸ 修复'), actions);
      assert.ok(actions.includes(i18n.t('tui.hint.reportActions')), actions);

      key('escape');
      assert.equal(await page, null);
    },
    { columns: 80, rows: 24 }
  );
});

test('confirm: 大计划在 80×24 / 60×20 / 54×12 下仍固定显示开始按钮', async () => {
  for (const size of [
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
    { columns: 54, rows: 12 },
  ]) {
    await withFakeTerminal(
      async ({ frame, key, settle }) => {
        assert.equal(screen.start({ onQuit: () => {} }), true);
        screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
        const data = {
          chosen: Array.from({ length: 15 }, (_, index) => ({
            modelId: String(index + 1),
            versionId: 'v1',
            name: `模型 ${index + 1}`,
            versionName: 'v1',
            totalBytes: 1024,
            access: index === 1
              ? { kind: 'paid', requiresEntitlement: true, defaultSelected: false }
              : { kind: 'public', requiresEntitlement: false, defaultSelected: true },
          })),
          deletions: [],
          outDir: process.cwd(),
          jobs: 3,
        };
        const page = download.workspaceConfirmPage({ fileTypes: ['Model'] }, data);
        await settle();
        screen.render();
        const text = frame().join('\n');
        assert.ok(text.includes(i18n.t('tui.workspace.confirmNext')), `${size.columns}×${size.rows}: ${text}`);
        if (size.columns >= 80) {
          assert.ok(
            text.includes(i18n.t('tui.workspace.selected', { count: 15, total: 15 })),
            `${size.columns}×${size.rows}: ${text}`
          );
        }
        if (size.rows > 12) {
          assert.ok(
            text.includes(i18n.t('tui.workspace.confirmPaidHint', { count: 1 })),
            `${size.columns}×${size.rows}: ${text}`
          );
        }
        assert.ok(
          text.includes('▸ 模型 1（v1）'),
          `${size.columns}×${size.rows}: 确认页光标应默认落在第一个模型\n${text}`
        );

        key('tab');
        await settle();
        screen.render();
        assert.ok(
          frame().join('\n').includes(`▸ ${i18n.t('tui.workspace.confirmNext')}`),
          `${size.columns}×${size.rows}: ${frame().join('\n')}`
        );

        key('escape');
        assert.equal(await page, 'back');
      },
      size
    );
  }
});

test('workspace: 零选择留在页面并提示，不会退出整个流程', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '空选择',
      rows: [{ modelId: '1', name: 'Alpha' }],
      selected: new Set(),
      idOf: (row) => row.modelId,
    });
    await settle();
    key('tab');
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes(i18n.t('tui.workspace.noSelection')), frame().join('\n'));
    key('escape');
    assert.equal(await pending, null);
  });
});

test('workspace: 耗时提示位于页脚上方，而不是页面顶部', async () => {
  let release;
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载模型',
      rows: [],
      selected: new Set(),
      idOf: (row) => row.modelId,
      resolveInput: () => new Promise((resolve) => {
        release = resolve;
      }),
    });
    await settle();
    key('1', '1');
    key('return');
    await settle();
    screen.render();
    const lines = frame();
    const statusIndex = lines.findIndex((line) => line.includes(i18n.t('tui.workspace.resolving')));
    assert.ok(statusIndex > 0, lines.join('\n'));
    assert.ok(statusIndex >= lines.length - 3, `状态槽应在页脚上方：\n${lines.join('\n')}`);
    assert.equal(lines[lines.length - 2].trim(), '', '状态槽与页脚之间必须有空行');
    assert.ok(!lines[0].includes(i18n.t('tui.workspace.resolving')), '提示不应出现在页面顶部');
    release([]);
    await settle();
    key('escape');
    assert.equal(await pending, null);
  });
});

const PAID_ACCESS = { kind: 'paid', requiresEntitlement: true, defaultSelected: false };
const FREE_ACCESS = { kind: 'public', requiresEntitlement: false, defaultSelected: true };
const EARLY_ACCESS = { kind: 'early-access', requiresEntitlement: true, defaultSelected: false };

/**
 * One plan item with the fields `groupPlanRows` reads.
 * 构造一条 `groupPlanRows` 会读取的计划项。
 */
function planItem(modelId, versionId, versionName, baseModel, access, totalBytes = 10, modelAccess = null) {
  return {
    modelId,
    name: `model-${modelId}`,
    versionId: String(versionId),
    versionName,
    baseModel,
    totalBytes,
    access,
    ...(modelAccess ? { modelAccess } : {}),
  };
}

test('workspace: 混合访问的行显示 [付费/免费]，纯付费不重复加版本后缀', () => {
  const { accessLabel } = require('../src/tui/ui/accessText');
  const { summarizeAccess } = require('../src/access');
  const mixed = summarizeAccess([FREE_ACCESS, PAID_ACCESS]);

  const [freeDefault] = download.groupPlanRows([
    planItem('1', '11', 'MIX_V2', 'MOSS', FREE_ACCESS, 10, mixed),
  ]);
  assert.equal(freeDefault.access.mixed, true);
  assert.equal(freeDefault.access.defaultSelected, true, '默认版本免费 → 默认勾选');
  assert.equal(accessLabel(freeDefault.access), '付费/免费');
  assert.equal(freeDefault.versionName, 'MIX_V2', '选中的是免费版，不带后缀');

  const [paidDefault] = download.groupPlanRows([
    planItem('1', '21', 'V4.1 25STEPS CFG3 BF16', 'MOSS', PAID_ACCESS, 10, mixed),
  ]);
  assert.equal(paidDefault.access.mixed, true);
  assert.equal(paidDefault.access.defaultSelected, false, '默认版本付费 → 不勾选');
  assert.equal(paidDefault.versionName, 'V4.1 25STEPS CFG3 BF16（付费）', '混合行给付费版本加后缀');

  const [purePaid] = download.groupPlanRows([
    planItem('2', '31', 'MOSS Image', 'MOSS Image', PAID_ACCESS),
  ]);
  assert.equal(purePaid.access.mixed, false);
  assert.equal(purePaid.access.defaultSelected, false);
  assert.equal(accessLabel(purePaid.access), '付费');
  assert.equal(purePaid.versionName, 'MOSS Image', '纯付费行不再重复加（付费）');

  const [pureFree] = download.groupPlanRows([
    planItem('3', '41', 'v1.0', 'SDXL', FREE_ACCESS),
  ]);
  assert.equal(pureFree.access, null, '全免费不显示徽标');
});

test('workspace: 默认勾选只看本行默认版本（三条规则）', () => {
  const { summarizeAccess } = require('../src/access');
  const mixed = summarizeAccess([FREE_ACCESS, PAID_ACCESS]);
  const cases = [
    ['默认版本付费', PAID_ACCESS, mixed, false],
    ['默认版本免费', FREE_ACCESS, mixed, true],
    ['默认版本免费且模型另有付费版本', FREE_ACCESS, mixed, true],
    ['默认版本限时', EARLY_ACCESS, summarizeAccess([EARLY_ACCESS, PAID_ACCESS]), false],
  ];
  for (const [label, access, modelAccess, expected] of cases) {
    const [group] = download.groupPlanRows([planItem('1', '11', 'v1', 'SDXL', access, 10, modelAccess)]);
    assert.equal(group.access.defaultSelected, expected, label);
  }
});

test('workspace: 案例 1（最新免费 + 另有付费）与案例 5（限时付费 + 免费）', () => {
  const { summarizeAccess } = require('../src/access');
  // Case 1: model 3008033, newest MIX_V2 is free while two permanent paid versions exist.
  // 案例 1：3008033，最新版本 MIX_V2 免费，另有 2 个永久付费版本。
  const case1 = summarizeAccess([
    FREE_ACCESS,
    PAID_ACCESS,
    PAID_ACCESS,
    FREE_ACCESS,
  ]);
  const [c1] = download.groupPlanRows([planItem('3008033', '3456657', 'MIX_V2', 'MOSS Image', FREE_ACCESS, 12, case1)]);
  assert.equal(c1.access.mixed, true);
  assert.equal(c1.access.defaultSelected, true);
  assert.equal(c1.accessCounts.restricted, 2);
  assert.equal(c1.accessCounts.free, 2);

  // Case 5: model 3017010, newest version paid until 2026-11-15, plus a free v1.0.
  // 案例 5：3017010，最新版本限时付费至 2026-11-15，另有免费 v1.0。
  const limited = {
    kind: 'paid',
    reason: 'paid-window',
    paid: true,
    permanent: false,
    endsAt: '2026-11-15T03:10:19.433Z',
    requiresEntitlement: true,
    defaultSelected: false,
  };
  const case5 = summarizeAccess([limited, FREE_ACCESS]);
  const [c5] = download.groupPlanRows([
    planItem('3017010', '3440660', 'MOSS_ultimate reborn_INT8', 'MOSS Image', limited, 24, case5),
  ]);
  assert.equal(c5.access.mixed, true);
  assert.equal(c5.access.defaultSelected, false);
  assert.match(c5.versionName, /付费至 2026-11-15/, c5.versionName);
});

test('workspace: 搜索页渲染出现 [付费/免费] 与版本名', async () => {
  const { summarizeAccess } = require('../src/access');
  const mixed = summarizeAccess([FREE_ACCESS, PAID_ACCESS]);
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const rows = download.groupPlanRows([
      planItem('3008033', '3456657', 'MIX_V2', 'MOSS Image', FREE_ACCESS, 1024, mixed),
      planItem('3013038', '3426256', 'MOSS Image', 'MOSS Image', PAID_ACCESS, 2048, summarizeAccess([PAID_ACCESS])),
    ]);
    const pending = showPlanWorkspace({
      title: '下载收藏集',
      rows,
      selected: new Set(['3008033']),
      idOf: (row) => String(row.modelId),
    });
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('[付费/免费]'), text);
    assert.ok(text.includes('MIX_V2'), text);
    assert.ok(text.includes('[付费]'), text);
    key('escape');
    assert.equal(await pending, null);
  });
});

test('workspace: 多基础模型去重显示，b 筛选按包含匹配', async () => {
  const groups = download.groupPlanRows([
    planItem('3013038', '3426256', 'MOSS Image', 'MOSS Image', PAID_ACCESS, 10),
    planItem('3013038', '3419799', 'Krea2', 'Krea 2', PAID_ACCESS, 20),
  ]);
  assert.equal(groups.length, 1, '同一模型仍然只占一行');
  assert.deepEqual(groups[0].baseModels, ['MOSS Image', 'Krea 2']);
  assert.equal(groups[0].baseModel, 'MOSS Image / Krea 2');

  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '下载收藏集',
      rows: groups,
      selected: new Set(['3013038']),
      idOf: (row) => String(row.modelId),
    });
    await settle();
    key('b', 'b');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes(groups[0].name), `筛选第一个基础模型时该行仍在：\n${frame().join('\n')}`);
    key('b', 'b');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes(groups[0].name), `筛选第二个基础模型时该行仍在：\n${frame().join('\n')}`);
    key('escape');
    assert.equal(await pending, null);
  });
});

test('models: versionRows 按发布时间倒序，光标停在第一个已勾选版本', () => {
  const config = tempConfig();
  try {
    const detail = {
      id: 3007871,
      type: 'Checkpoint',
      modelVersions: [
        {
          id: 3449754,
          name: 'V4.1 25STEPS CFG3',
          baseModel: 'MOSS',
          publishedAt: '2026-11-04T08:54:00.000Z',
          files: [],
        },
        {
          id: 3449755,
          name: 'V4.1 25STEPS CFG3 BF16',
          baseModel: 'MOSS',
          publishedAt: '2026-11-04T09:01:00.000Z',
          paidAccess: { permanent: true, endsAt: null },
          files: [],
        },
        {
          id: 3435978,
          name: 'V3.3 25STEPS CFG3',
          baseModel: 'MOSS',
          publishedAt: '2026-10-29T00:00:00.000Z',
          files: [],
        },
      ],
    };
    const rows = models.versionRows(config, detail);
    assert.deepEqual(rows.map((row) => row.versionId), ['3449755', '3449754', '3435978']);
    assert.equal(rows[0].access.kind, 'paid', '第 0 行是发布时间最新的付费版');

    assert.equal(download.versionCursor(rows, []), 0, '未勾选 → 停在最新版本');
    assert.equal(download.versionCursor(rows, ['3435978']), 2, '已勾选 → 停在该行');
    assert.equal(download.versionCursor(rows, ['3435978', '3449754']), 1, '多个勾选 → 排序后第一个');
    assert.equal(download.versionCursor(rows, ['404']), 0, '勾选已不在列表 → 回到第一行');
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('models: 默认版本按 publishedAt 最大选取（乱序 / 并列比 createdAt / 再比 id）', () => {
  assert.equal(
    models.newestVersion([
      { id: 2, publishedAt: '2026-11-01T00:00:00.000Z' },
      { id: 3, publishedAt: '2026-11-04T09:01:00.000Z' },
      { id: 1, publishedAt: '2026-10-18T00:00:00.000Z' },
    ]).id,
    3
  );
  // Twin versions: equal publishedAt falls back to createdAt.
  // 孪生版本：发布时间相同时比 createdAt
  assert.equal(
    models.newestVersion([
      { id: 10, publishedAt: '2026-11-04T00:00:00.000Z', createdAt: '2026-11-03T00:00:00.000Z' },
      { id: 11, publishedAt: '2026-11-04T00:00:00.000Z', createdAt: '2026-11-04T00:00:00.000Z' },
    ]).id,
    11
  );
  // Equal timestamps fall back to the version id, where the larger id counts as newer.
  // 都相同时比版本 id（数值更大者视为更新）
  assert.equal(
    models.newestVersion([
      { id: 12, publishedAt: '2026-11-04T00:00:00.000Z' },
      { id: 9, publishedAt: '2026-11-04T00:00:00.000Z' },
    ]).id,
    12
  );
  // Versions without any timestamp sort last.
  // 完全没有时间戳的版本排在最后
  assert.equal(models.newestVersion([{ id: 1 }, { id: 2, publishedAt: '2026-01-01T00:00:00.000Z' }]).id, 2);
});

test('workspace: 清空与仅选未下载作用于筛选后的列表', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const pending = showPlanWorkspace({
      title: '批量选择',
      rows: [
        { modelId: '1', name: 'Alpha', downloaded: true },
        { modelId: '2', name: 'Beta', downloaded: false },
      ],
      selected: new Set(['1', '2']),
      idOf: (row) => row.modelId,
    });
    await settle();
    key('c', 'c');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('已选 0/2 项'), frame().join('\n'));
    key('n', 'n');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('已选 1/2 项'), frame().join('\n'));
    key('tab');
    key('return');
    const answer = await pending;
    assert.deepEqual(answer.rows.map((row) => row.modelId), ['2']);
  });
});

test('workspace: 收藏集批量默认不选付费项，显式单模型可选择', async () => {
  const plan = [
    {
      modelId: '1',
      name: 'Free model',
      versionId: '11',
      versionName: 'v1',
      files: [{ name: 'a.safetensors' }],
      totalBytes: 10,
      access: { kind: 'public', requiresEntitlement: false, defaultSelected: true },
    },
    {
      modelId: '2',
      name: 'Paid model',
      versionId: '21',
      versionName: 'v2',
      files: [{ name: 'b.safetensors' }],
      totalBytes: 20,
      access: { kind: 'paid', requiresEntitlement: true, defaultSelected: false },
    },
  ];
  // Every entry now follows one rule: the row's own default version decides the checkbox.
  // 现在所有入口同一条规则：勾不勾只看本行的默认版本。
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
    const page = download.runDownloadWorkspace(
      { fileTypes: ['Model'], jobs: 1, outDir: process.cwd() },
      {
        plan,
        entries: {},
        collectionId: 'test',
        name: 'Paid test',
        outDir: process.cwd(),
        jobs: 1,
      }
    );
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('[付费]'), text);
    assert.ok(text.includes(i18n.t('tui.access.warning', { count: 1 })), text);
    assert.ok(text.includes('已选 1/2 项'), text);
    key('escape');
    assert.equal(await page, 'download');
  });
});

test('workspace: 50 项溢出时确认按钮仍固定在列表下方', async () => {
  for (const size of [
    { columns: 80, rows: 24 },
    { columns: 54, rows: 12 },
  ]) {
    await withFakeTerminal(
      async ({ frame, key, settle }) => {
        assert.equal(screen.start({ onQuit: () => {} }), true);
        screen.setBase({ title: '主菜单', render: () => ['主菜单'], hints: () => [] });
        const rows = Array.from({ length: 50 }, (_, index) => ({
          modelId: String(index + 1),
          name: `模型 ${index + 1}`,
          detail: 'v1',
        }));
        const pending = showPlanWorkspace({
          title: '下载收藏集',
          rows,
          selected: new Set(rows.map((row) => row.modelId)),
          idOf: (row) => row.modelId,
          resolveInput: async () => [],
        });
        await settle();
        key('tab');
        await settle();
        screen.render();
        const lines = frame();
        const button = lines.findIndex((line) => line.includes(i18n.t('tui.workspace.next')));
        const first = lines.findIndex((line) => line.includes('模型 1'));
        assert.ok(button >= 0, `${size.columns}×${size.rows}: 确认按钮不可见\n${lines.join('\n')}`);
        assert.ok(first >= 0, `${size.columns}×${size.rows}: 第一个模型不可见\n${lines.join('\n')}`);
        assert.ok(button > first, `${size.columns}×${size.rows}: 按钮应位于列表之后\n${lines.join('\n')}`);
        key('escape');
        assert.equal(await pending, null);
      },
      size
    );
  }
});
