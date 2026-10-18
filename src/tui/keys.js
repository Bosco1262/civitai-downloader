'use strict';

// Raw keyboard input helpers shared by the full-screen screens (picker, library browser, help page).
//
// Raw mode means the terminal no longer translates Ctrl+C into SIGINT, so every screen has to
// recognise it itself: without that, Ctrl+C inside a picker leaves the terminal in raw mode and the
// process hangs. Ctrl+Z / Ctrl+\\ need the same treatment. Centralising the mapping keeps every
// screen behaving the same way.
//
//
// 全屏界面（选择器、模型库浏览页、帮助页）共用的原始键盘输入处理。
//
// 原始模式下终端不再把 Ctrl+C 变成 SIGINT，因此界面必须自己识别：
// 否则在选择器里按 Ctrl+C 会把终端留在原始模式并卡住进程。Ctrl+Z / Ctrl+\\ 同理。
// 集中在一处可保证各界面行为一致。

const fs = require('fs');
const path = require('path');

/**
 * Append one line to the TUI trace when `CIVITAI_TUI_DEBUG` is set (value `1` means
 * `.data/tui-debug.log`, anything else is used as the file path).
 *
 * A screen that "never responds" leaves no clue on screen, so this trace records when raw mode was
 * taken over, which keys arrived and when a screen was left. It is off by default and never throws.
 *
 *
 * 设置了 `CIVITAI_TUI_DEBUG` 时把一行追加到 TUI 轨迹里（值为 `1` 表示 `.data/tui-debug.log`，
 * 其它值当作文件路径）。
 *
 * 「界面毫无反应」在屏幕上看不出任何线索，因此这里记录原始模式何时接管、收到了哪些按键、
 * 界面何时退出。默认关闭，且从不抛错。
 */
function debugLog(message) {
  const target = process.env.CIVITAI_TUI_DEBUG;
  if (!target) return;
  try {
    const file = target === '1' ? path.join('.data', 'tui-debug.log') : target;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch (e) {
    // Tracing must never break the UI.
    // 轨迹记录不能影响界面。
  }
}

/**
 * Control characters the terminal sends for the usual shortcuts.
 * 终端为常用快捷键发送的控制字符。
 */
const KEYS = {
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlZ: '\u001a',
  ctrlBackslash: '\u001c',
  escape: '\u001b',
  return: '\r',
  newline: '\n',
  tab: '\t',
  backspace: '\u007f',
};

/**
 * What a pressed key means for a screen: 'cancel' / 'suspend' / null (nothing special).
 *
 * A keypress event carries the character plus the parsed key object, so both are inspected:
 * Ctrl+C arrives as text '\u0003' with key.ctrl true and key.name 'c', while some terminals only
 * report the character. Backspace is accepted in both spellings ('\u007f' and key.name backspace).
 *
 *
 * 按键对界面意味着什么：'cancel' / 'suspend' / null（无特殊含义）。
 *
 * keypress 事件同时给出字符与解析后的 key 对象，两者都要看：
 * Ctrl+C 的 text 是 '\u0003'、key.ctrl 为真且 key.name 为 'c'，而部分终端只给字符。
 * 退格键的两种写法（'\u007f' 与 key.name='backspace'）都接受。
 *
 * @param {string} text
 * @param {{name?:string, ctrl?:boolean, meta?:boolean, shift?:boolean}} [key]
 * @returns {'cancel'|'suspend'|null}
 */
function controlIntent(text, key) {
  const k = key || {};
  const char = text === undefined || text === null ? '' : String(text);
  if (k.ctrl && k.name === 'c') return 'cancel';
  if (char === KEYS.ctrlC) return 'cancel';
  if (k.ctrl && k.name === 'z') return 'suspend';
  if (char === KEYS.ctrlZ || char === KEYS.ctrlBackslash) return 'suspend';
  return null;
}

/**
 * Whether a keypress produced text that can be appended to an input field.
 * Rejects control characters, Alt-combinations and multi-character escape sequences.
 *
 * 该按键是否产生了可以追加到输入框的文本。
 * 控制字符、Alt 组合键与多字符转义序列都会被拒绝。
 */
function isTextInput(text, key) {
  const k = key || {};
  if (k.ctrl || k.meta) return false;
  const char = text === undefined || text === null ? '' : String(text);
  if (!char) return false;
  if (char.length > 1) return false;
  const code = char.codePointAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/**
 * Whether the key means "backspace" in either spelling.
 * 该按键是否表示退格（两种写法都算）。
 */
function isBackspace(text, key) {
  const k = key || {};
  if (k.name === 'backspace' || k.name === 'delete') return true;
  return text === KEYS.backspace || text === '\b';
}

/**
 * Install the raw-mode keypress loop: `onKey(text, key)` runs for every keypress and returning
 * `false` stops listening, while `onSignal(intent)` receives 'cancel' (Ctrl+C) and 'suspend'
 * (Ctrl+Z / Ctrl+\\). The returned `restore()` removes the listener, leaves raw mode and pauses
 * stdin; it is safe to call several times (every screen calls it from a finally block).
 *
 * Returns `null` when the terminal cannot provide raw keypresses at all (stdin is not a TTY, raw
 * mode was refused, or the stream closed). Callers must then take their fallback path — waiting for
 * keys that can never arrive is exactly the "the TUI stopped responding" symptom.
 *
 *
 * 安装原始模式按键循环：每次按键调用 `onKey(text, key)`，返回 `false` 表示停止监听；
 * Ctrl+C（'cancel'）与 Ctrl+Z / Ctrl+\\（'suspend'）交给 `onSignal(intent)`。
 * 返回的 `restore()` 移除监听、退出原始模式并暂停 stdin，可重复调用（各界面都在 finally 里调用）。
 *
 * 终端根本无法提供原始按键时（stdin 不是 TTY、原始模式被拒、流已关闭）返回 `null`。
 * 调用方必须改走回退路径——等一个永远不会到来的按键，正是「TUI 完全不反应」的成因。
 *
 * @param {{
 *   onKey:(text:string, key:object)=>any,
 *   onSignal?:(intent:'cancel'|'suspend')=>void,
 *   stream?:NodeJS.ReadStream
 * }} opts
 * @returns {(() => void)|null} restore, or null when raw keys are unavailable
 */
function installRawKeys(opts = {}) {
  const stdin = opts.stream || process.stdin;
  const onKey = typeof opts.onKey === 'function' ? opts.onKey : () => true;
  const onSignal = typeof opts.onSignal === 'function' ? opts.onSignal : null;
  if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return null;
  }

  const readline = require('readline');
  let restore = null;

  const listener = (text, key) => {
    const intent = controlIntent(text, key);
    debugLog(`key name=${(key && key.name) || '-'} text=${JSON.stringify(text)} intent=${intent || '-'}`);
    if (intent === 'cancel') {
      if (onSignal) onSignal('cancel');
      else restore();
      return;
    }
    if (intent === 'suspend') {
      if (onSignal) onSignal('suspend');
      else restore();
      return;
    }
    if (onKey(text, key || {}) === false) restore();
  };

  try {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
  } catch (e) {
    debugLog(`raw-install-failed ${e && e.message}`);
    return null;
  }
  // A TTY that silently refused raw mode will never emit keypress events: report that instead of
  // leaving the caller waiting.
  //
  // 若原始模式没有真正生效，就永远不会有按键事件：直接上报，别让调用方一直等。
  if (!stdin.isRaw) {
    debugLog('raw-install-failed isRaw=false');
    return null;
  }

  stdin.on('keypress', listener);
  debugLog('raw-install ok');

  restore = () => {
    debugLog('raw-restore');
    try {
      if (typeof stdin.removeListener === 'function') stdin.removeListener('keypress', listener);
    } catch (e) {
      // Ignore failures while detaching the listener.
      // 移除监听失败时忽略。
    }
    try {
      // Leave raw mode even when it was already on before this screen (a prompt library may have
      // left it that way): a terminal stuck in raw mode breaks the shell afterwards.
      //
      // 即使进入前已经是原始模式（提问库可能留下的）也要关掉：终端留在原始模式会把后续 shell 弄坏。
      stdin.setRawMode(false);
    } catch (e) {
      // Ignore failures when restoring the raw-mode flag.
      // 恢复原始模式标记失败时忽略。
    }
    try {
      stdin.pause();
    } catch (e) {
      // Ignore failures when pausing stdin.
      // 暂停 stdin 失败时忽略。
    }
  };

  return restore;
}

module.exports = {
  KEYS,
  controlIntent,
  isTextInput,
  isBackspace,
  installRawKeys,
  debugLog,
};
