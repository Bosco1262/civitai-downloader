'use strict';

/**
 * Generate config.example.json from DEFAULTS, the single source of default values.
 *
 * Use --check in CI to fail when the checked-in example has drifted.
 *
 *
 * 从唯一默认值来源 DEFAULTS 生成 config.example.json。
 *
 * CI 中使用 --check，仓库里的示例与代码默认值不一致时直接失败。
 */

const fs = require('fs');
const path = require('path');

const { DEFAULTS } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'config.example.json');
const RENDERED = `${JSON.stringify(DEFAULTS, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== RENDERED) {
    console.error('config.example.json is out of sync with DEFAULTS; run npm run config:example.');
    console.error('config.example.json 与 DEFAULTS 不一致；请运行 npm run config:example。');
    process.exitCode = 1;
  } else {
    console.log('config.example.json matches DEFAULTS.');
    console.log('config.example.json 与 DEFAULTS 一致。');
  }
} else {
  fs.writeFileSync(TARGET, RENDERED, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, TARGET)}.`);
  console.log(`已写入 ${path.relative(ROOT, TARGET)}。`);
}
