// Logo 注入单测：tryResolveLogo 双路径解析（public/ 与 .output/public/）。
// 容器里 cwd 是 /app，静态资源只在 /app/.output/public/ 下；只读 public/
// 会使容器里永远返回 null（2026-11-25 实测定位）。测试用 process.chdir
// 切换到临时目录，不依赖仓库真实的 public/logo.png。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// 最小环境：只让模块加载（db() 是惰性的，导入不建连）。
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file::memory:?cache=shared',
  AUTH_SECRET: 'test-secret',
  NODE_ENV: 'test',
  VITE_APP_URL: 'http://localhost:3000',
});

const { tryResolveLogo } = await import('../src/modules/presentations/images');

// 1x1 透明 PNG（合法 PNG 头，供真实字节断言）。
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let root = '';
const origCwd = process.cwd();

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipany-ppt-logo-test-'));
});

after(async () => {
  process.chdir(origCwd);
  await rm(root, { recursive: true, force: true });
});

async function withCwd(dir: string, fn: () => Promise<void>): Promise<void> {
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(origCwd);
  }
}

async function makeCase(
  name: string,
  files: Record<string, Buffer>
): Promise<string> {
  const dir = join(root, name);
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
  }
  return dir;
}

test('logo: public/logo.png 优先解析', async () => {
  const dir = await makeCase('public-only', {
    'public/logo.png': PNG_1X1,
  });
  await withCwd(dir, async () => {
    const logo = await tryResolveLogo();
    assert.ok(logo, 'should resolve from public/');
    assert.equal(logo.name, 'logo.png');
    assert.equal(logo.mime, 'image/png');
    assert.deepEqual(logo.bytes, PNG_1X1);
  });
});

test('logo: 只有 .output/public/logo.png 时走容器路径', async () => {
  const dir = await makeCase('output-only', {
    '.output/public/logo.png': PNG_1X1,
  });
  await withCwd(dir, async () => {
    const logo = await tryResolveLogo();
    assert.ok(logo, 'should resolve from .output/public/');
    assert.equal(logo.name, 'logo.png');
    assert.equal(logo.mime, 'image/png');
    assert.deepEqual(logo.bytes, PNG_1X1);
  });
});

test('logo: 两处都有时优先 public/', async () => {
  const dir = await makeCase('both', {
    'public/logo.png': Buffer.from('from-public'),
    '.output/public/logo.png': Buffer.from('from-output'),
  });
  await withCwd(dir, async () => {
    const logo = await tryResolveLogo();
    assert.ok(logo, 'should resolve');
    assert.deepEqual(logo.bytes, Buffer.from('from-public'));
  });
});

test('logo: 两处都没有返回 null', async () => {
  const dir = await makeCase('none', {
    'public/other.png': PNG_1X1,
  });
  await withCwd(dir, async () => {
    const logo = await tryResolveLogo();
    assert.equal(logo, null);
  });
});
