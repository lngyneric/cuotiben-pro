import assert from 'node:assert/strict';
import { test } from 'node:test';

// 记事本时间线纯函数：简述取第一行、日期格式化。不读库、不读配置。
const { firstLine, formatDate } = await import('@/routes/cuotiben/-util');

test('firstLine：取第一个非空行，去首尾空白', () => {
  assert.equal(firstLine('第一行\n第二行'), '第一行');
  assert.equal(firstLine('\n  \n  第二行\n第三行'), '第二行');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('   '), '');
});

test('时间线简述：内容第一行，内容空则取笔记第一行', () => {
  const summary = (q: string, n: string) => firstLine(q) || firstLine(n);
  assert.equal(summary('求 x 的值\nx+1=2', '笔记'), '求 x 的值');
  assert.equal(summary('', '错因是粗心\n下次检查'), '错因是粗心');
  assert.equal(summary('', ''), '');
});

test('formatDate：ISO 时间转本地 YYYY-MM-DD，非法值截前 10 位', () => {
  // 用本地正午构造，避免时区把日期推到前一天/后一天
  const localNoon = new Date(2026, 10, 19, 12, 0, 0).toISOString();
  assert.equal(formatDate(localNoon), '2026-11-19');
  assert.equal(formatDate('not-a-date'), 'not-a-date');
  assert.equal(formatDate(''), '');
});
