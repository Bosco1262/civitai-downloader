#!/usr/bin/env node
'use strict';

/**
 * Web UI entry point.
 *
 * Starts the local server and prints the URL. The browser is opened unless `--no-open` is given;
 * the TUI (`npm run ui`) and the CLI (`node cli.js …`) keep working unchanged — this entry only adds
 * a third way in, sharing the same config, session and model library.
 *
 *
 * Web UI 入口。
 *
 * 启动本地服务器并打印 URL。除非指定 `--no-open`，否则自动打开浏览器；
 * TUI（`npm run ui`）与命令行（`node cli.js …`）保持不变——这个入口只是第三条路径，
 * 与它们共用同一份配置、登录态和模型库。参数说明见 `node web.js --help`。
 */

const { exec } = require('child_process');

const { t, extractLanguageArg } = require('./src/i18n');
const { loadConfig } = require('./src/config');
const { createWebServer, DEFAULT_HOST, DEFAULT_PORT } = require('./src/webui/server');

/**
 * Parse `--flag value` / `--flag=value` / `-p value` arguments.
 * 解析 `--flag value` / `--flag=value` / `-p value` 形式的参数。
 */
function parseArgs(argv) {
  const out = { port: null, host: null, open: true, lang: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const take = (name) => {
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('-')) {
        i++;
        return String(next);
      }
      return null;
    };
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--no-open') {
      out.open = false;
      continue;
    }
    if (arg === '--open') {
      out.open = true;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      out.port = take('port');
      continue;
    }
    if (arg.startsWith('--port=')) {
      out.port = arg.slice('--port='.length);
      continue;
    }
    if (arg === '--host') {
      out.host = take('host');
      continue;
    }
    if (arg.startsWith('--host=')) {
      out.host = arg.slice('--host='.length);
      continue;
    }
  }
  return out;
}

/**
 * Open the URL in the default browser (best effort: a headless box may not have one).
 * 用默认浏览器打开 URL（尽力而为：无头环境可能没有浏览器）。
 */
function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  try {
    exec(command, { windowsHide: true }, () => {});
  } catch (e) {
    // Opening a browser is a convenience, never a requirement.
    // 打开浏览器只是便利，不是必需。
  }
}

/**
 * Listen, retrying the next ports when the default one is taken.
 * 监听端口；默认端口被占用时顺延尝试。
 */
async function listenWithFallback(wrapper, host, port, attempts = 10) {
  if (Number.isFinite(port) && port > 0) {
    const first = await wrapper.start({ host, port }).catch((error) => ({ error }));
    if (!first.error) return first;
    if (first.error.code !== 'EADDRINUSE') throw first.error;
  }
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = (Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT) + offset;
    const result = await wrapper.start({ host, port: candidate }).catch((error) => ({ error }));
    if (!result.error) return result;
    if (result.error.code !== 'EADDRINUSE') throw result.error;
  }
  throw new Error(t('web.error.noFreePort', { port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(t('web.usage'));
    return;
  }

  // The language switch is shared with the CLI/TUI: write it before the config is loaded so the
  // message catalog and the UI both use it.
  //
  // 语言开关与 CLI/TUI 共用：在加载配置前写入，文案表与界面都会采用。
  const fromArgv = extractLanguageArg(process.argv.slice(2));
  if (fromArgv.lang) process.env.CIVITAI_LANG = fromArgv.lang;

  const config = loadConfig();
  const wrapper = createWebServer({ config });
  const host = args.host || DEFAULT_HOST;
  const port = args.port === null ? DEFAULT_PORT : Number(args.port);
  if (args.port !== null && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
    console.error(t('web.error.badPort', { value: args.port }));
    process.exitCode = 1;
    return;
  }

  const started = await listenWithFallback(wrapper, host, port);
  console.log('');
  console.log(`  ${t('web.bannerTitle')}`);
  console.log(`  ${t('web.bannerUrl', { url: started.url })}`);
  console.log(`  ${t('web.bannerConfig', { file: config.configFile || 'config.json' })}`);
  console.log(`  ${t('web.bannerStop')}`);
  console.log('');

  if (args.open) openBrowser(started.url);

  const shutdown = async () => {
    await wrapper.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when executed directly: tests import `parseArgs` from this file without starting a server.
// 仅直接运行时启动：测试只导入 `parseArgs`，不应拉起服务器。
if (require.main === module) {
  main().catch((error) => {
    console.error(t('web.error.fatal', { message: (error && error.message) || String(error) }));
    if (process.env.DEBUG) console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, openBrowser };
