'use strict';

/**
 * Tests for the desired-state version selector.
 * 期望状态版本选择器的测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const screen = require('../src/tui/screen');
const { showVersionPage } = require('../src/tui/ui/versionPage');
const { showVersionSelectionPage } = require('../src/tui/ui/versionSelectionPage');
const { withFakeTerminal } = require('./helpers/tui');

test('versionSelectionPage: 默认全选、空格取消、Enter 返回保留集合', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionSelectionPage({
      title: 'Anima',
      versions: [
        { versionId: '1', name: 'v1', files: [{ name: 'a' }], totalBytes: 10 },
        { versionId: '2', name: 'v2', files: [{ name: 'b' }], totalBytes: 20 },
      ],
      selected: ['1', '2'],
      describe: () => 'downloaded',
    });
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('已保留 2/2 个版本'));
    key('down');
    key('space', ' ');
    await settle();
    key('return');
    const selected = await pending;
    assert.deepEqual([...selected], ['1']);
  });
});

test('versionPage: 多选模式支持空格勾选多个版本', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionPage(
      { name: 'Anima', type: 'LORA' },
      [
        { modelId: '1', name: 'v1', baseModel: 'SDXL', downloaded: true },
        { modelId: '2', name: 'v2', baseModel: 'SDXL', downloaded: false },
      ],
      0,
      () => 'downloaded',
      { multi: true, selected: ['1'] }
    );
    await settle();
    screen.render();
    const crumb = frame().find((line) => line.includes('主菜单'));
    assert.ok(!crumb.includes('下载'), crumb);
    assert.ok(crumb.includes('主菜单'), crumb);
    key('down');
    key('space', ' ');
    key('return');
    const selected = await pending;
    assert.deepEqual(selected, ['1', '2']);
  });
});

test('versionPage: 多选页未传 selected 时不自动勾选（回归自动补勾）', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionPage(
      { name: 'Anima', type: 'LORA' },
      [
        { modelId: '1', name: 'v1', baseModel: 'SDXL' },
        { modelId: '2', name: 'v2', baseModel: 'SDXL' },
      ],
      0,
      () => 'downloaded',
      { multi: true }
    );
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('已选 0/2'), text);
    assert.ok(!text.includes('[✓]'), `未传 selected 时不应有任何勾选：\n${text}`);
    key('return');
    assert.deepEqual(await pending, [], '全不勾 + Enter 应 settle 空数组');
  });
});

test('versionPage: 多选页全不勾 + Enter 应用空数组（不再提示未选择）', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionPage(
      { name: 'Anima', type: 'LORA' },
      [{ modelId: '1', name: 'v1', baseModel: 'SDXL' }],
      0,
      () => 'downloaded',
      { multi: true, selected: ['1'] }
    );
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('[✓]'), frame().join('\n'));
    key('space', ' ');
    await settle();
    screen.render();
    const cleared = frame().join('\n');
    assert.ok(!cleared.includes('[✓]'), cleared);
    key('return');
    assert.deepEqual(await pending, []);
  });
});

test('versionPage: 光标停在调用方给的位置，不被勾选状态改写', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionPage(
      { name: 'Anima', type: 'LORA' },
      [
        { modelId: '2', name: 'v2', baseModel: 'SDXL' },
        { modelId: '1', name: 'v1', baseModel: 'SDXL' },
      ],
      1,
      () => 'downloaded',
      { multi: true, selected: ['1'] }
    );
    await settle();
    screen.render();
    const lines = frame();
    const cursorRow = lines.find((line) => line.trimStart().startsWith('▸'));
    assert.ok(cursorRow, lines.join('\n'));
    assert.ok(cursorRow.includes('v1'), `光标应停在 initialCursor 指向的版本：\n${cursorRow}`);
    assert.ok(cursorRow.includes('[✓]'), cursorRow);
    assert.ok(lines.join('\n').includes('第 2 / 2 项'), lines.join('\n'));
    key('escape');
    assert.equal(await pending, null);
  });
});

test('versionPage: 描述里已有访问标签时不再追加徽标', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const access = { kind: 'paid', requiresEntitlement: true, defaultSelected: false };
    const pending = showVersionPage(
      { name: 'Anima', type: 'LORA' },
      [{ modelId: '1', name: 'v1', baseModel: 'SDXL', access }],
      0,
      () => `SDXL · 3.4 GB · ${require('../src/i18n').t('tui.access.paid')}`,
      { multi: true, selected: [] }
    );
    await settle();
    screen.render();
    const line = frame().find((text) => text.includes('v1'));
    const occurrences = line.split('付费').length - 1;
    assert.equal(occurrences, 1, `每行只应出现一次付费标签：\n${line}`);
    key('escape');
    assert.equal(await pending, null);
  });
});

test('versionSelectionPage: 固定版本不能取消', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    const pending = showVersionSelectionPage({
      title: 'Anima',
      versions: [{ versionId: '1', name: 'v1', files: [{ name: 'a' }], pinned: true }],
      selected: ['1'],
      describe: () => 'downloaded',
    });
    await settle();
    key('space', ' ');
    key('return');
    const selected = await pending;
    assert.deepEqual([...selected], ['1']);
  });
});
