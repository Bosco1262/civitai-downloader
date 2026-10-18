'use strict';

/**
 * Unit tests for src/config.js.
 * Run directly: node tests/config.test.js
 *
 * src/config.js 单元测试。
 * 直接运行：node tests/config.test.js
 * （本会话沙箱禁止管道/重定向，因此不使用 `node --test`。）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ROOT,
  DEFAULTS,
  CONFIG_VERSION,
  KNOWN_KEYS,
  loadConfig,
  validateConfig,
  resolveOutDir,
  saveConfig,
} = require('../src/config');
const { ConfigError } = require('../src/errors');

const tempDirs = [];

function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `civitai-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write config.json; a string value is written verbatim (used to build invalid JSON).
 * 写 config.json，value 为字符串时原样写入（用于构造非法 JSON）
 */
function writeConfig(root, value) {
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      // Cleanup failure does not affect the test verdict
      // 清理失败不影响测试结论
    }
  }
});

// ---------------------------------------------------------------------------
// Constant exports
// 常量导出
// ---------------------------------------------------------------------------

test('config: 常量导出（ROOT / DEFAULTS / CONFIG_VERSION / KNOWN_KEYS）', () => {
  assert.equal(ROOT, path.resolve(__dirname, '..'));
  assert.equal(CONFIG_VERSION, 1);
  assert.equal(DEFAULTS.configVersion, CONFIG_VERSION);
  assert.equal(DEFAULTS.site, 'https://civitai.red');
  assert.equal(DEFAULTS.outDir, 'downloads');
  assert.equal(DEFAULTS.profileDir, '.data/chrome-profile');
  assert.equal(DEFAULTS.debugPort, 9222);
  assert.equal(DEFAULTS.jobs, 1);
  assert.deepEqual([...KNOWN_KEYS].sort(), Object.keys(DEFAULTS).sort());
});

// ---------------------------------------------------------------------------
// 1. Defaults
// 1. 默认值
// ---------------------------------------------------------------------------

test('loadConfig: 无 config.json 时使用默认值，configExists 为 false', () => {
  const root = tempDir('config-default');
  const cfg = loadConfig({ root });

  assert.equal(cfg.configExists, false);
  assert.equal(cfg.configFile, path.join(root, 'config.json'));
  assert.equal(cfg.root, root);
  assert.equal(cfg.configVersion, CONFIG_VERSION);
  assert.equal(cfg.site, 'https://civitai.red');
  assert.equal(cfg.debugPort, DEFAULTS.debugPort);
  assert.equal(cfg.jobs, DEFAULTS.jobs);
  assert.equal(cfg.proxy, '');
  assert.equal(cfg.outDir, path.join(root, 'downloads'));
  assert.equal(cfg.profileDirBase, path.join(root, '.data', 'chrome-profile'));
  assert.equal(cfg.profileDir, path.join(root, '.data', 'chrome-profile', 'civitai.red'));
  assert.equal(cfg.profileDirExplicit, false, '未显式配置时按站点隔离');
  assert.equal(cfg.dataDir, path.join(root, '.data'));
  assert.equal(cfg.cookiesFile, path.join(root, '.data', 'cookies.txt'));
  assert.deepEqual(cfg.warnings, []);
});

test('loadConfig: 空文件与纯空白文件都回落到默认值', () => {
  const root = tempDir('config-empty');
  const file = writeConfig(root, '');

  const cfg = loadConfig({ root });
  assert.equal(cfg.configExists, true);
  assert.equal(cfg.site, DEFAULTS.site);
  assert.equal(cfg.outDir, path.join(root, 'downloads'));
  assert.deepEqual(cfg.warnings, []);

  writeConfig(root, '  \n\t  ');
  const cfg2 = loadConfig({ root });
  assert.equal(cfg2.configExists, true);
  assert.equal(cfg2.outDir, path.join(root, 'downloads'));
  assert.deepEqual(cfg2.warnings, []);
  assert.ok(fs.existsSync(file));
});

// ---------------------------------------------------------------------------
// 2/3. Directory resolution
// 2/3. 目录解析
// ---------------------------------------------------------------------------

test('loadConfig: 相对 outDir/profileDir 相对 root 解析（与 process.cwd 无关）', () => {
  const root = tempDir('config-rel');
  writeConfig(root, { outDir: 'downloads', profileDir: 'profiles/me' });

  const cfg = loadConfig({ root });
  assert.ok(path.isAbsolute(cfg.outDir), 'outDir 必须是绝对路径');
  assert.equal(cfg.outDir, path.resolve(root, 'downloads'));
  assert.equal(cfg.outDir, path.join(root, 'downloads'));
  assert.equal(path.dirname(cfg.outDir), root);
  assert.equal(cfg.profileDir, path.join(root, 'profiles', 'me'));
  assert.notEqual(cfg.outDir, path.resolve(process.cwd(), 'downloads'), '不能相对进程 cwd 解析');

  // A parent-relative path is likewise resolved against root
  // 上一级相对路径同样相对 root
  writeConfig(root, { outDir: '../shared-models' });
  assert.equal(loadConfig({ root }).outDir, path.resolve(root, '..', 'shared-models'));
});

test('loadConfig: 绝对 outDir/profileDir 原样保留', () => {
  const root = tempDir('config-abs');
  const target = tempDir('config-out');
  writeConfig(root, { outDir: target, profileDir: path.join(target, 'chrome-profile') });

  const cfg = loadConfig({ root });
  assert.ok(path.isAbsolute(cfg.outDir));
  assert.equal(cfg.outDir, path.normalize(target));
  assert.equal(cfg.profileDir, path.join(target, 'chrome-profile'));
  assert.equal(cfg.configExists, true);
});

// ---------------------------------------------------------------------------
// 4. Unknown keys
// 4. 未知键
// ---------------------------------------------------------------------------

test('loadConfig: 未知配置项不抛错，只进入非枚举的 warnings', () => {
  const root = tempDir('config-unknown');
  writeConfig(root, { site: 'https://civitai.red', totallyUnknown: 42 });

  let cfg;
  assert.doesNotThrow(() => {
    cfg = loadConfig({ root });
  });

  assert.ok(Array.isArray(cfg.warnings));
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /totallyUnknown/);
  assert.match(cfg.warnings[0], /未知配置项/);

  assert.equal(Object.keys(cfg).includes('warnings'), false, 'warnings 不应可枚举');
  assert.equal(Object.getOwnPropertyDescriptor(cfg, 'warnings').enumerable, false);
  assert.equal(JSON.stringify(cfg).includes('warnings'), false);
  // The current implementation does not delete unknown keys (it only warns)
  // 当前实现不会删除未知键（仅提示）
  assert.equal(cfg.totallyUnknown, 42);
});

test('validateConfig: 未知键写入传入的 warnings 数组', () => {
  const warnings = [];
  const cfg = validateConfig({ ...DEFAULTS, anotherUnknown: 'x' }, { warnings });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /anotherUnknown/);
  assert.equal(cfg.anotherUnknown, 'x');

  // Passing no warnings array must not throw either
  // 不传 warnings 也不应抛错
  assert.doesNotThrow(() => validateConfig({ ...DEFAULTS, yetAnother: 1 }));
});

// ---------------------------------------------------------------------------
// 5. site
// 5. 站点
// ---------------------------------------------------------------------------

test('loadConfig: site 去掉尾部斜杠，缺协议抛 ConfigError', () => {
  const root = tempDir('config-site');

  writeConfig(root, { site: 'https://civitai.red///' });
  assert.equal(loadConfig({ root }).site, 'https://civitai.red');

  writeConfig(root, { site: '  http://civitai.red/  ' });
  assert.equal(loadConfig({ root }).site, 'http://civitai.red');

  writeConfig(root, { site: 'civitai.red' });
  assert.throws(
    () => loadConfig({ root }),
    (e) => {
      assert.ok(e instanceof ConfigError, '应为 ConfigError');
      assert.equal(e.code, 'ConfigError');
      assert.match(e.message, /site/);
      return true;
    },
    '缺少协议应抛 ConfigError'
  );
});

test('validateConfig: site 必须匹配 http(s)://', () => {
  assert.equal(validateConfig({ ...DEFAULTS, site: 'https://civitai.red' }).site, 'https://civitai.red');
  assert.equal(validateConfig({ ...DEFAULTS, site: 'HTTP://CIVITAI.RED' }).site, 'HTTP://CIVITAI.RED');
  for (const bad of ['civitai.red', 'ftp://civitai.red', '//civitai.red', 'https:/civitai.red', 'http://']) {
    assert.throws(() => validateConfig({ ...DEFAULTS, site: bad }), ConfigError, `site=${bad} 应抛错`);
  }
});

// ---------------------------------------------------------------------------
// 6. debugPort / jobs
// 6. debugPort / jobs（调试端口与并发数）
// ---------------------------------------------------------------------------

test('validateConfig: debugPort 必须是 1-65535 的整数', () => {
  for (const bad of [0, 70000, -1, 'abc', 1.5, NaN, Infinity]) {
    assert.throws(() => validateConfig({ ...DEFAULTS, debugPort: bad }), ConfigError, `debugPort=${String(bad)} 应抛错`);
  }

  assert.equal(validateConfig({ ...DEFAULTS, debugPort: 1 }).debugPort, 1);
  assert.equal(validateConfig({ ...DEFAULTS, debugPort: 65535 }).debugPort, 65535);
  assert.equal(validateConfig({ ...DEFAULTS, debugPort: '9223' }).debugPort, 9223, '数字字符串会被转换');
  assert.equal(validateConfig({ ...DEFAULTS, debugPort: '' }).debugPort, DEFAULTS.debugPort, '空值回落默认');
  assert.equal(validateConfig({ ...DEFAULTS, debugPort: null }).debugPort, DEFAULTS.debugPort);
});

test('validateConfig: jobs 必须是 1-8 的整数', () => {
  for (const bad of [0, 9, -1, 'abc', 2.5, NaN]) {
    assert.throws(() => validateConfig({ ...DEFAULTS, jobs: bad }), ConfigError, `jobs=${String(bad)} 应抛错`);
  }

  assert.equal(validateConfig({ ...DEFAULTS, jobs: 1 }).jobs, 1);
  assert.equal(validateConfig({ ...DEFAULTS, jobs: 8 }).jobs, 8);
  assert.equal(validateConfig({ ...DEFAULTS, jobs: '4' }).jobs, 4);
  assert.equal(validateConfig({ ...DEFAULTS, jobs: '' }).jobs, DEFAULTS.jobs);
});

test('loadConfig: config.json 中的非法 debugPort/jobs 同样抛 ConfigError', () => {
  const root = tempDir('config-int');
  writeConfig(root, { debugPort: 0 });
  assert.throws(() => loadConfig({ root }), ConfigError);

  writeConfig(root, { jobs: 9 });
  assert.throws(() => loadConfig({ root }), ConfigError);

  writeConfig(root, { jobs: 4, debugPort: 9222 });
  const cfg = loadConfig({ root });
  assert.equal(cfg.jobs, 4);
  assert.equal(cfg.debugPort, 9222);
});

// ---------------------------------------------------------------------------
// 7. proxy
// 7. 代理
// ---------------------------------------------------------------------------

test('validateConfig: proxy 合法值通过、非法值抛错', () => {
  const good = [
    '',
    'http://127.0.0.1:7890',
    'https://proxy.local:8443',
    'socks://127.0.0.1:1080',
    'socks4://127.0.0.1:1080',
    'socks5://127.0.0.1:1080',
  ];
  for (const value of good) {
    assert.equal(validateConfig({ ...DEFAULTS, proxy: value }).proxy, value, `proxy=${value} 应通过`);
  }
  // Whitespace on both sides is trimmed; an empty string means "no proxy"
  // 两端空白会被 trim，空串等价于「不使用代理」
  assert.equal(validateConfig({ ...DEFAULTS, proxy: '  http://127.0.0.1:7890  ' }).proxy, 'http://127.0.0.1:7890');
  assert.equal(validateConfig({ ...DEFAULTS, proxy: '   ' }).proxy, '');

  const bad = ['127.0.0.1:7890', 'ftp://127.0.0.1:21', 'socks5:/127.0.0.1:1080', 'http://', 'http:/127.0.0.1', 'proxy'];
  for (const value of bad) {
    assert.throws(() => validateConfig({ ...DEFAULTS, proxy: value }), ConfigError, `proxy=${value} 应抛错`);
  }
});

// ---------------------------------------------------------------------------
// Required strings
// 必填字符串
// ---------------------------------------------------------------------------

test('validateConfig: 必填字符串为空抛 ConfigError', () => {
  for (const key of ['site', 'outDir', 'profileDir', 'userAgent']) {
    assert.throws(
      () => validateConfig({ ...DEFAULTS, [key]: '' }),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, new RegExp(key));
        return true;
      },
      `${key} 为空应抛 ConfigError`
    );
  }
  assert.throws(() => validateConfig({ ...DEFAULTS, outDir: '   ' }), ConfigError, '纯空白同样是空');
  assert.throws(() => validateConfig({}), ConfigError, '缺少必填项应抛错');

  // chromePath is optional
  // chromePath 非必填
  assert.equal(validateConfig({ ...DEFAULTS, chromePath: '' }).chromePath, '');
  assert.equal(validateConfig({ ...DEFAULTS, chromePath: ' C:/chrome.exe ' }).chromePath, 'C:/chrome.exe');
});

// ---------------------------------------------------------------------------
// 8. Invalid JSON
// 8. 非法 JSON
// ---------------------------------------------------------------------------

test('loadConfig: JSON 非法抛 ConfigError', () => {
  const root = tempDir('config-badjson');
  writeConfig(root, '{"site": "https://civitai.red",');

  assert.throws(
    () => loadConfig({ root }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /解析失败/);
      return true;
    },
    '截断的 JSON 应抛 ConfigError'
  );

  writeConfig(root, 'not json at all');
  assert.throws(() => loadConfig({ root }), ConfigError);
});

test('loadConfig: 顶层不是对象抛 ConfigError', () => {
  const root = tempDir('config-badtop');

  writeConfig(root, [1, 2, 3]);
  assert.throws(
    () => loadConfig({ root }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /顶层必须是一个对象/);
      return true;
    },
    '数组应抛 ConfigError'
  );

  for (const raw of ['null', '42', '"text"', 'true']) {
    writeConfig(root, raw);
    assert.throws(() => loadConfig({ root }), ConfigError, `顶层 ${raw} 应抛 ConfigError`);
  }
});

// ---------------------------------------------------------------------------
// 9. saveConfig
// 9. saveConfig（保存配置）
// ---------------------------------------------------------------------------

test('saveConfig: 保留已有未知字段并补上 configVersion，可被 loadConfig 读回', () => {
  const root = tempDir('config-save');
  const file = writeConfig(root, { site: 'https://civitai.red', myCustom: 'keep-me', nested: { a: 1 } });

  const cfg = loadConfig({ root });
  assert.ok(cfg.warnings.some((w) => w.includes('myCustom')), '前置条件：未知键产生 warning');

  const merged = saveConfig(cfg, { jobs: 4 });
  assert.equal(merged.configVersion, CONFIG_VERSION);
  assert.equal(merged.myCustom, 'keep-me');
  assert.equal(merged.nested.a, 1);
  assert.equal(merged.jobs, 4);
  assert.equal(merged.site, 'https://civitai.red');

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), '写回的文件以换行结尾');
  const raw = JSON.parse(text);
  assert.equal(raw.configVersion, CONFIG_VERSION);
  assert.equal(raw.jobs, 4);
  assert.equal(raw.myCustom, 'keep-me');
  assert.deepEqual(raw.nested, { a: 1 });

  const back = loadConfig({ root });
  assert.equal(back.jobs, 4);
  assert.equal(back.myCustom, 'keep-me');
  assert.equal(back.configExists, true);
  assert.equal(back.outDir, path.join(root, 'downloads'));

  // Write once more: the patch overwrites same-named keys and unknown keys remain
  // 再写一次：patch 覆盖同名键，未知键仍在
  const merged2 = saveConfig(back, { myCustom: 'changed', jobs: 8 });
  assert.equal(merged2.myCustom, 'changed');
  const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw2.myCustom, 'changed');
  assert.equal(raw2.jobs, 8);
  assert.equal(raw2.configVersion, CONFIG_VERSION);
  assert.equal(loadConfig({ root }).myCustom, 'changed');
});

test('saveConfig: 目标目录不存在时自动创建；现有文件损坏时可覆盖恢复', () => {
  const root = tempDir('config-save-mkdir');
  const nested = path.join(root, 'nested', 'deep', 'config.json');

  const merged = saveConfig({ configFile: nested }, { jobs: 3 });
  assert.equal(merged.configVersion, CONFIG_VERSION);
  assert.ok(fs.existsSync(nested), '应创建父目录并写入文件');
  assert.equal(JSON.parse(fs.readFileSync(nested, 'utf8')).jobs, 3);

  const broken = writeConfig(root, '{ 坏掉的 json');
  const fixed = saveConfig({ configFile: broken }, { jobs: 2 });
  assert.equal(fixed.jobs, 2);
  assert.equal(JSON.parse(fs.readFileSync(broken, 'utf8')).jobs, 2);
});

// ---------------------------------------------------------------------------
// 10. resolveOutDir
// 10. resolveOutDir（解析输出目录）
// ---------------------------------------------------------------------------

test('resolveOutDir: 相对 root 解析；空字符串回退 config.outDir', () => {
  const root = tempDir('config-resolve');
  const cfg = loadConfig({ root });

  assert.equal(resolveOutDir(cfg, 'sub'), path.join(root, 'sub'));
  assert.equal(resolveOutDir(cfg, 'a/b'), path.join(root, 'a', 'b'));
  assert.equal(resolveOutDir(cfg, 'sub'), path.resolve(root, 'sub'));
  assert.equal(path.isAbsolute(resolveOutDir(cfg, 'sub')), true);

  assert.equal(resolveOutDir(cfg, ''), cfg.outDir, '空串回退 outDir');
  assert.equal(resolveOutDir(cfg, undefined), cfg.outDir);
  assert.equal(resolveOutDir(cfg), cfg.outDir);

  const abs = path.join(root, 'elsewhere');
  assert.equal(resolveOutDir(cfg, abs), abs, '绝对路径原样保留');
});

test('resolveOutDir: config.root 缺失时回退项目根 ROOT', () => {
  assert.equal(resolveOutDir({ outDir: 'downloads' }, 'sub'), path.join(ROOT, 'sub'));
  assert.equal(resolveOutDir({ outDir: 'downloads' }), path.join(ROOT, 'downloads'));
  assert.equal(resolveOutDir({ outDir: 'downloads' }, ''), path.join(ROOT, 'downloads'));
});
