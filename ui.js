#!/usr/bin/env node
'use strict';

// TUI entry point. A `--lang` / `-l` switch is turned into CIVITAI_LANG so the shared
// language resolver picks it up with explicit priority.
//
// 终端界面入口。`--lang` / `-l` 会被转成 CIVITAI_LANG，让共享的语言解析器按显式优先级采用。

const { t, extractLanguageArg } = require('./src/i18n');

const { lang } = extractLanguageArg(process.argv.slice(2));
if (lang) process.env.CIVITAI_LANG = lang;

require('./src/tui/app')
  .main()
  .catch((e) => {
    console.error(t('runtime.fatalError', { message: (e && e.message) || e }));
    if (process.env.DEBUG) console.error(e);
    process.exitCode = 1;
  });
