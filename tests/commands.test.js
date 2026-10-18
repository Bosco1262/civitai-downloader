'use strict';

/**
 * Consistency checks for the command registry:
 * every flag a command declares must be classified correctly by util (value or boolean),
 * otherwise bugs like "a flag swallows a positional argument" appear (this really happened before).
 *
 * 命令注册表的一致性校验：
 * 每个命令声明的旗标都必须被 util 正确分类（取值 or 布尔），
 * 否则就会出现「旗标吞掉位置参数」这类问题（历史上真发生过）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMANDS, commandNames, loadCommand } = require('../src/commandSpec');
const { BOOLEAN_FLAGS, VALUE_FLAGS, parseArgs } = require('../src/util');

/**
 * A command may declare different value semantics for a same-named flag
 * (e.g. verify --models is boolean, download --models takes a value).
 *
 * 命令可以为同名旗标声明不同的取值语义（例如 verify --models 是布尔、download --models 取值）
 */
function commandValueFlags(spec) {
  return new Set([...(spec && spec.valueFlags ? spec.valueFlags : [])]);
}

test('每个命令声明的旗标都被正确分类为「取值」或「布尔」', () => {
  for (const name of commandNames()) {
    const spec = COMMANDS[name];
    const localValues = commandValueFlags(spec);
    for (const flag of spec.flags) {
      const classified = VALUE_FLAGS.has(flag) || BOOLEAN_FLAGS.has(flag) || localValues.has(flag);
      assert.ok(classified, `命令 ${name} 的 --${flag} 未被分类到 VALUE_FLAGS / BOOLEAN_FLAGS / 命令级 valueFlags`);
    }
  }
});

test('未分类的旗标按布尔处理（不会吞掉位置参数）', () => {
  for (const name of commandNames()) {
    const spec = COMMANDS[name];
    const localValues = commandValueFlags(spec);
    for (const flag of spec.flags) {
      if (VALUE_FLAGS.has(flag) || localValues.has(flag)) continue;
      const parsed = parseArgs([`--${flag}`, '161131'], { knownFlags: spec.flags });
      assert.deepEqual(parsed.positionals, ['161131'], `--${flag} 不应消费位置参数`);
      assert.equal(parsed.flags[flag], true);
    }
  }
});

test('取值旗标按预期消费一个参数', () => {
  for (const flag of VALUE_FLAGS) {
    const parsed = parseArgs([`--${flag}`, 'VALUE']);
    assert.equal(parsed.flags[flag], 'VALUE', `--${flag} 应取到值`);
    assert.deepEqual(parsed.positionals, []);
  }
});

test('每个命令模块都能被加载且导出 main', () => {
  for (const name of commandNames()) {
    const mod = loadCommand(name);
    assert.equal(typeof mod.main, 'function', `${name} 应导出 main`);
    assert.equal(typeof mod.usage, 'function', `${name} 应导出 usage`);
  }
});

test('未知命令返回 null', () => {
  assert.equal(loadCommand('nope'), null);
});
