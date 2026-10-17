#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./src/config');
const { parseArgs } = require('./src/util');

const COMMANDS = {
  login: () => require('./src/commands/login'),
  list: () => require('./src/commands/list'),
  download: () => require('./src/commands/download'),
};

function usage() {
  console.log(`civitai-collection-downloader

用法:
  node cli.js login                         打开浏览器完成登录并保存会话
  node cli.js list <收藏集ID> [--json] [--plan]
  node cli.js download <收藏集ID> [--out <目录>] [--only <id,id>] [--force] [--dry-run]

npm 用法（传参需要 -- 分隔）:
  npm run login
  npm run list -- 161131
  npm run download -- 161131
  npm run download -- 161131 --only 276011 --force
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exitCode = cmd ? 0 : 1;
    return;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    console.error(`未知命令: ${cmd}\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const args = parseArgs(rest);
  await loader().main(config, args);
}

main().catch((e) => {
  console.error(`错误: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
