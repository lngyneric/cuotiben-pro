import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { desc } from 'drizzle-orm';

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-presentations-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'test-secret-presentations-0123456789abcdef',
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
const { db } = await import('../src/core/db');
const schema = await import('../src/config/db/schema');
const access = await import('../src/modules/admin-access/service');
const { saveConfigs } = await import('../src/modules/config/service');
const presentationsService =
  await import('../src/modules/presentations/service');
const { PPT_THEME_VERSION } =
  await import('../src/modules/presentations/layouts');
const { parseElementIndex } =
  await import('../src/modules/presentations/job-meta');
const { buildElementIndex } =
  await import('../src/modules/presentations/element-index');
const { buildFixturePptx } = await import('./pptx-fixture');
const { runAdminRoute, findOperation } =
  await import('../src/server/admin/execute');
const { Route: downloadRoute } =
  await import('../src/routes/api/admin/agent/presentations/download');
const { Route: elementsRoute } =
  await import('../src/routes/api/ai-assistant/presentations/elements');

const PPTX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fake-pptx-content'),
]);

// --- Stubbed Presenton -----------------------------------------------------
// Modes: status answers 'pending' once, then 'completed'; 'error-quota'
// answers a rate-limit failure; 'pending' never completes.
// createFail forces the smart /create endpoint to fail: '401-once' answers
// 401 on the first call only (transient), '400' always answers 400,
// 'quota-429' always answers 429 with a quota message. asyncThrowOnce
// rejects the first /generate/async call with a network error.
const stub = {
  mode: 'pending-then-completed' as
    | 'pending-then-completed'
    | 'error-quota'
    | 'pending',
  statusCalls: 0,
  calls: [] as { method: string; url: string; body: string }[],
  createCalls: 0,
  asyncCalls: 0,
  createFail: 'none' as 'none' | '401-once' | '400' | 'quota-429',
  asyncThrowOnce: false,
  /** 覆盖 getPresentation(pres-1) 返回的 slides（断言标题页校验用）。 */
  presentationSlides: null as unknown[] | null,
  /** Presenton 导出端点返回的字节；默认是假字节（非合法 zip，盖章直通）。 */
  pptxBytes: PPTX_BYTES as Buffer,
};

function stubFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  stub.calls.push({ method, url, body });
  const json = (data: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  if (url.endsWith('/api/v1/ppt/files/mcp-upload'))
    return json({ file_paths: ['/tmp/presenton/test/x.txt'] });
  if (url.endsWith('/api/v1/ppt/presentation/generate/async')) {
    stub.asyncCalls += 1;
    if (stub.asyncThrowOnce && stub.asyncCalls === 1)
      return Promise.reject(new TypeError('fetch failed'));
    return json({
      id: 'task-1',
      status: 'pending',
      data: {
        presentation_id: 'pres-1',
        created_slides: 0,
        remaining_slides: 1,
      },
    });
  }
  if (url.includes('/api/v1/ppt/presentation/status/')) {
    stub.statusCalls += 1;
    if (stub.mode === 'error-quota')
      return json({
        id: 'task-1',
        status: 'error',
        message: 'Presentation generation failed',
        error: {
          detail:
            'Rate limit exceeded for model opencode-go/deepseek-v4.1-flash',
        },
        data: { presentation_id: 'pres-1' },
      });
    if (stub.mode === 'pending' || stub.statusCalls === 1)
      return json({
        id: 'task-1',
        status: 'pending',
        message: 'Generating',
        data: {
          presentation_id: 'pres-1',
          created_slides: 0,
          remaining_slides: 1,
        },
      });
    return json({
      id: 'task-1',
      status: 'completed',
      message: 'Presentation generation completed',
      data: {
        presentation_id: 'pres-1',
        created_slides: 1,
        remaining_slides: 0,
        path: '/app_data/exports/test.pptx',
        edit_path: '/presentation?id=pres-1',
      },
    });
  }
  if (url.endsWith('/api/v1/ppt/presentation/create')) {
    stub.createCalls += 1;
    if (stub.createFail === '401-once' && stub.createCalls === 1)
      return json({ detail: 'Unauthorized' }, 401);
    if (stub.createFail === '400') return json({ detail: 'Bad request' }, 400);
    if (stub.createFail === 'quota-429')
      return json(
        {
          detail:
            'Rate limit exceeded for model opencode-go/deepseek-v4.1-flash',
        },
        429
      );
    return json({ id: 'pres-smart', title: 'Smart Deck' });
  }
  if (url.includes('/api/v1/ppt/presentation/stream/')) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"slide","index":0}\n\n')
        );
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"done"}\n\n')
        );
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
  }
  if (url.endsWith('/api/v1/ppt/presentation/pres-smart/export'))
    return json({ path: '/app_data/exports/smart.pptx' });
  if (url.endsWith('/api/v1/ppt/presentation/pres-1/export'))
    return json({
      path: '/app_data/exports/test.pptx',
      edit_path: '/presentation?id=pres-1',
    });
  if (url.endsWith('/api/v1/ppt/presentation/pres-smart'))
    return json({
      id: 'pres-smart',
      title: 'Smart Deck',
      slides: [{ id: 's1' }],
    });
  if (url.endsWith('/api/v1/ppt/presentation/pres-1'))
    return json({
      id: 'pres-1',
      title: 'Test Deck',
      slides: stub.presentationSlides ?? [{ id: 's1' }],
    });
  if (url.endsWith('/app_data/exports/test.pptx'))
    return Promise.resolve(new Response(stub.pptxBytes as unknown as BodyInit));
  if (url.endsWith('/app_data/exports/smart.pptx'))
    return Promise.resolve(new Response(stub.pptxBytes as unknown as BodyInit));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

let ownerToken: string;
let otherToken: string;
let ownerAgentId: string;

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  await saveConfigs({
    presenton_base_url: 'http://presenton.test',
    presenton_api_key: 'test-key-1234567890',
  });
  await db()
    .insert(schema.permission)
    .values([
      {
        id: 'perm-gen',
        code: 'admin.presentations.generate',
        resource: 'presentations',
        action: 'generate',
        title: 'Generate PPT',
      },
      {
        id: 'perm-read',
        code: 'admin.presentations.read',
        resource: 'presentations',
        action: 'read',
        title: 'Read PPT jobs',
      },
    ]);
  await db()
    .insert(schema.role)
    .values([
      {
        id: 'role-owner',
        name: 'ppt-owner',
        title: 'PPT Owner',
        status: 'active',
      },
      {
        id: 'role-other',
        name: 'ppt-other',
        title: 'PPT Other',
        status: 'active',
      },
    ]);
  await db()
    .insert(schema.rolePermission)
    .values([
      { id: 'rp-gen', roleId: 'role-owner', permissionId: 'perm-gen' },
      { id: 'rp-read', roleId: 'role-owner', permissionId: 'perm-read' },
      { id: 'rp-read2', roleId: 'role-other', permissionId: 'perm-read' },
    ]);
  const owner = await access.createAgent({
    name: 'PPT owner agent',
    roleIds: ['role-owner'],
    operatorPermissions: ['*'],
  });
  ownerAgentId = owner.id;
  ownerToken = (
    await access.createAgentKey({
      agentId: owner.id,
      name: 'Owner',
      expiresAt: null,
    })
  ).token;
  const other = await access.createAgent({
    name: 'PPT other agent',
    roleIds: ['role-other'],
    operatorPermissions: ['*'],
  });
  otherToken = (
    await access.createAgentKey({
      agentId: other.id,
      name: 'Other',
      expiresAt: null,
    })
  ).token;
  await db().insert(schema.post).values({
    id: 'post-1',
    slug: 'test-post',
    type: 'article',
    title: 'Test Post Title',
    content: 'Post body used as PPT source material.',
    status: 'published',
    userId: ownerAgentId,
  });
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function request(
  operation: string,
  input: Record<string, unknown>,
  token: string,
  key?: string
) {
  const definition = findOperation(operation);
  const path = definition.path.replace('{id}', String(input.id));
  const url = new URL(path, 'http://localhost');
  const body = { ...input };
  if (definition.path.includes('{id}')) delete body.id;
  const query = ['GET', 'DELETE'].includes(definition.method);
  if (query)
    for (const [key, value] of Object.entries(body))
      url.searchParams.set(key, String(value));
  return runAdminRoute(operation, {
    request: new Request(url, {
      method: definition.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(query ? {} : { body: JSON.stringify(body) }),
    }),
    ...(definition.path.includes('{id}')
      ? { params: { id: String(input.id) } }
      : {}),
  });
}

async function generate(
  input: Record<string, unknown>,
  token: string,
  key: string
) {
  const response = await request('presentations_generate', input, token, key);
  return { response, body: (await response.json()) as any };
}

// 导航＋意图优化：standard 生成一律须带已确认的 outlineId（单页也不
// 例外）。先登记一段文本来源，再建 outline、确认，最后带 outlineId
// 生成；extra 透传 titlePage 等附加字段。
async function generateStandardWithOutline(
  text: string,
  token: string,
  key: string,
  extra: Record<string, unknown> = {}
) {
  const sourceRes = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'test.txt',
        mime: 'text/plain',
        base64: Buffer.from(text, 'utf-8').toString('base64'),
      },
    },
    token,
    `${key}-source`
  );
  const sourceBody = (await sourceRes.json()) as any;
  assert.equal(sourceBody.code, 0, JSON.stringify(sourceBody));
  const sourceId = sourceBody.data.sourceId as string;
  const draftRes = await request(
    'presentations_outline',
    { sourceIds: [sourceId] },
    token,
    `${key}-outline`
  );
  const draftBody = (await draftRes.json()) as any;
  assert.equal(draftBody.code, 0, JSON.stringify(draftBody));
  const confirmedRes = await request(
    'presentations_outline_confirm',
    { outlineId: draftBody.data.outlineId },
    token,
    `${key}-confirm`
  );
  const confirmedBody = (await confirmedRes.json()) as any;
  assert.equal(confirmedBody.code, 0, JSON.stringify(confirmedBody));
  const pages = confirmedBody.data.pages as { pageNo: number }[];
  return generate(
    {
      sourceIds: [sourceId],
      outlineId: confirmedBody.data.outlineId,
      nSlides: pages.length,
      ...extra,
    },
    token,
    key
  );
}

async function download(id: string, token: string) {
  const handlers = downloadRoute.options.server!.handlers as {
    GET: (context: { request: Request }) => Promise<Response>;
  };
  return handlers.GET({
    request: new Request(
      `http://localhost/api/admin/agent/presentations/download?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
  });
}

async function latestJob() {
  const rows = await db()
    .select()
    .from(schema.presentationJob)
    .orderBy(desc(schema.presentationJob.createdAt))
    .limit(1);
  return rows[0];
}

async function waitForJob(
  id: string,
  status: string,
  timeoutMs = 5000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await presentationsService.getJob(id);
    if (job?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not reach ${status} in ${timeoutMs}ms`);
}

test('generate validates input: nSlides over 50 and empty materials rejected', async () => {
  const over = await generate(
    { content: 'x', nSlides: 51 },
    ownerToken,
    'ppt-validate-1'
  );
  assert.equal(over.response.status, 400);

  const empty = await generate({}, ownerToken, 'ppt-validate-2');
  assert.equal(empty.response.status, 400);
  assert.match(
    empty.body.message,
    /content, files, postSlugs, or a confirmed outline/
  );

  // Service-level: decoded files over 1.5 MB are rejected before any upload.
  assert.throws(
    () =>
      presentationsService.validateGenerateInput({
        mode: 'standard',
        files: [
          {
            name: 'big.txt',
            mime: 'text/plain',
            base64: Buffer.alloc(1_600_000).toString('base64'),
          },
        ],
      }),
    /exceeds 1500000 bytes/
  );
});

test('P0: standard 无 outline 被拒（单页也不例外）；smart+显式 template 被拒', async () => {
  // nSlides>1 且无 outlineId：standard 模式拒绝，指明先走 outline。
  const multi = await generate(
    { content: '多页主题内容', nSlides: 6 },
    ownerToken,
    'ppt-p0-1'
  );
  assert.equal(multi.response.status, 400);
  assert.match(multi.body.message, /presentations_outline/);

  // nSlides 不传时默认多页：同样拒绝。
  const noSlides = await generate(
    { content: '多页主题内容' },
    ownerToken,
    'ppt-p0-2'
  );
  assert.equal(noSlides.response.status, 400);
  assert.match(noSlides.body.message, /presentations_outline/);

  // 单页 standard 也须先确认 1 页 outline：免 outline 的口子已收掉。
  const single = await generate(
    { content: '单页主题', nSlides: 1 },
    ownerToken,
    'ppt-p0-3'
  );
  assert.equal(single.response.status, 400);
  assert.match(single.body.message, /presentations_outline/);

  // smart + 显式 template：拒绝，不静默转 standard。
  const smartTpl = await generate(
    { content: '快讯', mode: 'smart', template: 'sysmex' },
    ownerToken,
    'ppt-p0-4'
  );
  assert.equal(smartTpl.response.status, 400);
  assert.match(smartTpl.body.message, /smart 模式不支持模板/);

  // smart 不传 template：不受影响，放行。
  const smartNoTpl = await generate(
    { content: '快讯', mode: 'smart' },
    ownerToken,
    'ppt-p0-5'
  );
  assert.equal(smartNoTpl.response.status, 200);
  assert.equal(smartNoTpl.body.code, 0);
});

test('P0: 标题只取首个有效标题行并截断，不塞整段提示', () => {
  const { sanitizeDeckTitle } = presentationsService;
  // Markdown 标题行优先。
  assert.equal(sanitizeDeckTitle('# 半年总结\n正文内容'), '半年总结');
  // 单行长提示：截断到 40 字，尾部不再出现。
  const long =
    '2026企业大学上半年总结与下半年计划 汇报人：企业大学项目组 2026年11月 概述：复盘2026年4—10月';
  const title = sanitizeDeckTitle(long);
  assert.ok(title.length <= 40, title);
  assert.ok(title.startsWith('2026企业大学上半年总结与下半年计划'));
  assert.ok(!title.includes('概述'));
  // 空行跳过，取首个非空行。
  assert.equal(sanitizeDeckTitle('  \n\n  第二行标题  '), '第二行标题');
  assert.equal(sanitizeDeckTitle(''), '');
  assert.equal(sanitizeDeckTitle(null), '');
});

test('generate creates a job; only the owner can read it', async () => {
  const { response, body } = await generateStandardWithOutline(
    'Test deck topic',
    ownerToken,
    'ppt-owner-1'
  );
  assert.equal(response.status, 200);
  assert.equal(body.code, 0);
  const jobId = body.data.jobId as string;
  assert.equal(body.data.status, 'generating');

  const ownerGet = await request(
    'presentations_get',
    { id: jobId },
    ownerToken
  );
  assert.equal(ownerGet.status, 200);
  assert.equal(((await ownerGet.json()) as any).data.jobId, jobId);

  // The other agent holds presentations.read but did not create this job.
  const otherGet = await request(
    'presentations_get',
    { id: jobId },
    otherToken
  );
  assert.equal(otherGet.status, 404);
  assert.match(((await otherGet.json()) as any).message, /not found/i);

  // And it cannot generate at all without the generate permission.
  const denied = await generate({ content: 'x' }, otherToken, 'ppt-owner-2');
  assert.equal(denied.response.status, 403);
});

test('completed job returns a download URL; download streams the pptx to the owner only', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  const { body } = await generateStandardWithOutline(
    'Download test',
    ownerToken,
    'ppt-download-1'
  );
  const jobId = body.data.jobId as string;

  // First poll: still generating; second poll: Presenton reports completed.
  const first = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(
    (((await first.json()) as any).data as any).status,
    'generating'
  );
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.status, 200);
  const data = ((await got.json()) as any).data;
  assert.equal(data.status, 'completed');
  assert.equal(data.slideCount, 1);
  assert.equal(data.title, 'Test Deck');
  assert.equal(
    data.downloadUrl,
    `http://localhost:3000/api/admin/agent/presentations/download?id=${jobId}`
  );
  assert.ok(!('edit_path' in data) && !('exportPath' in data));

  const file = await download(jobId, ownerToken);
  assert.equal(file.status, 200);
  assert.equal(
    file.headers.get('Content-Type'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PPTX_BYTES);

  const foreign = await download(jobId, otherToken);
  assert.equal(foreign.status, 404);
});

test('completed job downloadUrl is absolute and carries the /wiki app base when APP_BASE_PATH is set', async () => {
  // Regression: a relative /api/... download URL leaves an MCP agent
  // unable to link the file — it ends up asking the user for the site
  // address instead of sending a clickable link. The MCP handler must
  // return a complete URL (origin from VITE_APP_URL + app base).
  const prev = process.env.APP_BASE_PATH;
  process.env.APP_BASE_PATH = '/wiki';
  try {
    stub.mode = 'pending-then-completed';
    stub.statusCalls = 0;
    const { body } = await generateStandardWithOutline(
      'Base path MCP deck',
      ownerToken,
      'ppt-download-base-1'
    );
    const jobId = body.data.jobId as string;
    // First poll: still generating; second poll: Presenton reports completed.
    const first = await request('presentations_get', { id: jobId }, ownerToken);
    assert.equal(
      (((await first.json()) as any).data as any).status,
      'generating'
    );
    const got = await request('presentations_get', { id: jobId }, ownerToken);
    const data = ((await got.json()) as any).data;
    assert.equal(data.status, 'completed');
    assert.equal(
      data.downloadUrl,
      `http://localhost:3000/wiki/api/admin/agent/presentations/download?id=${jobId}`
    );
  } finally {
    if (prev === undefined) delete process.env.APP_BASE_PATH;
    else process.env.APP_BASE_PATH = prev;
  }
});

test('postSlugs resolve server-side and files upload through Presenton', async () => {
  // postSlugs + 文件的解析在 assembleContent 里，与模式无关；standard
  // 一律须带 outline（outline 分支不走 postSlugs），本用例改走 smart。
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.calls = [];
  const { response, body } = await generate(
    {
      postSlugs: ['test-post'],
      nSlides: 1,
      mode: 'smart',
      files: [
        {
          name: 'note.txt',
          mime: 'text/plain',
          base64: Buffer.from('hello').toString('base64'),
        },
      ],
    },
    ownerToken,
    'ppt-slug-1'
  );
  assert.equal(response.status, 200);
  const jobId = body.data.jobId as string;
  const job = await presentationsService.getJob(jobId);
  assert.equal(job?.title, 'Test Post Title');
  const upload = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/files/mcp-upload')
  );
  assert.ok(upload, 'expected an mcp-upload call');
  const createCall = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/create')
  );
  assert.ok(createCall, 'expected a smart create call');
  const createBody = JSON.parse(createCall.body);
  // smart 的 /create 接口不接受 template；用户文件 note.txt 是唯一上传。
  assert.equal(createBody.template, undefined);
  assert.deepEqual(createBody.file_paths, ['/tmp/presenton/test/x.txt']);
  const uploads = stub.calls.filter((c) =>
    c.url.endsWith('/api/v1/ppt/files/mcp-upload')
  );
  assert.equal(uploads.length, 1);
  assert.equal(JSON.parse(uploads[0].body).files[0].filename, 'note.txt');
  assert.match(createBody.content, /Test Post Title/);
  assert.match(createBody.content, /Post body used as PPT source material/);
});

test('Magpie quota failure surfaces as llm_quota_exceeded, not a generic 500', async () => {
  stub.mode = 'error-quota';
  stub.statusCalls = 0;
  const { body } = await generateStandardWithOutline(
    'Quota test',
    ownerToken,
    'ppt-quota-1'
  );
  const jobId = body.data.jobId as string;
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.status, 200);
  const data = ((await got.json()) as any).data;
  assert.equal(data.status, 'failed');
  assert.equal(data.errorCode, 'llm_quota_exceeded');
  assert.match(data.error, /llm_quota_exceeded/);
});

test('smart mode completes through the SSE stream', async () => {
  stub.mode = 'pending-then-completed';
  const { response, body } = await generate(
    { content: 'Smart test', nSlides: 1, mode: 'smart' },
    ownerToken,
    'ppt-smart-1'
  );
  assert.equal(response.status, 200);
  const jobId = body.data.jobId as string;
  await waitForJob(jobId, 'completed');
  const job = await presentationsService.getJob(jobId);
  assert.equal(job?.status, 'completed');
  assert.equal(job?.slideCount, 1);
  assert.equal(job?.exportPath, '/app_data/exports/smart.pptx');
});

test('transient 401 on smart create is retried once and the job completes', async () => {
  stub.mode = 'pending-then-completed';
  stub.createFail = '401-once';
  stub.createCalls = 0;
  const { response, body } = await generate(
    { content: 'Retry test', nSlides: 1, mode: 'smart' },
    ownerToken,
    'ppt-retry-401'
  );
  assert.equal(response.status, 200);
  const jobId = body.data.jobId as string;
  await waitForJob(jobId, 'completed');
  assert.equal(stub.createCalls, 2);
  stub.createFail = 'none';
});

test('non-retryable 400 on smart create fails the job without a retry', async () => {
  stub.createFail = '400';
  stub.createCalls = 0;
  const { response } = await generate(
    { content: 'Bad request test', nSlides: 1, mode: 'smart' },
    ownerToken,
    'ppt-retry-400'
  );
  // Start-phase failures surface the error directly (no job id in the reply).
  assert.equal(response.status, 502);
  assert.equal(stub.createCalls, 1);
  const job = await latestJob();
  assert.equal(job?.status, 'failed');
  assert.equal(job?.errorCode, 'presenton_error');
  stub.createFail = 'none';
});

test('quota 429 on smart create is not retried and surfaces llm_quota_exceeded', async () => {
  stub.createFail = 'quota-429';
  stub.createCalls = 0;
  const { response, body } = await generate(
    { content: 'Quota create test', nSlides: 1, mode: 'smart' },
    ownerToken,
    'ppt-retry-quota'
  );
  assert.equal(response.status, 429);
  assert.match(body.message, /llm_quota_exceeded/);
  assert.equal(stub.createCalls, 1);
  const job = await latestJob();
  assert.equal(job?.status, 'failed');
  assert.equal(job?.errorCode, 'llm_quota_exceeded');
  stub.createFail = 'none';
});

test('dropped connection on standard start is retried once', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.asyncThrowOnce = true;
  stub.asyncCalls = 0;
  const { response, body } = await generateStandardWithOutline(
    'Network retry test',
    ownerToken,
    'ppt-retry-network'
  );
  assert.equal(response.status, 200);
  const jobId = body.data.jobId as string;
  await waitForJob(jobId, 'generating');
  assert.equal(stub.asyncCalls, 2);
  stub.asyncThrowOnce = false;
});

test('stage0: generation injects the single-source theme block and records themeVersion', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.calls = [];
  const { body } = await generateStandardWithOutline(
    'Theme injection test',
    ownerToken,
    'ppt-theme-1',
    { instructions: 'User instruction here' }
  );
  const jobId = body.data.jobId as string;
  const asyncCall = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/generate/async')
  );
  assert.ok(asyncCall, 'expected a generate/async call');
  const asyncBody = JSON.parse(asyncCall.body);
  // 用户自填的 instructions 在前，主题块在后；主题块含全部 8 色与 Logo 位（模板内嵌）。
  assert.match(asyncBody.instructions, /User instruction here/);
  assert.match(asyncBody.instructions, /#2F5597/);
  assert.match(asyncBody.instructions, /#003266/);
  assert.match(asyncBody.instructions, /#F7F9FC/);
  assert.match(asyncBody.instructions, /Logo 已嵌在 sysmex 模板右上角/);
  assert.match(asyncBody.instructions, new RegExp(PPT_THEME_VERSION));
  // 标题页开关：单页 outline 默认不保留标题页，指令块与参数一致。
  assert.match(asyncBody.instructions, /【标题页要求】不要做封面/);
  assert.equal(asyncBody.include_title_slide, false);
  const job = await presentationsService.getJob(jobId);
  assert.equal(job?.themeVersion, PPT_THEME_VERSION);
  // MCP 查询回 themeVersion；smart 模式同样带主题块。
  stub.calls = [];
  const smart = await generate(
    { content: 'Theme smart test', nSlides: 1, mode: 'smart' },
    ownerToken,
    'ppt-theme-2'
  );
  const smartJobId = (smart.body as any).data.jobId as string;
  await waitForJob(smartJobId, 'completed');
  const createCall = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/create')
  );
  assert.ok(createCall, 'expected a smart create call');
  assert.match(JSON.parse(createCall.body).instructions, /#2F5597/);
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(
    ((await got.json()) as any).data.themeVersion,
    PPT_THEME_VERSION
  );
});

test('stage0: downloaded pptx carries stamped element ids; elements listable per page', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.pptxBytes = buildFixturePptx(8);
  try {
    const { body } = await generateStandardWithOutline(
      'Stamp test',
      ownerToken,
      'ppt-stamp-1'
    );
    const jobId = body.data.jobId as string;
    await request('presentations_get', { id: jobId }, ownerToken);
    const got = await request('presentations_get', { id: jobId }, ownerToken);
    assert.equal(((await got.json()) as any).data.status, 'completed');

    const file = await download(jobId, ownerToken);
    assert.equal(file.status, 200);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.notDeepEqual(bytes, stub.pptxBytes);
    const index = buildElementIndex(bytes);
    assert.ok(index, 'downloaded pptx must be a stamped, parseable pptx');
    assert.equal(index!.pages.length, 2);
    assert.deepEqual(
      index!.pages[0].elements.map((e) => e.elementId),
      ['el-p1-1', 'el-p1-2', 'el-p1-3']
    );
    assert.deepEqual(
      index!.pages[1].elements.map((e) => e.elementId),
      ['el-p2-1', 'el-p2-2']
    );
    // 下载时索引已缓存到任务行；服务层按 ID 列出与缓存一致。
    // 注意：缓存的 name 是盖章前原名（Title），重读盖章后文件的 name 是
    // el-id；两者 ID/类型/文字一致，只比这些。
    const job = await presentationsService.getJob(jobId);
    const cached = parseElementIndex(job?.elementIndex);
    assert.ok(cached);
    const slim = (idx: {
      pages: {
        pageNo: number;
        elements: { elementId: string; type: string; text: string }[];
      }[];
    }) =>
      idx.pages.map((p) =>
        p.elements.map((e) => [e.elementId, e.type, e.text])
      );
    assert.deepEqual(slim(cached!), slim(index!));
    const listed = await presentationsService.listJobElements(job!);
    assert.deepEqual(slim(listed), slim(index!));

    // elements 路由：属主可查，非属主 404。
    const handlers = elementsRoute.options.server!.handlers as {
      GET: (context: { request: Request }) => Promise<Response>;
    };
    const mine = await handlers.GET({
      request: new Request(
        `http://localhost/api/ai-assistant/presentations/elements?id=${encodeURIComponent(jobId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      ),
    });
    assert.equal(mine.status, 200);
    const mineBody = (await mine.json()) as any;
    assert.equal(mineBody.data.pages.length, 2);
    assert.equal(mineBody.data.themeVersion, PPT_THEME_VERSION);
    // 路由有 200ms/ IP 的限流，两次调用之间等一下再调非属主。
    await new Promise((resolve) => setTimeout(resolve, 250));
    const foreign = await handlers.GET({
      request: new Request(
        `http://localhost/api/ai-assistant/presentations/elements?id=${encodeURIComponent(jobId)}`,
        { headers: { Authorization: `Bearer ${otherToken}` } }
      ),
    });
    assert.equal(foreign.status, 404);
  } finally {
    stub.pptxBytes = PPTX_BYTES;
  }
});

// ─── 导航＋意图优化 ────────────────────────────────────────────────────────

test('标题页开关：多页默认保留、单页默认不保留，显式值优先', async () => {
  // 两主题文本 → 2 页 outline：默认保留标题页。
  stub.calls = [];
  const multi = await generateStandardWithOutline(
    '# 主题甲\n甲要点一内容详细描述。\n甲要点二内容详细描述。\n\n# 主题乙\n乙要点一内容详细描述。\n乙要点二内容详细描述。\n',
    ownerToken,
    'ppt-title-1'
  );
  assert.equal(multi.response.status, 200);
  const multiAsync = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/generate/async')
  );
  assert.ok(multiAsync, 'expected a generate/async call');
  const multiBody = JSON.parse(multiAsync.body);
  assert.equal(multiBody.include_title_slide, true);
  assert.match(multiBody.instructions, /【标题页要求】保留标题页/);

  // 单页 outline + 显式 titlePage=true：覆盖默认。
  stub.calls = [];
  const singleKeep = await generateStandardWithOutline(
    '单页主题内容',
    ownerToken,
    'ppt-title-2',
    { titlePage: true }
  );
  assert.equal(singleKeep.response.status, 200);
  const keepAsync = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/generate/async')
  );
  assert.ok(keepAsync, 'expected a generate/async call');
  assert.equal(JSON.parse(keepAsync.body).include_title_slide, true);
  assert.match(
    JSON.parse(keepAsync.body).instructions,
    /【标题页要求】保留标题页/
  );

  // 多页 outline + 显式 titlePage=false：覆盖默认。
  stub.calls = [];
  const multiNone = await generateStandardWithOutline(
    '# 主题甲\n甲要点一内容详细描述。\n甲要点二内容详细描述。\n\n# 主题乙\n乙要点一内容详细描述。\n乙要点二内容详细描述。\n',
    ownerToken,
    'ppt-title-3',
    { titlePage: false }
  );
  assert.equal(multiNone.response.status, 200);
  const noneAsync = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/generate/async')
  );
  assert.ok(noneAsync, 'expected a generate/async call');
  assert.equal(JSON.parse(noneAsync.body).include_title_slide, false);
  assert.match(
    JSON.parse(noneAsync.body).instructions,
    /【标题页要求】不要做封面/
  );
});

test('生成后校验：页数不符重试一次，仍不符置失败并说明原因', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.asyncCalls = 0;
  // 2 页 outline，但桩 Presenton 只出 1 页（pres-1 固定 1 条 slide）。
  const { body } = await generateStandardWithOutline(
    '# 主题甲\n甲要点一内容详细描述。\n甲要点二内容详细描述。\n\n# 主题乙\n乙要点一内容详细描述。\n乙要点二内容详细描述。\n',
    ownerToken,
    'ppt-validate-count-1'
  );
  const jobId = body.data.jobId as string;
  // 第 1 次轮询：pending；第 2 次：completed 但页数不符 → 重试一次；
  // 第 3 次：completed 仍不符 → 置失败。
  const first = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(
    (((await first.json()) as any).data as any).status,
    'generating'
  );
  const second = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(
    (((await second.json()) as any).data as any).status,
    'generating'
  );
  assert.equal(stub.asyncCalls, 2, 'expected exactly one retry');
  const third = await request('presentations_get', { id: jobId }, ownerToken);
  const data = ((await third.json()) as any).data;
  assert.equal(data.status, 'failed');
  assert.match(data.error, /生成页数 1 页与要求的 2 页不符/);
  assert.match(data.error, /已重试 1 次/);
  assert.equal(stub.asyncCalls, 2, 'no second retry after the failure');
});

test('生成后校验：不要标题页时首頁仍是标题页则重试一次仍不符置失败', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.asyncCalls = 0;
  stub.presentationSlides = [{ id: 's1', layout: 'title_intro' }];
  try {
    const { body } = await generateStandardWithOutline(
      '单页主题内容',
      ownerToken,
      'ppt-validate-title-1',
      { titlePage: false }
    );
    const jobId = body.data.jobId as string;
    await request('presentations_get', { id: jobId }, ownerToken);
    const second = await request(
      'presentations_get',
      { id: jobId },
      ownerToken
    );
    assert.equal(
      (((await second.json()) as any).data as any).status,
      'generating'
    );
    assert.equal(stub.asyncCalls, 2, 'expected exactly one retry');
    const third = await request('presentations_get', { id: jobId }, ownerToken);
    const data = ((await third.json()) as any).data;
    assert.equal(data.status, 'failed');
    assert.match(data.error, /第 1 页仍是标题页/);
  } finally {
    stub.presentationSlides = null;
  }
});

test('生成后校验：保留标题页且首頁为 title 版式时正常完成', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.presentationSlides = [
    { id: 's1', layout: 'title_description_image' },
  ];
  try {
    const { body } = await generateStandardWithOutline(
      '单页主题内容',
      ownerToken,
      'ppt-validate-title-2',
      { titlePage: true }
    );
    const jobId = body.data.jobId as string;
    await request('presentations_get', { id: jobId }, ownerToken);
    const got = await request('presentations_get', { id: jobId }, ownerToken);
    const data = ((await got.json()) as any).data;
    assert.equal(data.status, 'completed');
    assert.equal(data.slideCount, 1);
  } finally {
    stub.presentationSlides = null;
  }
});

test('generation_meta 解析：结构不对返回 null', async () => {
  const { parseGenerationMeta } = await import(
    '../src/modules/presentations/job-meta'
  );
  const valid = {
    expectedSlides: 2,
    titlePage: true,
    retries: 0,
    resume: {
      content: 'x',
      nSlides: 2,
      language: 'Chinese',
      template: 'sysmex',
      mode: 'standard',
      instructions: 'y',
      filePaths: [],
    },
  };
  const parsed = parseGenerationMeta(JSON.stringify(valid));
  assert.ok(parsed);
  assert.equal(parsed!.expectedSlides, 2);
  assert.equal(parsed!.titlePage, true);
  assert.equal(parsed!.resume.mode, 'standard');
  assert.equal(parseGenerationMeta('not json'), null);
  assert.equal(parseGenerationMeta(''), null);
  assert.equal(parseGenerationMeta(null), null);
  assert.equal(
    parseGenerationMeta(JSON.stringify({ ...valid, expectedSlides: 0 })),
    null
  );
  assert.equal(
    parseGenerationMeta(JSON.stringify({ ...valid, retries: -1 })),
    null
  );
  assert.equal(
    parseGenerationMeta(
      JSON.stringify({ ...valid, resume: { ...valid.resume, mode: 'x' } })
    ),
    null
  );
  assert.equal(
    parseGenerationMeta(
      JSON.stringify({
        ...valid,
        resume: { ...valid.resume, filePaths: 'nope' },
      })
    ),
    null
  );
});
