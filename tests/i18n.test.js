'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/i18n');
const zh = require('../src/i18n/zh-CN');
const en = require('../src/i18n/en');

test('i18n: 语言解析优先级 显式 > 自动 > 英文兜底', () => {
  const savedEnv = {
    CIVITAI_LANG: process.env.CIVITAI_LANG,
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
  };
  const savedIntl = Intl.DateTimeFormat;
  try {
    // 1) Explicit wins: an explicit zh must win over an English environment.
    // 1) 显式优先：即使环境是 en，显式 zh 也应生效
    process.env.CIVITAI_LANG = 'en-US';
    assert.deepEqual(i18n.resolveLanguage({ explicit: 'zh' }), { language: 'zh-CN', source: 'explicit' });
    assert.deepEqual(i18n.resolveLanguage({ explicit: 'en' }), { language: 'en', source: 'explicit' });
    assert.deepEqual(i18n.resolveLanguage({ explicit: 'fr' }), { language: 'en', source: 'auto' }, '无法识别的显式值应被忽略');

    // 2) Auto-detection: without an explicit value, the environment decides.
    // 2) 自动检测：没有显式值时读环境变量
    assert.deepEqual(i18n.resolveLanguage({}), { language: 'en', source: 'auto' });
    process.env.CIVITAI_LANG = 'zh_CN';
    assert.deepEqual(i18n.resolveLanguage({}), { language: 'zh-CN', source: 'auto' });

    // 3) English fallback: when no system language can be determined.
    // 3) 英文兜底：拿不到任何系统语言时
    delete process.env.CIVITAI_LANG;
    delete process.env.LC_ALL;
    delete process.env.LANG;
    Intl.DateTimeFormat = () => ({ resolvedOptions: () => ({ locale: 'fr-FR' }) });
    assert.deepEqual(i18n.resolveLanguage({}), { language: 'en', source: 'fallback' });
  } finally {
    Intl.DateTimeFormat = savedIntl;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    i18n.setLanguage('zh-CN');
  }
});

test('i18n: setLanguage(null) 交给自动解析', () => {
  const saved = process.env.CIVITAI_LANG;
  try {
    process.env.CIVITAI_LANG = 'zh-CN';
    assert.equal(i18n.setLanguage(null), 'zh-CN');
    assert.equal(i18n.getLanguage(), 'zh-CN');
  } finally {
    if (saved === undefined) delete process.env.CIVITAI_LANG;
    else process.env.CIVITAI_LANG = saved;
    i18n.setLanguage('zh-CN');
  }
});

test('i18n: 中文文案与旧版逐字一致', () => {
  i18n.setLanguage('zh-CN');
  assert.equal(i18n.getLanguage(), 'zh-CN');
  assert.equal(i18n.t('common.cancelled'), '已取消');
  assert.equal(i18n.t('common.yes'), '是');
});

test('i18n: normalizeLanguage 归一化各种写法', () => {
  assert.equal(i18n.normalizeLanguage('zh'), 'zh-CN');
  assert.equal(i18n.normalizeLanguage('ZH-cn'), 'zh-CN');
  assert.equal(i18n.normalizeLanguage('zh-Hans'), 'zh-CN');
  assert.equal(i18n.normalizeLanguage('en'), 'en');
  assert.equal(i18n.normalizeLanguage('en-US'), 'en');
  assert.equal(i18n.normalizeLanguage('  EN-gb  '), 'en');
  assert.equal(i18n.normalizeLanguage('fr'), null);
  assert.equal(i18n.normalizeLanguage(''), null);
  assert.equal(i18n.normalizeLanguage(undefined), null);
});

test('i18n: setLanguage 切换语言，未知语言交给自动解析', () => {
  assert.equal(i18n.setLanguage('en-US'), 'en');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.t('common.settingsSaved'), 'Settings saved');

  // An unknown language means "unspecified", so auto-resolution applies.
  // 未知语言等于「没指定」，应按自动解析（本机为中文，CI 上可能是英文）
  const auto = i18n.setLanguage('kl');
  assert.equal(auto, i18n.defaultLanguage(), '未知语言回退到自动解析结果');
  assert.equal(i18n.getLanguage(), auto);

  i18n.setLanguage('zh-CN');
  assert.equal(i18n.t('common.settingsSaved'), '设置已保存');
});

test('i18n: 占位符插值；缺失参数保留原样', () => {
  assert.equal(i18n.interpolate('{a}-{b}', { a: 1, b: 2 }), '1-2');
  assert.equal(i18n.interpolate('{a}-{b}', { a: 1 }), '1-{b}');
  assert.equal(i18n.interpolate('{a}', { a: 0 }), '0', '假值也要插值');
  assert.equal(i18n.interpolate('无占位符', { a: 1 }), '无占位符');
  i18n.setLanguage('zh-CN');
  assert.equal(i18n.t('common.seconds', { n: 5 }), '5 秒');
});

test('i18n: 未登记的键原样返回，便于定位遗漏', () => {
  assert.equal(i18n.t('does.not.exist'), 'does.not.exist');
  assert.equal(i18n.has('does.not.exist'), false);
  assert.equal(i18n.has('common.yes'), true);
});

test('i18n: 两个语言包的键集合一致（含 en 无缺翻）', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'en 与 zh-CN 的键必须一一对应');
  assert.deepEqual(i18n.missingKeys('en'), [], 'en 不允许缺翻');
  assert.deepEqual(i18n.missingKeys('zh-CN'), []);
  assert.deepEqual(i18n.availableLanguages().sort(), ['en', 'zh-CN']);
});

test('i18n: 文案不得为空字符串，且键名符合 <模块>.<场景> 形式', () => {
  for (const [key, value] of Object.entries({ ...zh, ...en })) {
    assert.equal(typeof value, 'string', `${key} 必须是字符串`);
    assert.ok(value.length > 0, `${key} 不能为空`);
    assert.match(key, /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/, `键名不规范: ${key}`);
  }
});

test('i18n: createTranslator 不依赖全局语言状态', () => {
  i18n.setLanguage('zh-CN');
  const toEn = i18n.createTranslator('en');
  assert.equal(toEn('common.yes'), 'Yes');
  assert.equal(i18n.t('common.yes'), '是', '全局语言不应被 createTranslator 改变');
  const unknown = i18n.createTranslator('xx');
  assert.equal(unknown('common.yes'), 'Yes', '未知语言使用英文兜底');
});
