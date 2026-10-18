'use strict';

/**
 * Command registry (kept as its own module so tests can verify that every flag a command declares
 * is classified correctly).
 *
 * flags lists **all** legal flags of that command (both value-taking and boolean ones); the
 * classification is decided by VALUE_FLAGS / BOOLEAN_FLAGS in util.js: only value-taking flags
 * consume the next argument.
 *
 * Two optional fields cover cases where the same flag means different things per command:
 *  - valueFlags: flags that **take a value** in this command (overriding the global boolean
 *    classification, e.g. `download --models a,b` takes a value while `check --models` is only a
 *    boolean switch);
 *  - booleanFlags: flags treated as **boolean** in this command that util.BOOLEAN_FLAGS does not
 *    list yet (used only to suppress the "unknown argument" warning; they consume no argument).
 * cli.js merges both into knownFlags and passes valueFlags through to parseArgs.
 *
 *
 * 命令注册表（独立成模块，便于测试校验每个命令声明的旗标都被正确分类）。
 *
 * flags 是该命令**全部**合法旗标（既含取值旗标也含布尔旗标），
 * 分类由 util.js 的 VALUE_FLAGS / BOOLEAN_FLAGS 决定：
 * 只有取值旗标才会消费下一个参数。
 *
 * 另有两个可选字段，用于同一个旗标在不同命令下语义不同的场景：
 *  - valueFlags：该命令里需要**取值的**旗标（覆盖全局的布尔分类，例如
 *    `download --models a,b` 取值，而 `check --models` 只是布尔开关）；
 *  - booleanFlags：该命令里**按布尔处理**、但 util.BOOLEAN_FLAGS 尚未收录的旗标
 *    （只用于抑制「未知参数」告警，本身不消费参数）。
 * cli.js 会同时把两者并入 knownFlags 并把 valueFlags 透传给 parseArgs。
 */

const COMMANDS = {
  login: {
    file: './commands/login',
    flags: ['check'],
  },
  list: {
    file: './commands/list',
    flags: ['json', 'plan', 'from-cache', 'offline'],
  },
  download: {
    file: './commands/download',
    flags: [
      'out',
      'only',
      'version',
      'force',
      'dry-run',
      'jobs',
      'refresh-meta',
      'resume',
      'from-cache',
      'file-types',
      'no-primary',
      'ignore-space',
      'force-lock',
      'attempts',
      'quiet',
      'offline',
      'reset-state',
      'engine',
      'dedup',
      'notify',
      'toast',
      'collections',
      'model',
      'models',
      'from-file',
    ],
    // --models takes a value in download (a comma-separated model/version reference)
    // --models 在 download 里要取值（逗号分隔的模型/版本引用）
    valueFlags: ['models'],
  },
  check: {
    file: './commands/check',
    flags: ['verify-files', 'deep', 'download', 'all', 'json', 'out', 'quiet'],
    // --models: check every single-model record (boolean; same meaning as verify --models)
    // --models：检查全部单模型记录（布尔；与 verify --models 语义一致）
    booleanFlags: ['models'],
  },
  verify: {
    file: './commands/verify',
    flags: ['all', 'no-hash', 'repair', 'offline', 'json'],
    // --models: verify every single-model record (boolean)
    // --models：校验全部单模型记录（布尔）
    booleanFlags: ['models'],
  },
  doctor: {
    file: './commands/doctor',
    flags: ['json', 'deep'],
  },
  pin: {
    file: './commands/pin',
    flags: ['list', 'unpin'],
  },
  models: {
    file: './commands/models',
    flags: ['json', 'version', 'search', 'sort', 'export', 'forget', 'pin', 'unpin', 'relayout', 'dry-run'],
    // --pin <id>[=<versionId>] / --unpin <id> take a value in this command (globally they are boolean)
    // --pin <id>[=<versionId>] / --unpin <id> 在本命令里要取值（全局是布尔）
    valueFlags: ['pin', 'unpin'],
    // --delete-files: delete the files listed in the records (boolean)
    // --delete-files：删除记录里列出的文件（布尔）
    booleanFlags: ['delete-files'],
  },
};

function commandNames() {
  return Object.keys(COMMANDS);
}

function commandSpec(name) {
  return COMMANDS[name] || null;
}

/**
 * Load a command module by name (lazy require).
 * 按名加载命令模块（延迟 require）。
 */
function loadCommand(name) {
  const spec = COMMANDS[name];
  if (!spec) return null;
  return require(spec.file);
}

module.exports = { COMMANDS, commandNames, commandSpec, loadCommand };
