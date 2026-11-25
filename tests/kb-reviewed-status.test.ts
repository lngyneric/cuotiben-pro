import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Isolated database; no application modules load before the env is set.
// Mirrors tests/draft-preview.test.ts.
const directory = await mkdtemp(join(tmpdir(), 'shipany-kb-reviewed-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'test-auth-secret-0123456789abcdef',
  NODE_ENV: 'test',
  VITE_APP_URL: 'http://localhost:3000',
});
execFileSync(
  process.execPath,
  [
    'node_modules/drizzle-kit/bin.cjs',
    'push',
    '--dialect=sqlite',
    '--schema=./src/config/db/schema.sqlite.ts',
    `--url=${process.env.DATABASE_URL}`,
    '--force',
  ],
  { stdio: 'pipe', env: process.env }
);

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

const { db } = await import('@/core/db');
const { post, user } = await import('@/config/db/schema');
const { getUuid } = await import('@/lib/hash');
const { PostStatus } = await import('@/modules/posts/service');
const { batchStatus } = await import('@/server/admin/handlers/posts');
const { filterGraphOverlayForViewer } = await import('@/routes/api/graph');

const authorId = getUuid();
await db().insert(user).values({
  id: authorId,
  name: 'Test Author',
  email: 'author@example.com',
});

async function insertPost(slug: string, status: string) {
  const id = getUuid();
  await db()
    .insert(post)
    .values({
      id,
      userId: authorId,
      slug,
      type: 'article',
      title: `Test ${slug}`,
      content: 'test content',
      status,
    });
  return id;
}

function batchCtx(body: unknown) {
  return {
    request: new Request('http://localhost/api/admin/posts/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
    actor: { userId: authorId, permissions: ['admin.*'] },
  } as any;
}

test('PostStatus.REVIEWED 存在且值为 reviewed', () => {
  assert.equal(PostStatus.REVIEWED, 'reviewed');
});

test('batchStatus 接受 reviewed，并拒绝非法状态', async () => {
  const id1 = await insertPost('kb-draft-test-1', 'draft');
  const id2 = await insertPost('kb-draft-test-2', 'draft');
  const ok = await batchStatus(
    batchCtx({ ids: [id1, id2], status: 'reviewed' })
  );
  const okJson: any = await ok.json();
  assert.equal(okJson.code, 0);
  assert.equal(okJson.data.updated, 2);
  const rows = await db().select().from(post);
  for (const r of rows.filter((x: { id: string }) =>
    [id1, id2].includes(x.id)
  )) {
    assert.equal(r.status, 'reviewed');
  }
  const bad = await batchStatus(batchCtx({ ids: [id1], status: 'archived' }));
  const badJson: any = await bad.json();
  assert.notEqual(badJson.code, 0);
});

test('filterGraphOverlayForViewer：非管理员只看已发布', () => {
  const courses = [
    { bid: 'a', slug: 'course-a', title: 'A', status: 'published' },
    { bid: 'b', slug: 'course-b', title: 'B', status: 'draft' },
    { bid: 'c', slug: 'course-c', title: 'C', status: 'reviewed' },
  ];
  const links = [
    { nodeId: 'n1', courseBid: 'a', score: 5 },
    { nodeId: 'n1', courseBid: 'b', score: 4 },
    { nodeId: 'n2', courseBid: 'c', score: 3 },
  ];
  const viewer = filterGraphOverlayForViewer(courses, links, false);
  assert.deepEqual(
    viewer.courses.map((c) => c.bid),
    ['a']
  );
  assert.deepEqual(
    viewer.links.map((l) => l.courseBid),
    ['a']
  );
  const admin = filterGraphOverlayForViewer(courses, links, true);
  assert.equal(admin.courses.length, 3);
  assert.equal(admin.links.length, 3);
});
