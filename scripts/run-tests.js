'use strict';

/**
 * Minimal runner that executes every tests/*.test.js in order.
 *
 * Why not `node --test`: it forks a child process per test file and talks over pipes,
 * which fails outright in restricted environments (sandboxed sessions, for example).
 * Here every test file is required in the same process; node:test still runs and reports,
 * and the process exits non-zero when anything fails.
 *
 * In a normal environment `npm test` (node --test) and `npm run test:seq` (this file) are equivalent.
 *
 *
 * 顺序跑完 tests/*.test.js 的极简 runner。
 *
 * 为什么不用 `node --test`：它会为每个测试文件 fork 子进程并用管道通信，
 * 在某些受限环境（例如带沙箱的会话）里管道不可用会直接失败。
 * 这里在同一进程内 require 各测试文件，node:test 依旧会正常执行并统计，
 * 失败时进程退出码为 1。
 *
 * 正常环境下 `npm test`（node --test）与 `npm run test:seq`（本文件）等价。
 */

const fs = require('fs');
const path = require('path');

function main() {
  // Many assertions compare Chinese wording verbatim, so pin the language for reproducibility
  // (CI sets the same variable; an explicit value from the caller still wins).
  //
  // 不少断言逐字比对中文文案，这里把语言钉住以保证可复现（CI 也设置同一变量；调用方显式传入的仍优先）。
  process.env.CIVITAI_LANG = process.env.CIVITAI_LANG || 'zh-CN';

  const testsDir = path.resolve(__dirname, '..', 'tests');
  const files = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  if (!files.length) {
    console.error('没有找到任何测试文件（tests/*.test.js）');
    process.exitCode = 1;
    return;
  }

  console.log(`运行 ${files.length} 个测试文件（同一进程内顺序执行）\n`);
  for (const file of files) {
    console.log(`— ${file} —`);
    require(path.join(testsDir, file));
  }
}

main();
