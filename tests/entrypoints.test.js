'use strict';

/**
 * Entry-point contract: the two UI start commands and the files they point at.
 *
 * `npm run tui` and `npm run webui` are the documented way in, so they are pinned here: renaming a
 * script or deleting an entry file must fail a test rather than a user's terminal.
 *
 *
 * 入口契约：两个界面的启动命令及它们指向的文件。
 *
 * `npm run tui` 与 `npm run webui` 是文档里给出的启动方式，因此在这里固定下来：
 * 以后重命名脚本或删掉入口文件时，应该是测试失败，而不是用户的终端里报错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const i18n = require('../src/i18n');

/**
 * Language at load time; restored after each test that switches languages.
 * 载入时的语言；切换语言的测试结束后恢复。
 */
const LANGUAGE_AT_LOAD = i18n.getLanguage();

test.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

test('entrypoints: npm run tui / npm run webui 指向存在且可读的入口文件', () => {
  assert.equal(pkg.scripts.tui, 'node ui.js', 'npm run tui 应启动终端界面');
  assert.equal(pkg.scripts.webui, 'node web.js', 'npm run webui 应启动 Web 界面');

  for (const file of ['ui.js', 'web.js', 'cli.js']) {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${file} 必须存在`);
    assert.ok(fs.statSync(full).size > 0, `${file} 不能为空`);
  }
});

test('entrypoints: 不再保留旧的启动命令别名', () => {
  // The rename is intentional: `ui` / `web` now only mean other things, so the old names are gone.
  // 改名是有意为之：`ui` / `web` 不再作为启动命令，因此旧名字不应残留。
  assert.equal(pkg.scripts.ui, undefined, '旧的 npm run ui 应已移除');
  assert.equal(pkg.scripts.web, undefined, '旧的 npm run web 应已移除');
});

test('entrypoints: 帮助文本写出两个启动命令（中英一致）', () => {
  const previous = i18n.getLanguage();
  try {
    for (const lang of ['zh-CN', 'en']) {
      i18n.setLanguage(lang);
      const usage = i18n.t('cli.usage');
      assert.ok(usage.includes('npm run tui'), `${lang}: cli.usage 应列出 npm run tui`);
      assert.ok(usage.includes('npm run webui'), `${lang}: cli.usage 应列出 npm run webui`);
      const webUsage = i18n.t('web.usage');
      assert.ok(webUsage.includes('npm run webui'), `${lang}: web.usage 应列出 npm run webui`);
      assert.ok(webUsage.includes('npm run tui'), `${lang}: web.usage 应提到 npm run tui`);
    }
  } finally {
    i18n.setLanguage(previous);
  }
});
