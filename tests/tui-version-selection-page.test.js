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
