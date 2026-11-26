// Logo 模板内嵌单测：Logo 不再随每次生成上传，改嵌在 sysmex 模板里。
// 2026-11-25 之前是每次生成都把 public/logo.png 当文件上传给 Presenton，
// Presenton 对它跑文档解析/LiteParse OCR，任务 495f3eca 因此 600 秒超时、
// 成稿从未产出。改为模板内嵌后：
//   1. presentations_generate 不传 template 时默认模板是 sysmex（不再是
//      general）——默认值在服务层（service.ts 的 `(input.template ||
//      'sysmex')`），schema 不再补默认值，这样解析后才能区分“显式传模板”
//      还是“没传”（P0 的 smart+显式 template 拒绝靠这个区分）；
//   2. 主题指令写明 Logo 已嵌在模板右上角，不再要求另外放 Logo；
//   3. 仓库里的 presenton-templates/sysmex/template.json 确实含 Logo
//      （24 处：12 个背景组件变体 + 12 个版式的背景拷贝），
//      static/logo.png 是透明底 PNG（275×110），可浮于任何底色上。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

// 最小环境：只让模块加载（db() 是惰性的，导入不建连）。
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file::memory:?cache=shared',
  AUTH_SECRET: 'test-secret',
  NODE_ENV: 'test',
  VITE_APP_URL: 'http://localhost:3000',
});

const { findOperation } = await import('../src/server/admin/execute');
const { buildThemeInstructions, PPT_LOGO_SLOT } =
  await import('../src/modules/presentations/layouts');

test('logo: presentations_generate 不传 template 时 schema 不补默认值', () => {
  const op = findOperation('presentations_generate');
  const parsed = op.schema.parse({});
  // P0：schema 不再 .default('sysmex')——解析后 template 为 undefined，
  // 服务层 `(input.template || 'sysmex')` 再兜底 sysmex（见
  // tests/presentations.test.ts 对 Presenton 请求体的断言）。
  assert.equal(parsed.template, undefined);
});

test('logo: 主题指令写明 Logo 已嵌在模板右上角', () => {
  const text = buildThemeInstructions();
  assert.match(text, /Logo 已嵌在 sysmex 模板右上角/);
  assert.match(text, new RegExp(String(PPT_LOGO_SLOT.x)));
  assert.match(text, /不要另外放 Logo/);
});

test('logo: sysmex 模板文件含 24 处 Logo 元素', async () => {
  const tplPath = join(
    process.cwd(),
    'presenton-templates/sysmex/template.json'
  );
  const tpl = JSON.parse(await readFile(tplPath, 'utf-8'));
  assert.equal(tpl.id, 'sysmex');
  const placements =
    JSON.stringify(tpl).match(/"name":\s*"sysmex_logo"/g) ?? [];
  assert.equal(placements.length, 24);
});

test('logo: 模板 Logo 是透明底 PNG（275×110）', async () => {
  const bytes = await readFile(
    join(process.cwd(), 'presenton-templates/sysmex/static/logo.png')
  );
  // PNG 签名 + IHDR：宽 275、高 110、颜色类型 6（RGBA）。
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  assert.equal(bytes.readUInt32BE(16), 275);
  assert.equal(bytes.readUInt32BE(20), 110);
  assert.equal(bytes[25], 6);
});
