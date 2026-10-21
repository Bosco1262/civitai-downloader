'use strict';

/**
 * Tests for the shared report page and the five pages built on it.
 *
 * The page is exercised on three levels: the pure line builder (facts, sections, clipping), the
 * shell page itself (cursor, Enter, Esc, footer) and one representative report per flow (model
 * detail, collection snapshot, check report, verify report, environment check).
 *
 *
 * 共享报告页与建立在它之上的五类页面的测试。
 *
 * 分三层演练：纯文本行构建（事实、分区、裁剪）、外壳页面本身（光标、Enter、Esc、页脚），
 * 以及每类流程各一个代表性报告（模型详情、收藏集快照、检查报告、校验报告、环境体检）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const i18n = require('../src/i18n');
const layout = require('../src/tui/layout');
const screen = require('../src/tui/screen');
const report = require('../src/tui/report');
const models = require('../src/tui/models');
const manage = require('../src/tui/manage');
const settings = require('../src/tui/settings');
const check = require('../src/tui/check');
const storage = require('../src/storage');

const LANGUAGE_AT_LOAD = i18n.getLanguage();
test.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

const { withFakeTerminal } = require('./helpers/tui');

/**
 * Temporary config + library used by the page tests.
 * 页面测试使用的临时配置与模型库。
 */
function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-report-'));
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: path.join(root, 'models'),
    dataDir: path.join(root, '.data'),
    configFile: path.join(root, 'config.json'),
    fileTypes: ['Model'],
    primaryOnly: true,
    jobs: 1,
    downloadAttempts: 1,
    metaConcurrency: 1,
    userAgent: 'test',
  };
  return config;
}

/**
 * One library entry with two versions, the newer one pinned.
 * 一条带两个版本的模型库记录，较新的版本已固定。
 */
function writeSampleLibrary(config) {
  storage.writeLibrary(config, {
    123: {
      name: 'Model X',
      type: 'LORA',
      baseModel: 'SDXL',
      pinnedVersionId: '2001',
      versions: {
        2001: {
          versionName: 'v2',
          baseModel: 'SDXL',
          dirName: 'Model-X',
          verifiedAt: '2026-10-01T10:00:00.000Z',
          files: [{ name: 'x-v2.safetensors', bytes: 2048 }],
        },
        2002: {
          versionName: 'v1',
          baseModel: 'SDXL',
          dirName: 'Model-X',
          verifiedAt: '2026-09-01T10:00:00.000Z',
          files: [{ name: 'x-v1.safetensors', bytes: 1024 }],
        },
      },
    },
  });
}

/**
 * Synthetic check report: one update, one file change and one failure.
 * 合成的检查报告：一条有更新、一条文件变化、一条失败。
 */
function checkReportFixture(kind = 'collection', id = '777') {
  const base = {
    kind,
    checkedAt: '2026-10-02T03:04:05.000Z',
    deepChecked: kind === 'model',
    corrupt: null,
    hasSnapshot: true,
    snapshotCount: 4,
    upToDate: [],
    upgraded: [],
    updated: [
      {
        item: { modelId: '1', name: 'Model A', versionName: 'v2', versionId: '20' },
        prev: { versionName: 'v1' },
      },
    ],
    pinned: [],
    fileChanged: [],
    missing: [],
    history: [],
    legacy: [],
    failed: [],
    removed: [],
    notDownloaded: [],
    stats: { total: 4, updated: 1, fileChanged: 0, missing: 0, notDownloaded: 0, removed: 0, failed: 0, problems: 1 },
  };
  if (kind === 'model') return { ...base, modelId: id, modelName: 'Model X' };
  return { ...base, collectionId: id };
}

// ---------------------------------------------------------------------------
// Pure line builder
// 纯文本行构建
// ---------------------------------------------------------------------------

test('report: 事实对齐、分区标题、空分区与窄宽降级', () => {
  const model = {
    title: 'Model X',
    summary: [
      { label: '类型', value: 'LORA' },
      { label: '目录', value: `D:\\models\\${'x'.repeat(80)}` },
    ],
    sections: [
      {
        title: '版本',
        rows: [{ label: 'v2', detail: '已下载', extra: '2026-10-01' }],
      },
      { title: '空分区', rows: [], emptyText: '（无）' },
    ],
    actions: [{ label: '检查更新', description: '对比线上版本' }],
  };

  const lines = report.reportLines(model, 100, 30);
  const text = lines.join('\n');
  assert.ok(text.includes('类型') && text.includes('LORA'), text);
  assert.ok(text.includes('版本'), text);
  assert.ok(text.includes('v2') && text.includes('已下载'), text);
  assert.ok(text.includes('2026-10-01'), text);
  assert.ok(text.includes('（无）'), text);
  assert.ok(text.includes('检查更新') && text.includes('对比线上版本'), text);
  // The section heading reaches the right edge and nothing overflows the width. Non-TTY output uses
  // the ASCII glyph set, so the rule is made of `-` there.
  //
  // 分区标题填到右边缘，且没有一行超出宽度。非 TTY 输出使用 ASCII 字符，因此横线是 `-`。
  assert.match(text, /(--|──) 版本 /, text);
  for (const line of lines) assert.ok(layout.displayWidth(line) <= 100, `行宽超限：${line}`);

  const narrow = report.reportLines(model, 60, 30);
  const narrowText = narrow.join('\n');
  assert.ok(narrowText.includes('已下载'), narrowText);
  assert.ok(!narrowText.includes('2026-10-01'), '窄终端去掉次要列');
  for (const line of narrow) assert.ok(layout.displayWidth(line) <= 60, `行宽超限：${line}`);

  assert.equal(report.reportLines(model, 100, 3).length, 3, '按行数截断');
});

test('report: 分区标题与它的第一行绑定', () => {
  const data = report.reportLayout(
    {
      summary: [],
      sections: [
        { title: 'A', rows: ['a1', 'a2'] },
        { title: 'B', rows: ['b1', 'b2'] },
      ],
      actions: [{ label: 'do' }],
    },
    80
  );
  const headingOfB = data.lines.findIndex((line) => line.includes(' B '));
  assert.ok(headingOfB > 0);
  const rowOfB = data.lines.findIndex((line) => line.trim() === 'b1');
  assert.equal(data.headingOfLine.get(rowOfB), headingOfB, '行必须知道自己的分区标题');
  assert.ok(data.headingLines.has(headingOfB));
});

// ---------------------------------------------------------------------------
// The page itself
// 页面本身
// ---------------------------------------------------------------------------

test('report: 页面显示事实/分区/操作，Enter 执行，Esc 返回', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    let runs = 0;
    const page = report.showReportPage({}, {
      title: '报告页',
      summary: [{ label: '类型', value: 'LORA' }],
      sections: [{ title: '版本', rows: ['v1', 'v2'] }],
      actions: [
        {
          label: '执行一次',
          description: '只用于测试',
          run: () => {
            runs++;
            return report.BACK;
          },
        },
      ],
    });
    await settle();
    screen.render();

    const text = frame().join('\n');
    assert.ok(text.includes('报告页'), text);
    assert.ok(text.includes('LORA'), text);
    assert.ok(text.includes('v1') && text.includes('v2'), text);
    assert.ok(text.includes('执行一次'), text);
    assert.equal(frame()[frame().length - 1].trim(), i18n.t('tui.hint.report'), '页脚只列本页的键');

    // Rows without `onEnter` are read-only, so the cursor starts on the first action.
    // 没有 `onEnter` 的行是只读的，因此光标从第一个操作开始。
    key('return');
    await settle();
    assert.equal(await page, null);
    assert.equal(runs, 1);

    const cancelled = report.showReportPage({}, {
      title: '可取消',
      summary: [],
      sections: [],
      actions: [{ label: '什么也不做' }],
    });
    await settle();
    key('escape');
    assert.equal(await cancelled, null, 'Esc 返回 null');

    // A nested flow may answer true/false (download submitted or cancelled); that must not close
    // the page — only the page's own `back` signal does.
    //
    // 嵌套流程可能返回 true/false（已提交下载或取消），这不应关闭页面——
    // 只有页面自己的 `back` 信号才会关闭。
    let kept = 0;
    const staying = report.showReportPage({}, {
      title: '留在本页',
      summary: [],
      sections: [],
      actions: [
        {
          label: '返回布尔值',
          run: () => {
            kept++;
            return true;
          },
        },
      ],
    });
    await settle();
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('留在本页'), '布尔返回值不应关闭页面');
    key('escape');
    assert.equal(await staying, null);
    assert.equal(kept, 1);
  });
});

test('report: 行按 Enter 交给分区的 onEnter，可在其中打开子菜单', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    let opened = null;
    const rows = [{ label: 'v1', detail: '已下载' }];
    const page = report.showReportPage({}, {
      title: '版本列表',
      summary: [],
      sections: [
        {
          title: '版本',
          rows,
          onEnter: async (row) => {
            opened = row;
            return report.BACK;
          },
        },
      ],
      actions: [{ label: '返回', run: () => report.BACK }],
    });
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('版本'), frame().join('\n'));

    key('return');
    await settle();
    assert.equal(opened, rows[0], 'onEnter 收到调用方传入的原始行');
    assert.equal(await page, null);
  });
});

test('report: 窄终端 60×16 不折行、不超出框架行数', async () => {
  await withFakeTerminal(
    async ({ frame, key }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const page = report.showReportPage({}, {
        title: '长报告',
        summary: [
          { label: '目录', value: `D:\\models\\${'x'.repeat(120)}` },
          { label: '类型', value: 'LORA' },
        ],
        sections: [
          {
            title: '版本',
            rows: Array.from({ length: 12 }, (_, index) => ({
              label: `版本 ${index}`,
              detail: '已下载',
              extra: '2026-10-01',
            })),
          },
        ],
        actions: [{ label: '返回', run: () => report.BACK }],
      });
      screen.render();
      const lines = frame();
      for (const line of lines) assert.ok(layout.displayWidth(line) <= 60, `行宽超限：${line}`);
      assert.ok(lines.length <= 16, `帧超过终端行数：${lines.length}`);

      // Closing the page keeps the test from leaking an open prompt into the next case.
      // 关掉页面，避免未结束的提问泄漏到下一个用例。
      key('escape');
      assert.equal(await page, null);
    },
    { columns: 60, rows: 16 }
  );
});

// ---------------------------------------------------------------------------
// Pages per flow
// 各流程页面
// ---------------------------------------------------------------------------

test('model detail: 进入模型即看到类型/版本/大小/固定/目录', async () => {
  const config = tempConfig();
  writeSampleLibrary(config);
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const page = models.modelActions(config, '123');
      await settle();
      screen.render();

      const text = frame().join('\n');
      assert.ok(text.includes('Model X'), text);
      assert.ok(text.includes('LORA'), text);
      assert.ok(text.includes('SDXL'), text);
      assert.ok(text.includes('v2') && text.includes('v1'), text);
      assert.ok(text.includes('2.00 KiB') || text.includes('3.00 KiB'), text);
      assert.ok(text.includes(i18n.t('tui.models.versionDownloaded')), text);
      assert.ok(text.includes(path.join(config.outDir, 'Model-X')), text);
      assert.ok(text.includes(i18n.t('tui.models.actionCheck')), text);

      // Enter on the version row opens its own menu.
      // 在版本行按 Enter 打开它自己的菜单。
      key('return');
      await settle();
      screen.render();
      const menu = frame().join('\n');
      assert.ok(menu.includes(i18n.t('tui.models.versionActionDownload')), menu);
      assert.ok(menu.includes(i18n.t('tui.models.versionPin')), menu);
      assert.ok(menu.includes(i18n.t('tui.models.versionActionOpenDir')), menu);

      key('escape');
      await settle();
      key('escape');
      assert.equal(await page, null);
    });
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('collection snapshot: 枚举时间/成员数/新增/移除/版本变化', async () => {
  const config = tempConfig();
  storage.writeCollection(config, '777', {
    fetchedAt: '2026-10-01T00:00:00.000Z',
    items: [{ modelId: '1', name: 'A', versionId: '10' }],
  });
  storage.writeCollection(config, '777', {
    fetchedAt: '2026-10-02T00:00:00.000Z',
    items: [
      { modelId: '1', name: 'A', versionId: '11' },
      { modelId: '2', name: 'B', versionId: '20' },
    ],
  });
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const page = manage.collectionActions(config, '777');
      await settle();
      screen.render();

      const text = frame().join('\n');
      assert.ok(text.includes(i18n.t('tui.manage.collectionLabel', { id: '777' })), text);
      assert.ok(text.includes('2026-10-02T00:00:00.000Z'), text);
      assert.ok(text.includes(i18n.t('tui.manage.snapshot.factMembers')), text);
      assert.ok(text.includes(i18n.t('tui.manage.snapshot.sectionAdded')), text);
      assert.ok(text.includes(i18n.t('tui.manage.snapshot.sectionRemoved')), text);
      assert.ok(text.includes(i18n.t('tui.manage.snapshot.sectionChanged')), text);
      assert.ok(text.includes('B'), text);
      assert.ok(text.includes('10 → 11'), text);

      // The action list scrolls with the page: End shows the last actions.
      // 操作列表随页面滚动：按 End 能看到最后几项操作。
      key('end');
      await settle();
      screen.render();
      const bottom = frame().join('\n');
      assert.ok(bottom.includes(i18n.t('tui.manage.resetChanged')), bottom);
      assert.ok(bottom.includes(i18n.t('tui.manage.membersAction')), bottom);

      key('escape');
      assert.equal(await page, null);
    });
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('check report: 统计与明细直接可见，0 项的分区被隐藏', () => {
  const config = tempConfig();
  try {
    const model = check.checkReportModel(config, {
      kind: 'model',
      modelId: '123',
      modelName: 'Model X',
      checkedAt: '2026-10-02T03:04:05.000Z',
      deepChecked: true,
      corrupt: null,
      hasState: true,
      upToDate: [],
      upgraded: [],
      updated: [{ item: { modelId: '123', name: 'Model X', versionName: 'v3', versionId: '2003' }, prev: { versionName: 'v2' } }],
      pinned: [],
      fileChanged: [],
      missing: [],
      history: [],
      legacy: [],
      failed: [],
      removed: [],
      notDownloaded: [],
      stats: { total: 3, updated: 1, fileChanged: 0, missing: 0, notDownloaded: 0, removed: 0, failed: 0, problems: 1 },
    });
    const text = report.reportLines(model, 100, 40).join('\n');
    assert.ok(text.includes(i18n.t('tui.check.report.factMode')), text);
    assert.ok(text.includes(i18n.t('tui.check.report.modeDeep')), text);
    assert.ok(text.includes('Model X'), text);
    assert.ok(text.includes(i18n.t('tui.check.report.sectionUpdated')), text);
    assert.ok(text.includes('v2 → v3'), text);
    // Empty buckets are dropped from the page (checked on the model, because the same wording is
    // also a summary fact label).
    //
    // 空桶不会出现在页面上（在模型上检查，因为同样的文字也是摘要标签）。
    const titles = model.sections.map((section) => section.title);
    assert.ok(!titles.includes(i18n.t('tui.check.report.sectionMissing')), '0 项的分区应隐藏');
    assert.ok(!titles.includes(i18n.t('tui.check.report.sectionFileChanged')), '0 项的分区应隐藏');
    assert.ok(text.includes(i18n.t('tui.check.report.actionDownload')), text);
    assert.ok(text.includes(i18n.t('tui.check.report.actionRecheck')), text);
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('check report: 多目标列表逐行显示成员/问题/变化', () => {
  const config = tempConfig();
  try {
    const makeReport = (id, updated) => ({
      kind: 'collection',
      collectionId: id,
      checkedAt: '2026-10-02T03:04:05.000Z',
      deepChecked: false,
      corrupt: null,
      hasSnapshot: true,
      snapshotCount: 4,
      upToDate: [],
      upgraded: [],
      updated: updated ? [{ item: { modelId: '1', name: 'A', versionName: 'v2', versionId: '20' }, prev: { versionName: 'v1' } }] : [],
      pinned: [],
      fileChanged: [],
      missing: [],
      history: [],
      legacy: [],
      failed: [],
      removed: [],
      notDownloaded: [],
      stats: { total: 4, updated: updated ? 1 : 0, fileChanged: 1, missing: 0, notDownloaded: 0, removed: 0, failed: 0, problems: updated ? 1 : 0 },
    });
    const model = check.checkReportsModel(config, [makeReport('100', true), makeReport('200', false)]);
    // The title lives in the breadcrumb; the body carries summary + rows.
    // 标题放在面包屑里；主体是摘要与行。
    assert.equal(model.title, i18n.t('tui.check.report.listTitle'));
    const text = report.reportLines(model, 100, 40).join('\n');
    assert.ok(text.includes(i18n.t('tui.check.report.factTargets')), text);
    assert.ok(text.includes('100') && text.includes('200'), text);
    assert.ok(text.includes('成员 4') || text.includes('members 4'), text);
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('check flow: 单目标直接进报告页，多目标列表可逐项进入', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);

    const single = check.showCheckReports({}, [checkReportFixture('model', '123')]);
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes(i18n.t('tui.check.report.titleModel', { name: 'Model X' })), text);
    assert.ok(text.includes(i18n.t('tui.app.menuModels')), text);
    assert.ok(text.includes(i18n.t('tui.check.report.factTotal')), text);
    assert.ok(text.includes(i18n.t('tui.check.report.sectionUpdated')), text);
    assert.ok(text.includes('v1 → v2'), text);
    key('escape');
    assert.equal(await single, null);

    const multi = check.showCheckReports({}, [
      checkReportFixture('collection', '100'),
      checkReportFixture('collection', '200'),
    ]);
    await settle();
    screen.render();
    const list = frame().join('\n');
    assert.ok(list.includes(i18n.t('tui.check.report.listTitle')), list);
    assert.ok(list.includes(i18n.t('tui.app.menuCollections')), list);
    assert.ok(list.includes(i18n.t('tui.check.report.factTargets')), list);
    assert.ok(list.includes('100') && list.includes('200'), list);

    // Enter opens the selected target's own report; Esc returns to the list.
    // Enter 打开所选目标自己的报告，Esc 回到列表。
    key('return');
    for (let index = 0; index < 6; index++) await settle();
    screen.render();
    assert.ok(frame().join('\n').includes(i18n.t('tui.check.report.titleCollection', { id: '100' })), frame().join('\n'));
    assert.ok(frame().join('\n').includes(i18n.t('tui.app.menuCollections')), frame().join('\n'));
    key('escape');
    await settle();
    key('escape');
    assert.equal(await multi, null);
  });
});

test('check report: 没有成员快照时说明原因并给出生成快照的动作', () => {
  const config = tempConfig();
  try {
    const report = {
      ...checkReportFixture('collection', '999'),
      hasSnapshot: false,
      snapshotCount: 0,
      stats: { total: 0, updated: 0, fileChanged: 0, missing: 0, notDownloaded: 0, removed: 0, failed: 0, problems: 0 },
    };
    const model = check.checkReportModel(config, report);
    const labels = model.summary.map((fact) => fact.label);
    assert.ok(labels.includes(i18n.t('tui.check.report.factSnapshot')), labels.join(' / '));
    const snapshotFact = model.summary.find((fact) => fact.label === i18n.t('tui.check.report.factSnapshot'));
    assert.equal(snapshotFact.value, i18n.t('tui.check.report.noSnapshot'));
    assert.ok(
      model.sections.some((section) => section.emptyText === i18n.t('tui.check.report.noSnapshotHint')),
      '应显示「还没有枚举」的说明'
    );
    assert.ok(
      model.actions.some((action) => action.label === i18n.t('tui.check.report.actionSnapshot')),
      '应提供生成快照的动作'
    );
    assert.ok(
      !model.sections.some((section) => section.emptyText === i18n.t('tui.check.report.allGood')),
      '不能显示“没有问题”'
    );

    const multi = check.checkReportsModel(config, [report]);
    const detail = multi.sections[0].rows[0].detail;
    assert.equal(detail, i18n.t('tui.check.report.noSnapshotShort'));

    // An enum that returned zero members is also "no result", but for a different reason.
    // 枚举成功但 0 个成员同样属于「无结果」，但原因不同。
    const empty = { ...report, hasSnapshot: true, snapshotCount: 0 };
    const emptyModel = check.checkReportModel(config, empty);
    const emptyFact = emptyModel.summary.find(
      (fact) => fact.label === i18n.t('tui.check.report.factSnapshot')
    );
    assert.equal(emptyFact.value, i18n.t('tui.check.report.emptySnapshot'));
    assert.ok(
      emptyModel.sections.some((section) => section.emptyText === i18n.t('tui.check.report.emptySnapshotHint')),
      '应说明上次枚举没有读到成员'
    );
    assert.ok(
      emptyModel.actions.some((action) => action.label === i18n.t('tui.check.report.actionSnapshotEmpty')),
      '应提供刷新快照的动作'
    );
    assert.equal(
      check.checkReportsModel(config, [empty]).sections[0].rows[0].detail,
      i18n.t('tui.check.report.emptySnapshotShort')
    );
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('verify report: 异常原因与目录可见，全部正常时给绿色提示', () => {
  const config = tempConfig();
  try {
    const broken = {
      label: '本地模型库',
      total: 2,
      versions: 3,
      totalBytes: 4096,
      corrupt: null,
      ok: [{ name: 'Model Y' }],
      broken: [
        {
          modelId: '123',
          versionId: '2001',
          versionName: 'v2',
          name: 'Model X',
          dir: 'D:\\models\\Model-X',
          reasons: ['大小不符', '缺少文件'],
          brokenFiles: [],
        },
      ],
    };
    const text = report.reportLines(models.verifyReportModel(config, broken, false), 100, 40).join('\n');
    assert.ok(text.includes(i18n.t('tui.verify.report.sectionBroken')), text);
    assert.ok(text.includes('Model X') && text.includes('2001'), text);
    assert.ok(text.includes('大小不符'), text);
    assert.ok(text.includes('D:\\models\\Model-X'), text);
    assert.ok(text.includes(i18n.t('tui.verify.report.actionRepair')), text);
    assert.ok(text.includes(i18n.t('tui.verify.report.actionDeep')), text);

    const clean = { ...broken, broken: [] };
    const cleanText = report.reportLines(models.verifyReportModel(config, clean, true), 100, 40).join('\n');
    assert.ok(cleanText.includes(i18n.t('tui.manage.verifyAllOk')), cleanText);
    assert.ok(!cleanText.includes(i18n.t('tui.verify.report.actionRepair')), '没有异常时不给修复动作');
    assert.ok(!cleanText.includes(i18n.t('tui.verify.report.actionDeep')), '深度校验后不再提供深度动作');
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('verify flow: 校验结束后直接进入报告页（不按 L）', async () => {
  const config = tempConfig();
  writeSampleLibrary(config);
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const flow = models.verifyFlow(config, { modelIds: ['123'] });
      await settle();
      // The first question is "hash the files?"; `n` keeps the fast size-only pass.
      // 第一个问题是「是否计算哈希」，按 n 走只比大小的快速校验。
      key('n', 'n');
      for (let index = 0; index < 12; index++) await settle();
      screen.render();

      const text = frame().join('\n');
      assert.ok(text.includes(i18n.t('tui.verify.report.title')), text);
      assert.ok(text.includes(i18n.t('tui.app.menuModels')), text);
      assert.ok(text.includes(i18n.t('tui.verify.report.sectionBroken')), text);
      assert.ok(text.includes('Model X'), text);
      assert.ok(text.includes(path.join(config.outDir, 'Model-X')), text);
      assert.ok(text.includes(i18n.t('tui.verify.report.actionRepair')), text);

      key('escape');
      await settle();
      await flow;
    });
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
});

test('doctor report: OK/WARN/FAIL 与 hint 可见', () => {
  const items = [
    { name: 'Node.js', status: 'ok', detail: 'v20', hint: null },
    { name: 'login', status: 'warn', detail: 'not logged in', hint: 'run the login flow' },
    { name: 'curl', status: 'fail', detail: 'missing', hint: 'install curl' },
  ];
  const doctor = settings.doctorReportModel(items, false);
  assert.deepEqual(doctor.crumbPath, [i18n.t('tui.app.menuSettings'), i18n.t('tui.doctor.report.title')]);
  const text = report.reportLines(doctor, 100, 40).join('\n');
  assert.ok(text.includes(i18n.t('doctor.tagOk')), text);
  assert.ok(text.includes(i18n.t('doctor.tagWarn')), text);
  assert.ok(text.includes(i18n.t('doctor.tagFail')), text);
  assert.ok(text.includes('run the login flow'), text);
  assert.ok(text.includes('install curl'), text);
  assert.ok(text.includes(i18n.t('tui.doctor.report.actionDeep')), text);
});

// ---------------------------------------------------------------------------
// Plain fallback
// 简易回退
// ---------------------------------------------------------------------------

test('report: 非外壳模式打印完整报告（事实/分区/操作）', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    await report.printReport({
      title: '打印报告',
      summary: [{ label: '类型', value: 'LORA' }],
      sections: [{ title: '版本', rows: [{ label: 'v2', detail: '已下载' }] }],
      actions: [],
    });
  } finally {
    console.log = original;
  }
  const text = lines.join('\n');
  assert.ok(text.includes('打印报告'), text);
  assert.ok(text.includes('LORA'), text);
  assert.ok(text.includes('版本') && text.includes('v2'), text);
});

test('report: 面包屑保留上级路径', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    const pending = report.showReportPage(
      { site: 'https://example.invalid', outDir: '/tmp', jobs: 1 },
      {
        title: '收藏集 161131',
        crumbPath: ['本地收藏集管理', '收藏集 161131'],
        summary: [],
        sections: [],
        actions: [],
        rebuild: null,
      }
    );
    await settle();
    screen.render();
    const crumb = frame().find((line) => line.includes('收藏集 161131'));
    assert.ok(crumb.includes('本地收藏集管理'), crumb);
    key('escape');
    await pending;
  });
});
