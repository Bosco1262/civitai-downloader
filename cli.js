#!/usr/bin/env node
'use strict';

// CLI entry point: dispatch a subcommand, resolve the UI language, then hand over to the command module.
// 命令行入口：分发子命令、解析界面语言，然后交给命令模块执行。

const { loadConfig } = require('./src/config');
const { parseArgs } = require('./src/util');
const { configureRuntime, printConfigWarnings, handleFatal } = require('./src/runtime');
const { COMMANDS, loadCommand } = require('./src/commandSpec');
const { t, extractLanguageArg, setLanguage } = require('./src/i18n');

function usage() {
  console.log(t('cli.usage'));
}

async function main() {
  // `-l` / `--lang` / `--language` are global switches, so pull them out before parsing the rest.
  // `-l` / `--lang` / `--language` 是全局开关，先摘出来再解析其余参数。
  const { lang, rest } = extractLanguageArg(process.argv.slice(2));
  const [cmd, ...cmdArgs] = rest;
  const isHelp = !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h';

  if (isHelp) {
    // Help must still work when config.json is broken, so failures here are tolerated.
    // config.json 损坏时帮助信息仍应可用，因此这里容忍失败。
    try {
      configureRuntime(loadConfig(), { language: lang });
    } catch (e) {
      if (lang) setLanguage(lang);
    }
    usage();
    process.exitCode = cmd ? 0 : 1;
    return;
  }

  const config = loadConfig();
  configureRuntime(config, { language: lang });
  printConfigWarnings(config);

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(t('cli.unknownCommand', { cmd }));
    usage();
    process.exitCode = 1;
    return;
  }

  // Per-command flag declaration: valueFlags decides whether a flag consumes the next argument;
  // booleanFlags only suppresses the unknown-flag warning.
  //
  // 命令级旗标声明：valueFlags 决定是否消费下一个参数，booleanFlags 只用于抑制未知旗标告警。
  const knownFlags = [...entry.flags, ...(entry.booleanFlags || []), ...(entry.valueFlags || []), 'help'];
  const args = parseArgs(cmdArgs, { knownFlags, valueFlags: entry.valueFlags || [] });
  for (const unknown of args.unknown) {
    console.error(t('cli.unknownFlag', { flag: unknown }));
  }

  if (args.flags.help) {
    const mod = loadCommand(cmd);
    (mod && mod.usage ? mod.usage : usage)();
    return;
  }

  await loadCommand(cmd).main(config, args);
}

main().catch((e) => handleFatal(e));
