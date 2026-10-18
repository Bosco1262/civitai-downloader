'use strict';

/**
 * doctor: one command to check the environment and configuration, avoiding a pile of cryptic errors at startup.
 * doctor：一条命令体检环境与配置，避免"跑起来先报一堆莫名错误"。
 */

const fs = require('fs');
const path = require('path');
const { formatBytes, ensureDir } = require('../util');
const { checkCurl, checkAria2 } = require('../downloader');
const { findBrowserPath, probeDebugPort, wantsHeadless } = require('../browser');
const { readLibrary, readCollection } = require('../storage');
const { freeSpaceBytes } = require('../job');
const { parseCollectionId } = require('../urls');
const { resolveLanguage } = require('../i18n');
const { AUTH_COOKIE_NAME } = require('../cookies');
const { t } = require('../i18n');

function usage() {
  console.error(t('doctor.usage'));
  process.exitCode = 1;
}

function makeReport() {
  const items = [];
  const add = (name, status, detail, hint) => items.push({ name, status, detail, hint: hint || null });
  return { items, add };
}

function parseCookieFile(file) {
  if (!fs.existsSync(file)) return { exists: false, count: 0, hasAuth: false, expiresSoon: false };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { exists: true, count: 0, hasAuth: false, error: e.message };
  }
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  let hasAuth = false;
  let soonest = null;
  for (const row of rows) {
    const parts = row.split('\t');
    const name = parts[5];
    const expiry = Number(parts[4]) * 1000;
    if (name === AUTH_COOKIE_NAME || (/civ/i.test(name || '') && /token/i.test(name || ''))) hasAuth = true;
    if (Number.isFinite(expiry) && expiry > 0 && (soonest === null || expiry < soonest)) soonest = expiry;
  }
  const expiresSoon = soonest !== null && soonest - Date.now() < 2 * 24 * 3600 * 1000;
  return { exists: true, count: rows.length, hasAuth, expiresSoon, soonest };
}

function writable(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.dsh-write-check-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function longPathCheck(dir) {
  const base = path.join(dir, 'longpath-check');
  try {
    const deep = path.join(base, 'x'.repeat(120), 'y'.repeat(120));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'probe.txt'), 'ok');
    fs.rmSync(base, { recursive: true, force: true });
    return { ok: true, detail: t('doctor.longPathOk') };
  } catch (e) {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch (err) {
      // ignore
      // 忽略
    }
    return { ok: false, detail: e.message };
  }
}

/**
 * Collect every check as structured items (no printing), so the CLI can render them as text and the
 * web UI can render them as cards from the same source.
 *
 * 把所有检查收集成结构化条目（不打印），命令行负责渲染成文本、Web UI 渲染成卡片，两者共用同一份结果。
 *
 * @param {object} config
 * @param {{deep?:boolean}} [opts]
 * @returns {Promise<Array<{name:string,status:'ok'|'warn'|'fail',detail:string,hint?:string}>>}
 */
async function collect(config, opts = {}) {
  const rep = makeReport();

  rep.add(
    'Node.js',
    'ok',
    t('doctor.nodeVersion', {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    })
  );

  if (config.warnings.length) {
    for (const w of config.warnings) {
      rep.add(t('doctor.itemConfigWarnings'), 'warn', w, t('doctor.hintConfigWarnings'));
    }
  }
  rep.add(
    t('doctor.itemConfigFile'),
    'ok',
    `${config.configFile}${config.configExists ? '' : t('doctor.configMissingSuffix')}`,
    config.configExists ? null : t('doctor.hintConfigFileMissing')
  );
  rep.add(t('doctor.itemSite'), 'ok', config.site);
  if (config.proxy) rep.add(t('doctor.itemProxy'), 'ok', config.proxy);

  try {
    const bin = checkCurl();
    rep.add('curl', 'ok', t('doctor.curlAvailable', { bin }));
  } catch (e) {
    rep.add('curl', 'fail', e.message, t('doctor.hintCurl'));
  }

  try {
    rep.add(t('doctor.itemBrowser'), 'ok', findBrowserPath(config));
  } catch (e) {
    rep.add(t('doctor.itemBrowser'), 'fail', e.message, t('doctor.hintChromePath'));
  }

  rep.add(
    t('doctor.itemBrowserProfile'),
    'ok',
    config.profileDir,
    config.profileDirExplicit ? t('doctor.profileExplicit') : t('doctor.profileIsolated')
  );

  // Headless mode only affects the *next* launch; the login flow always opens a window.
  // 无头模式只影响下一次启动；登录流程始终会打开窗口。
  rep.add(
    t('doctor.itemBrowserMode'),
    'ok',
    wantsHeadless(config, {}) ? t('doctor.browserModeHeadless') : t('doctor.browserModeHeadful')
  );

  const aria2 = checkAria2();
  const engineIssue = config.engine === 'aria2' && !aria2;
  rep.add(
    t('doctor.itemEngine'),
    engineIssue ? 'fail' : aria2 ? 'ok' : 'warn',
    t('doctor.engineDetail', {
      engine: config.engine,
      aria2: aria2 ? t('doctor.aria2Available') : t('doctor.aria2Missing'),
      dedup: config.dedup !== 'off' ? t('doctor.dedupSuffix', { mode: config.dedup }) : '',
    }),
    engineIssue ? t('doctor.hintAria2Missing') : undefined
  );

  const port = await probeDebugPort(config.debugPort);
  if (port.info) {
    rep.add(
      t('doctor.itemDebugPort'),
      'ok',
      t('doctor.portReady', { port: config.debugPort, browser: port.info.Browser || t('doctor.unknownBrowser') })
    );
  } else {
    rep.add(
      t('doctor.itemDebugPort'),
      'warn',
      t('doctor.portNotReady', { port: config.debugPort, reason: port.reason }),
      t('doctor.hintDebugPort')
    );
  }

  const cookie = parseCookieFile(config.cookiesFile);
  if (!cookie.exists) {
    rep.add(
      t('doctor.itemLogin'),
      'warn',
      t('doctor.cookiesMissing', { file: config.cookiesFile }),
      t('doctor.hintRunLogin')
    );
  } else if (!cookie.hasAuth) {
    rep.add(
      t('doctor.itemLogin'),
      'warn',
      t('doctor.cookiesNoAuth', { count: cookie.count }),
      t('doctor.hintRelogin')
    );
  } else if (cookie.expiresSoon) {
    rep.add(
      t('doctor.itemLogin'),
      'warn',
      t('doctor.credentialExpiring', { expiresAt: new Date(cookie.soonest).toLocaleString() }),
      t('doctor.hintReloginSuggested')
    );
  } else {
    rep.add(t('doctor.itemLogin'), 'ok', t('doctor.cookiesOk', { count: cookie.count }));
  }

  const outWritable = writable(config.outDir);
  rep.add(
    t('doctor.itemOutDir'),
    outWritable.ok ? 'ok' : 'fail',
    outWritable.ok ? config.outDir : t('doctor.dirError', { dir: config.outDir, error: outWritable.error }),
    outWritable.ok ? null : t('doctor.hintOutDirPermission')
  );

  const dataWritable = writable(config.dataDir);
  rep.add(
    t('doctor.itemDataDir'),
    dataWritable.ok ? 'ok' : 'fail',
    dataWritable.ok ? config.dataDir : dataWritable.error
  );

  const space = freeSpaceBytes(config.outDir);
  rep.add(
    t('doctor.itemDiskSpace'),
    space === null ? 'warn' : space < 5 * 1024 * 1024 * 1024 ? 'warn' : 'ok',
    space === null ? t('doctor.spaceUnknown') : t('doctor.spaceRemaining', { size: formatBytes(space) })
  );

  const longPath = longPathCheck(config.dataDir);
  rep.add(
    t('doctor.itemLongPath'),
    longPath.ok ? 'ok' : 'warn',
    longPath.detail,
    longPath.ok ? null : t('doctor.hintLongPath')
  );

  // Local records related to a collection: the membership snapshot written by list/download.
  // 收藏集相关的本地记录：由 list/download 写下的成员快照。
  const collectionId = args && args.positionals && args.positionals[0] ? parseCollectionId(args.positionals[0]) : null;
  if (collectionId) {
    const { snapshot, corrupt } = readCollection(config, collectionId, { allowCorrupt: true });
    if (corrupt) rep.add(t('doctor.itemSnapshot'), 'fail', corrupt.message, t('doctor.hintSnapshot'));
    else if (!snapshot) {
      rep.add(t('doctor.itemSnapshot'), 'warn', t('doctor.snapshotMissing', { collectionId }), t('doctor.hintRunList'));
    } else {
      rep.add(
        t('doctor.itemSnapshot'),
        'ok',
        t('doctor.snapshotInfo', {
          collectionId,
          count: snapshot.items.length,
          fetchedAt: snapshot.fetchedAt || t('common.unknown'),
        })
      );
    }
  }

  // Model library overview: models and their versions.
  // 模型库概览：模型数与版本数。
  const { entries: libraryEntries, corrupt: libraryCorrupt } = readLibrary(config, { allowCorrupt: true });
  const libraryModelIds = Object.keys(libraryEntries);
  const libraryVersions = libraryModelIds.reduce(
    (sum, id) => sum + Object.keys(libraryEntries[id].versions || {}).length,
    0
  );
  rep.add(
    t('doctor.itemLibrary'),
    libraryCorrupt ? 'fail' : 'ok',
    libraryCorrupt
      ? libraryCorrupt.message
      : t('doctor.libraryStats', { models: libraryModelIds.length, versions: libraryVersions }),
    libraryCorrupt ? t('doctor.hintLibrary') : t('doctor.hintLibraryList')
  );

  // How the UI language was resolved (explicit / auto / English fallback).
  // configureRuntime() records the effective decision (including CLI `-l/--lang`), so prefer it.
  //
  //
  // 界面语言是怎么解析出来的（显式 / 自动 / 英文兜底）
  //
  // configureRuntime() 记录了最终决定（含 CLI 的 -l/--lang），优先使用它。
  const languageInfo = config.languageInfo || resolveLanguage({ explicit: config.language });
  const languageText =
    languageInfo.source === 'explicit'
      ? t('doctor.languageExplicit', { language: languageInfo.language })
      : languageInfo.source === 'auto'
        ? t('doctor.languageAuto', { language: languageInfo.language })
        : t('doctor.languageFallback', { language: languageInfo.language });
  rep.add(t('doctor.itemLanguage'), 'ok', languageText);

  if (opts.deep) {
    try {
      const { checkLogin } = require('../loginFlow');
      const probe = await checkLogin(config, { log: () => {} });
      rep.add(
        t('doctor.itemLoginProbe'),
        probe.ok ? 'ok' : 'fail',
        probe.reason,
        probe.ok ? null : t('doctor.hintRelogin')
      );
    } catch (e) {
      rep.add(t('doctor.itemLoginProbe'), 'fail', e.message);
    }
  }

  return rep.items;
}

/**
 * CLI entry: run the checks and print them.
 * 命令行入口：执行检查并打印。
 */
async function main(config, args) {
  const rep = { items: await collect(config, { deep: !!(args && args.flags.deep) }) };

  if (args && args.flags.json) {
    console.log(JSON.stringify(rep.items, null, 2));
  } else {
    console.log('');
    console.log(t('doctor.title'));
    console.log('-'.repeat(78));
    for (const it of rep.items) {
      const tag =
        it.status === 'ok' ? t('doctor.tagOk') : it.status === 'warn' ? t('doctor.tagWarn') : t('doctor.tagFail');
      console.log(t('doctor.line', { tag, name: it.name, detail: it.detail }));
      if (it.hint) console.log(t('doctor.hintLine', { hint: it.hint }));
    }
    console.log('-'.repeat(78));
    const fails = rep.items.filter((i) => i.status === 'fail').length;
    const warns = rep.items.filter((i) => i.status === 'warn').length;
    console.log(
      fails
        ? t('doctor.summaryFails', { fails, warns })
        : warns
          ? t('doctor.summaryWarns', { warns })
          : t('doctor.summaryOk')
    );
  }

  if (rep.items.some((i) => i.status === 'fail')) process.exitCode = 1;
}

module.exports = { main, collect, usage, parseCookieFile, longPathCheck };
