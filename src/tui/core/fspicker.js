'use strict';

// Native folder picker used by the settings page.
//
// A terminal cannot browse folders, so the TUI asks the platform for its own dialog: a Windows
// FolderBrowserDialog, the macOS `choose folder` panel, or zenity / kdialog on Linux. The chosen path
// is only *offered* to the field — the caller writes it into the input line, where it can still be
// edited and submitted. That keeps every device usable: where the dialog cannot open (no zenity, a
// headless session, a remote shell) the same field is still typed by hand.
//
//
// 设置页使用的系统目录选择框。
//
// 终端本身没法浏览目录，因此 TUI 借平台自己的对话框：Windows 的 FolderBrowserDialog、macOS 的
// `choose folder` 面板，Linux 上则是 zenity / kdialog。选中的路径只是「提供给」输入框——调用方把它
// 填进输入行，仍可修改后再提交。这样任何设备都能用：弹不出对话框的环境（没有 zenity、无头会话、
// 远程 shell）照样可以手输同一个字段。

const { spawn } = require('child_process');
const fs = require('fs');

/**
 * How long a dialog may stay open before it is given up on (2 minutes).
 * 对话框最多停留多久（2 分钟）。
 */
const PICK_TIMEOUT_MS = 120000;

/**
 * Escape a value for a single-quoted PowerShell string (double the quotes).
 * 把值转义成 PowerShell 单引号字符串（单引号翻倍）。
 */
function psQuote(value) {
  return `'${String(value === undefined || value === null ? '' : value).replace(/'/g, "''")}'`;
}

/**
 * Escape a value for an AppleScript double-quoted string.
 * 把值转义成 AppleScript 双引号字符串。
 */
function appleQuote(value) {
  return `"${String(value === undefined || value === null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The dialog command of one platform, or null when this platform has no known picker.
 *
 * Pure on purpose: the command can be asserted without opening a window.
 *
 *
 * 某个平台的对话框命令；平台没有已知选择框时返回 null。
 *
 * 刻意做成纯函数：不开窗口也能断言命令内容。
 *
 * @param {'win32'|'darwin'|'linux'|string} platform
 * @param {string} [startDir]
 * @returns {{command:string, args:string[]}|null}
 */
function pickerCommand(platform, startDir = '') {
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      // A minimized top-most owner keeps the dialog in front of the console window.
      // 用一个最小化的置顶窗口当 owner，对话框就不会藏到控制台后面。
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.WindowState = "Minimized"',
      '$owner.Show()',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = ${psQuote(startDir ? '选择下载目录' : '选择目录')}`,
      `$dialog.SelectedPath = ${psQuote(startDir)}`,
      '$result = $dialog.ShowDialog($owner)',
      '$owner.Close()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    ].join('; ');
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    };
  }
  if (platform === 'darwin') {
    const base = startDir ? ` default location POSIX file ${appleQuote(startDir)}` : '';
    return {
      command: 'osascript',
      args: ['-e', `POSIX path of (choose folder with prompt "选择目录"${base})`],
    };
  }
  if (platform === 'linux') {
    // zenity is the GNOME/GTK default; kdialog covers KDE. Which one exists is decided at run time.
    // zenity 是 GNOME/GTK 的默认选择；KDE 上则是 kdialog。具体用哪个在运行时决定。
    if (commandExists('zenity')) {
      return {
        command: 'zenity',
        args: ['--file-selection', '--directory', '--title=选择目录', `--filename=${startDir || ''}`],
      };
    }
    if (commandExists('kdialog')) {
      return { command: 'kdialog', args: ['--getexistingdirectory', startDir || '.'] };
    }
    return null;
  }
  return null;
}

/**
 * Whether a program is on PATH (best effort, never throws).
 * 程序是否在 PATH 上（尽力而为，不抛错）。
 */
function commandExists(name) {
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(`${dir}/${name}${ext}`)) return true;
      } catch (e) {
        // A vanished PATH entry is not an error here.
        // PATH 里消失的目录在这里不算错误。
      }
    }
  }
  return false;
}

/**
 * Run the platform dialog and resolve with the chosen path (null when cancelled or unavailable).
 * 运行平台对话框，返回选中的路径（取消或不可用时为 null）。
 *
 * @param {string} [startDir] where the dialog opens
 * @returns {Promise<string|null>}
 */
function pickDirectory(startDir) {
  const spec = pickerCommand(process.platform, startDir || '');
  if (!spec) return Promise.resolve(null);
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
    } catch (e) {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {
        // The dialog may already be gone.
        // 对话框可能已经关闭。
      }
      finish(null);
    }, PICK_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const picked = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      finish(picked || null);
    });
  });
}

module.exports = { pickDirectory, pickerCommand, commandExists, PICK_TIMEOUT_MS };
