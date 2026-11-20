import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

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
const { runAdminRoute, findOperation } =
  await import('../src/server/admin/execute');
const { Route: downloadRoute } =
  await import('../src/routes/api/admin/agent/presentations/download');

const PPTX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fake-pptx-content'),
]);

// --- Stubbed Presenton -----------------------------------------------------
// Modes: status answers 'pending' once, then 'completed'; 'error-quota'
// answers a rate-limit failure; 'pending' never completes.
const stub = {
  mode: 'pending-then-completed' as
    | 'pending-then-completed'
    | 'error-quota'
    | 'pending',
  statusCalls: 0,
  calls: [] as { method: string; url: string; body: string }[],
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
  if (url.endsWith('/api/v1/ppt/presentation/generate/async'))
    return json({
      id: 'task-1',
      status: 'pending',
      data: {
        presentation_id: 'pres-1',
        created_slides: 0,
        remaining_slides: 1,
      },
    });
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
  if (url.endsWith('/api/v1/ppt/presentation/create'))
    return json({ id: 'pres-smart', title: 'Smart Deck' });
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
    return json({ id: 'pres-1', title: 'Test Deck', slides: [{ id: 's1' }] });
  if (url.endsWith('/app_data/exports/test.pptx'))
    return Promise.resolve(new Response(PPTX_BYTES as unknown as BodyInit));
  if (url.endsWith('/app_data/exports/smart.pptx'))
    return Promise.resolve(new Response(PPTX_BYTES as unknown as BodyInit));
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
  assert.match(empty.body.message, /content, files, or postSlugs/);

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

test('generate creates a job; only the owner can read it', async () => {
  const { response, body } = await generate(
    { content: 'Test deck topic', nSlides: 1 },
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
  const { body } = await generate(
    { content: 'Download test', nSlides: 1 },
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
    `/api/admin/agent/presentations/download?id=${jobId}`
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

test('postSlugs resolve server-side and files upload through Presenton', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.calls = [];
  const { response, body } = await generate(
    {
      postSlugs: ['test-post'],
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
  const asyncCall = stub.calls.find((c) =>
    c.url.endsWith('/api/v1/ppt/presentation/generate/async')
  );
  assert.ok(asyncCall, 'expected a generate/async call');
  const asyncBody = JSON.parse(asyncCall.body);
  assert.deepEqual(asyncBody.files, ['/tmp/presenton/test/x.txt']);
  assert.match(asyncBody.content, /Test Post Title/);
  assert.match(asyncBody.content, /Post body used as PPT source material/);
});

test('Magpie quota failure surfaces as llm_quota_exceeded, not a generic 500', async () => {
  stub.mode = 'error-quota';
  stub.statusCalls = 0;
  const { body } = await generate(
    { content: 'Quota test', nSlides: 1 },
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
