'use strict';

/**
 * Test config factory: every test gets its own temp root, temp config.json and isolated paths.
 *
 * The developer's real config.json and .data directory are never read or written. Tests that
 * intentionally check invalid/missing config use `tempRoot()` + `writeRawConfig()` instead; this
 * factory only produces valid configurations.
 *
 *
 * 测试配置工厂：每个测试都有独立的临时 root、临时 config.json 与隔离路径。
 *
 * 绝不读写开发者真实的 config.json 与 .data 目录。专门测试非法/缺失配置的用例改用
 * `tempRoot()` + `writeRawConfig()`；本工厂只生成合法配置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../../src/config');
const i18n = require('../../src/i18n');

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY'];

/**
 * Remove a temp root, retrying briefly on Windows where files may still be locked.
 * 删除临时目录；Windows 上文件可能短暂占用，因此带重试。
 */
function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/**
 * Create a temp root and register its cleanup on the test context.
 * 建临时目录，并在测试上下文中登记清理。
 */
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-test-'));
  t.after(() => removeRoot(root));
  return root;
}

/**
 * Restore the process-wide i18n language and proxy env after the test.
 * 测试结束后恢复进程级 i18n 语言与代理环境变量。
 */
function restoreGlobalState(t) {
  const previousLanguage = i18n.getLanguage();
  const previousProxy = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));

  t.after(() => {
    i18n.setLanguage(previousLanguage);
    for (const key of PROXY_KEYS) {
      if (previousProxy[key] === undefined) delete process.env[key];
      else process.env[key] = previousProxy[key];
    }
  });
}

/**
 * Build one isolated, valid test config.
 *
 * `overrides` is written into the temp config.json before loadConfig(), so derived paths such as
 * profileDir are recomputed by production code instead of being patched by hand.
 *
 *
 * 生成一份独立、合法的测试配置。
 *
 * `overrides` 会先写入临时 config.json，再调用 loadConfig()，因此 profileDir 等派生路径由
 * 生产代码重新计算，而不是测试手工拼接。
 */
function testConfig(t, overrides = {}) {
  const root = tempRoot(t);
  const file = path.join(root, 'config.json');
  const seed = {
    language: 'zh-CN',
    outDir: root,
    trpcInput: {},
    ...overrides,
  };

  fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  const config = loadConfig({ root });

  restoreGlobalState(t);
  return config;
}

/**
 * Same as testConfig(), but for callbacks that do not receive a node:test context.
 * 与 testConfig() 相同，但用于拿不到 node:test 上下文的回调。
 */
async function withTestConfig(fn, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-test-'));
  const file = path.join(root, 'config.json');
  const seed = {
    language: 'zh-CN',
    outDir: root,
    trpcInput: {},
    ...overrides,
  };
  const previousLanguage = i18n.getLanguage();
  const previousProxy = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));

  try {
    fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    const config = loadConfig({ root });
    return await fn(config, { root, file });
  } finally {
    i18n.setLanguage(previousLanguage);
    for (const key of PROXY_KEYS) {
      if (previousProxy[key] === undefined) delete process.env[key];
      else process.env[key] = previousProxy[key];
    }
    removeRoot(root);
  }
}

/**
 * Write raw config content (a string is written verbatim, for invalid JSON cases).
 * 写入原始配置内容；字符串原样写入，用于构造非法 JSON。
 */
function writeRawConfig(root, value) {
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = {
  tempRoot,
  testConfig,
  withTestConfig,
  writeRawConfig,
};
