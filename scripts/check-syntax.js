'use strict';

// Parse every project JavaScript file without executing it, so a syntax error fails CI with a clear
// message. `vm.Script` only compiles the source, so no module is loaded and nothing runs.
//
// 逐个解析项目里的 JavaScript 文件，只编译不执行，让语法错误在 CI 里以清晰信息失败。
// `vm.Script` 只编译源码，不会加载模块，也不会产生任何副作用。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'tests', 'scripts'];
const SCAN_FILES = ['cli.js', 'ui.js'];

// Collect every .js file under a directory.
// 收集某个目录下的所有 .js 文件。
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
}

// Compile one file and return the error message, or null when it parses.
// 编译一个文件：出错返回错误信息，通过则返回 null。
function check(file) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    return null;
  } catch (e) {
    return e.message;
  }
}

function main() {
  const targets = [];
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), targets);
  for (const name of SCAN_FILES) targets.push(path.join(ROOT, name));
  const files = [...new Set(targets)].sort();

  if (!files.length) {
    console.error('没有找到任何 JavaScript 文件 / no JavaScript files found');
    process.exitCode = 1;
    return;
  }

  const failures = [];
  for (const file of files) {
    const message = check(file);
    if (message) failures.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), message });
  }

  if (failures.length) {
    for (const failure of failures) console.error(`✖ ${failure.file}\n  ${failure.message}`);
    console.error(`\n语法检查失败：${failures.length} / ${files.length} 个文件 / ${failures.length} of ${files.length} files failed`);
    process.exitCode = 1;
    return;
  }

  console.log(`语法检查通过：${files.length} 个文件 / syntax ok: ${files.length} files`);
}

main();
