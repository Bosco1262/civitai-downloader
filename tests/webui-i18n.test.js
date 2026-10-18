'use strict';

/**
 * i18n contract of the web UI.
 *
 * The browser only receives the `web.*` table through `/api/i18n`, so these keys are checked
 * separately from the CLI/TUI catalogs:
 *  1. both language tables define exactly the same keys, with no empty values;
 *  2. every key used by the frontend (and by the server-side actions/entry point) exists;
 *  3. no key is left unused (a stale string is a smell: either wire it or delete it);
 *  4. placeholders match between the two languages, so no `{name}` leaks or disappears;
 *  5. English carries no Chinese, except for the entries that are intentionally identical.
 *
 *
 * Web UI 的文案契约。
 *
 * 浏览器只通过 `/api/i18n` 拿到 `web.*` 表，因此这些键与 CLI/TUI 语言包分开校验：
 *  1) 两个语言表键集合完全一致，且没有空值；
 *  2) 前端（以及服务器端 actions / 入口）用到的键都存在；
 *  3) 没有未被使用的键（残留文案要么接线、要么删掉）；
 *  4) 两种语言的占位符一致，不会多出或丢掉 `{name}`；
 *  5) 英文不含中文，只有「刻意保持一致」的条目例外。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const zh = require('../src/i18n/web/zh-CN.json');
const en = require('../src/i18n/web/en.json');
const i18n = require('../src/i18n');

/**
 * Keys whose text is identical in both languages: language endonyms, layout preset names and
 * technical identifiers that must not be translated.
 *
 * 两种语言刻意相同的键：语言自称、布局预设名与不该翻译的技术标识。
 */
const SAME_IN_BOTH = new Set([
  'web.settings.languageZh',
  'web.settings.languageEn',
  'web.settings.layoutA1111',
  'web.settings.layoutComfy',
  'web.settings.userAgent',
]);

// CJK + full-width punctuation.
// 中日韩文字与全角标点。
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// Files that reference `web.*` keys.
// 会引用 `web.*` 的文件。
const SOURCES = [
  'src/webui/public/app.js',
  'src/webui/public/index.html',
  'src/webui/actions.js',
  'src/webui/server.js',
  'src/webui/api.js',
  'web.js',
];

// Keys built with template literals (help rows).
// 用模板字符串拼出来的键（帮助页）。
const TEMPLATED = ['download', 'library', 'check', 'verify', 'settings', 'login', 'web'].flatMap((name) => [
  `web.help.${name}Title`,
  `web.help.${name}Body`,
]);

// Every placeholder of a message, sorted (so order does not matter).
// 一条文案的全部占位符（排序）。
function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

test('webui-i18n: 两个语言表键集合一致、无空值、无缺翻', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, '中英键集合必须完全一致');
  assert.ok(zhKeys.length >= 250, `web.* 键数量偏少：${zhKeys.length}`);
  for (const key of zhKeys) {
    assert.match(key, /^web(\.[a-zA-Z][a-zA-Z0-9]*)+$/, `键名不规范: ${key}`);
    assert.ok(String(zh[key]).trim().length > 0, `zh 不能为空: ${key}`);
    assert.ok(String(en[key]).trim().length > 0, `en 不能为空: ${key}`);
    if (SAME_IN_BOTH.has(key)) continue;
    assert.notEqual(en[key], zh[key], `${key} 需要英文译文`);
    assert.ok(!CJK.test(en[key]), `${key} 的英文不应含中文：${en[key]}`);
  }
});

test('webui-i18n: 占位符在两种语言下一致', () => {
  for (const key of Object.keys(zh)) {
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `${key} 的占位符不一致`);
  }
});

test('webui-i18n: 前端与服务器引用的键都存在且没有残留键', () => {
  const root = path.join(__dirname, '..');
  const used = new Set(TEMPLATED);
  for (const rel of SOURCES) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(/'(web\.[a-zA-Z0-9_.]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/data-i18n(?:-title)?="(web\.[a-zA-Z0-9_.]+)"/g)) used.add(match[1]);
  }

  const missing = [...used].filter((key) => zh[key] === undefined).sort();
  assert.deepEqual(missing, [], '源码引用了未登记的 web.* 键');
  const unused = Object.keys(zh)
    .filter((key) => !used.has(key))
    .sort();
  assert.deepEqual(unused, [], '语言表中有未被引用的 web.* 键');
});

test('webui-i18n: t() 在两种语言下都能取到并替换占位符', () => {
  const previous = i18n.getLanguage();
  try {
    i18n.setLanguage('zh-CN');
    assert.equal(i18n.t('web.nav.dashboard'), '仪表盘');
    const zhText = i18n.t('web.dl.planTitle', { count: 3, size: '1.00 MiB' });
    assert.ok(zhText.includes('3') && zhText.includes('1.00 MiB'), zhText);

    i18n.setLanguage('en');
    assert.equal(i18n.t('web.nav.dashboard'), 'Dashboard');
    const enText = i18n.t('web.dl.planTitle', { count: 3, size: '1.00 MiB' });
    assert.ok(enText.includes('3') && enText.includes('1.00 MiB'), enText);
    assert.ok(!enText.includes('{'), `占位符没有替换干净：${enText}`);
  } finally {
    i18n.setLanguage(previous);
  }
});

test('webui-i18n: 语言切换立刻反映到 web.* 文案', () => {
  const previous = i18n.getLanguage();
  try {
    i18n.setLanguage('zh-CN');
    assert.equal(i18n.t('web.nav.library'), '模型库');
    i18n.setLanguage('en');
    assert.equal(i18n.t('web.nav.library'), 'Library');
    assert.equal(i18n.t('web.settings.languageZh'), '简体中文');
  } finally {
    i18n.setLanguage(previous);
  }
});
