import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { eq } from 'drizzle-orm';

// 阶段 2（单页编辑）：与 tests/presentations-stage1.test.ts 同款隔离库 +
// 桩 Presenton。纯函数层（page-edit.ts 的 zip 手术与各 op 语义）直接测；
// 服务层（版本、回退、归属、旧稿拒绝）走 runAdminRoute 的 MCP 操作。
// 验收口径见实施清单能力三：口述改一页仅该页变、截图模式先出拟改动清
// 单、按版本号回退、非属主 404、旧稿明确拒绝。

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-ppt-stage2-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'stage2-test-secret-0123456789abcdef',
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
const { runAdminRoute, findOperation } =
  await import('../src/server/admin/execute');
const { buildFixturePptx } = await import('./pptx-fixture');
const pageEdit = await import('../src/modules/presentations/page-edit');
const elementIndex = await import('../src/modules/presentations/element-index');
const service = await import('../src/modules/presentations/service');

// --- Helpers ----------------------------------------------------------------

function crc32(buf: Buffer): number {
  let table = (crc32 as any)._table as Int32Array | undefined;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as any)._table = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      raw[y * (1 + width * 3) + 1 + x * 3] = 200;
      raw[y * (1 + width * 3) + 1 + x * 3 + 1] = 100;
      raw[y * (1 + width * 3) + 1 + x * 3 + 2] = 50;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(
      crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])),
      8 + data.length
    );
    return out;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 给夹具 zip 的每个条目置数据描述符标志（bit 3）：本实现最小 zip 解析
 * 器拒绝此类文件，模拟“解析不出的历史旧稿”。
 */
function withDataDescriptorFlag(pptx: Buffer): Buffer {
  const out = Buffer.from(pptx);
  // local 记录：从 0 起逐条走，flag 在 local header +6。
  let p = 0;
  while (p + 30 <= out.length && out.readUInt32LE(p) === 0x04034b50) {
    out.writeUInt16LE(out.readUInt16LE(p + 6) | 0x8, p + 6);
    const nameLen = out.readUInt16LE(p + 26);
    const extraLen = out.readUInt16LE(p + 28);
    const compLen = out.readUInt32LE(p + 18);
    p += 30 + nameLen + extraLen + compLen;
  }
  // 中央记录：flag 在 central header +8。
  while (p + 46 <= out.length && out.readUInt32LE(p) === 0x02014b50) {
    out.writeUInt16LE(out.readUInt16LE(p + 8) | 0x8, p + 8);
    const nameLen = out.readUInt16LE(p + 28);
    const extraLen = out.readUInt16LE(p + 30);
    const commentLen = out.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// --- Stubbed Presenton -------------------------------------------------------
const stub = {
  statusCalls: 0,
  /** 覆盖下载字节（旧稿测试用）；默认返回两页夹具。 */
  downloadBytes: null as Buffer | null,
};

function stubFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = typeof init?.body === 'string' ? init.body : '';
  const json = (data: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  if (url.endsWith('/api/v1/ppt/files/mcp-upload')) {
    const parsed = JSON.parse(body) as {
      files: Array<{ filename: string; content_base64: string }>;
    };
    return json({
      file_paths: parsed.files.map((f) => `/uploads/${f.filename}`),
    });
  }
  if (url.endsWith('/api/v1/ppt/presentation/generate/async')) {
    return json({
      id: 'task-1',
      status: 'pending',
      data: { presentation_id: 'pres-1' },
    });
  }
  if (url.includes('/api/v1/ppt/presentation/status/')) {
    stub.statusCalls += 1;
    if (stub.statusCalls === 1)
      return json({
        id: 'task-1',
        status: 'pending',
        data: { presentation_id: 'pres-1' },
      });
    return json({
      id: 'task-1',
      status: 'completed',
      data: {
        presentation_id: 'pres-1',
        path: '/app_data/exports/test.pptx',
      },
    });
  }
  if (url.includes('/api/v1/ppt/presentation/pres-1/export')) {
    return json({ path: '/app_data/exports/test.pptx' });
  }
  if (url.includes('/api/v1/ppt/presentation/pres-1')) {
    return json({ id: 'pres-1', title: 'Test Deck', slides: [{}, {}] });
  }
  if (url.includes('/app_data/exports/test.pptx')) {
    const bytes = stub.downloadBytes ?? buildFixturePptx(8);
    return Promise.resolve(
      new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    );
  }
  return json({ error: 'not stubbed' }, 404);
}

// --- Setup -------------------------------------------------------------------

let ownerToken: string;
let otherToken: string;
let ownerAgentId: string;

function clearRateLimits() {
  (globalThis as any).__minIntervalRateLimitStore?.clear();
}

let keyCounter = 0;

async function request(
  operation: string,
  input: Record<string, unknown>,
  token: string
) {
  clearRateLimits();
  const definition = findOperation(operation);
  const path = definition.path.replace('{id}', String(input.id ?? ''));
  const url = new URL(path, 'http://localhost');
  const body = { ...input };
  if (definition.path.includes('{id}')) delete body.id;
  const query = ['GET', 'DELETE'].includes(definition.method);
  if (query)
    for (const [key, value] of Object.entries(body))
      url.searchParams.set(key, String(value));
  const response = await runAdminRoute(operation, {
    request: new Request(url, {
      method: definition.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `stage2-${++keyCounter}`,
      },
      ...(query ? {} : { body: JSON.stringify(body) }),
    }),
    ...(definition.path.includes('{id}')
      ? { params: { id: String(input.id) } }
      : {}),
  });
  return { response, body: (await response.json()) as any };
}

/** 生成一套稿并轮询到 completed，返回 jobId。 */
async function makeCompletedJob(token: string): Promise<string> {
  const gen = await request(
    'presentations_generate',
    {
      content: '测试稿第一页标题\n第二页正文',
      mode: 'standard',
      nSlides: 1,
    },
    token
  );
  assert.equal(gen.body.code, 0, JSON.stringify(gen.body));
  const jobId = gen.body.data.jobId as string;
  await request('presentations_get', { id: jobId }, token);
  const got = await request('presentations_get', { id: jobId }, token);
  assert.equal(got.body.data.status, 'completed', JSON.stringify(got.body));
  return jobId;
}

async function getJobRow(jobId: string) {
  const [row] = await db()
    .select()
    .from(schema.presentationJob)
    .where(eq(schema.presentationJob.id, jobId));
  return row;
}

async function slideXml(jobId: string, pageNo: number): Promise<string> {
  const job = await getJobRow(jobId);
  const bytes = await service.downloadJobPptx(job);
  const entry = elementIndex.readZipEntry(
    bytes,
    `ppt/slides/slide${pageNo}.xml`
  );
  assert.ok(entry, `slide${pageNo} 应存在`);
  return entry.toString('utf-8');
}

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  await saveConfigs({
    presenton_base_url: 'http://presenton.test',
    presenton_api_key: 'test-key',
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
      { id: 'rp-gen2', roleId: 'role-other', permissionId: 'perm-gen' },
      { id: 'rp-read2', roleId: 'role-other', permissionId: 'perm-read' },
    ]);
  const ownerAgent = await access.createAgent({
    name: 'PPT owner agent',
    roleIds: ['role-owner'],
    operatorPermissions: ['*'],
  });
  ownerAgentId = ownerAgent.id;
  ownerToken = (
    await access.createAgentKey({
      agentId: ownerAgent.id,
      name: 'Owner',
      expiresAt: null,
    })
  ).token;
  const otherAgent = await access.createAgent({
    name: 'PPT other agent',
    roleIds: ['role-other'],
    operatorPermissions: ['*'],
  });
  otherToken = (
    await access.createAgentKey({
      agentId: otherAgent.id,
      name: 'Other',
      expiresAt: null,
    })
  ).token;
});

const uploadedPng = makePng(800, 600);
const uploadedPngMd5 = createHash('md5').update(uploadedPng).digest('hex');

after(async () => {
  await rm(join(process.cwd(), 'public', 'uploads', `${uploadedPngMd5}.png`), {
    force: true,
  });
  await rm(directory, { recursive: true, force: true });
});

// --- 纯函数：zip 手术与 op 语义 ----------------------------------------------

test('zip 手术：只改目标页，其余页解压后内容逐字节不变', async () => {
  const beforeBytes = buildFixturePptx(8);
  const out = pageEdit.applyPageOps(beforeBytes, 1, [
    { op: 'set_text', elementId: 'el-p1-1', text: '新标题' },
  ]);
  const beforeEntries = elementIndex.readZipEntries(beforeBytes)!;
  const afterEntries = elementIndex.readZipEntries(out.bytes)!;
  assert.equal(afterEntries.length, beforeEntries.length);
  for (const entry of beforeEntries) {
    const after = afterEntries.find((e) => e.name === entry.name)!;
    if (entry.name === 'ppt/slides/slide1.xml') {
      assert.ok(!after.data.equals(entry.data), '目标页应变化');
      assert.match(after.data.toString('utf-8'), /新标题/);
    } else {
      assert.ok(after.data.equals(entry.data), `${entry.name} 应逐字节不变`);
    }
  }
});

test('set_text 只改文字：不动位置与样式（无 rPr、无 xfrm 增改）', async () => {
  const beforeBytes = buildFixturePptx(8);
  const out = pageEdit.applyPageOps(beforeBytes, 1, [
    { op: 'set_text', elementId: 'el-p1-1', text: '新标题' },
  ]);
  const xml = elementIndex
    .readZipEntry(out.bytes, 'ppt/slides/slide1.xml')!
    .toString('utf-8');
  assert.match(xml, /新标题/);
  assert.doesNotMatch(xml, /Hello Title/);
  assert.doesNotMatch(xml, /<a:rPr/, 'set_text 不应写入样式');
  assert.match(xml, /<p:spPr\/>/, '空 spPr 应原样保留');
});

test('set_style：主题色通过；非主题色无声明拒绝、有声明通过；越界字号拒绝', async () => {
  const pptx = buildFixturePptx(8);
  const ok = pageEdit.applyPageOps(pptx, 1, [
    {
      op: 'set_style',
      elementId: 'el-p1-1',
      color: '#27AE60',
      fontSizePt: 28,
      bold: true,
      align: 'center',
    },
  ]);
  const xml = elementIndex
    .readZipEntry(ok.bytes, 'ppt/slides/slide1.xml')!
    .toString('utf-8');
  assert.match(xml, /val="27AE60"/);
  assert.match(xml, /sz="2800"/);
  assert.match(xml, /b="1"/);
  assert.match(xml, /algn="ctr"/);
  assert.throws(
    () =>
      pageEdit.applyPageOps(pptx, 1, [
        { op: 'set_style', elementId: 'el-p1-1', color: '#123456' },
      ]),
    /不在主题色板中/
  );
  const explicit = pageEdit.applyPageOps(pptx, 1, [
    {
      op: 'set_style',
      elementId: 'el-p1-1',
      color: '#123456',
      explicitColor: true,
    },
  ]);
  assert.match(
    elementIndex
      .readZipEntry(explicit.bytes, 'ppt/slides/slide1.xml')!
      .toString('utf-8'),
    /val="123456"/
  );
  assert.throws(
    () =>
      pageEdit.applyPageOps(pptx, 1, [
        { op: 'set_style', elementId: 'el-p1-1', fontSizePt: 200 },
      ]),
    /字号须在 6–100pt 之间/
  );
});

test('set_style：无文字形状改填充色；对无文字元素改字号拒绝', async () => {
  const pptx = buildFixturePptx(8);
  const out = pageEdit.applyPageOps(pptx, 2, [
    { op: 'set_style', elementId: 'el-p2-2', color: '#ED7D31' },
  ]);
  const xml = elementIndex
    .readZipEntry(out.bytes, 'ppt/slides/slide2.xml')!
    .toString('utf-8');
  assert.match(xml, /val="ED7D31"/);
  assert.throws(
    () =>
      pageEdit.applyPageOps(pptx, 2, [
        { op: 'set_style', elementId: 'el-p2-2', fontSizePt: 20 },
      ]),
    /没有文字/
  );
});

test('move/resize：界内改 off/ext；越界报错不改文件', async () => {
  const pptx = buildFixturePptx(8);
  const out = pageEdit.applyPageOps(pptx, 1, [
    {
      op: 'move',
      elementId: 'el-p1-2',
      rectIn: { x: 7.6, y: 1.85, width: 5.43, height: 2.89 },
    },
  ]);
  const xml = elementIndex
    .readZipEntry(out.bytes, 'ppt/slides/slide1.xml')!
    .toString('utf-8');
  assert.match(xml, new RegExp(`x="${Math.round(7.6 * 914400)}"`));
  assert.throws(
    () =>
      pageEdit.applyPageOps(pptx, 1, [
        {
          op: 'move',
          elementId: 'el-p1-2',
          rectIn: { x: 12, y: 1, width: 5.43, height: 2.89 },
        },
      ]),
    /越界/
  );
  assert.throws(
    () =>
      pageEdit.applyPageOps(pptx, 1, [
        {
          op: 'resize',
          elementId: 'el-p1-2',
          rectIn: { x: 0, y: 0, width: 20, height: 2 },
        },
      ]),
    /越界/
  );
});

test('replace_image：换图落新 media、rels 与 Content_Types 同步更新', async () => {
  const pptx = buildFixturePptx(8);
  const out = pageEdit.applyPageOps(pptx, 1, [
    {
      op: 'replace_image',
      elementId: 'el-p1-2',
      image: { bytes: uploadedPng, ext: 'png', width: 800, height: 600 },
    },
  ]);
  const media = elementIndex.readZipEntry(out.bytes, 'ppt/media/image1.png');
  assert.ok(media, '新 media 应存在');
  assert.ok(media.equals(uploadedPng), '新 media 字节应与上传图一致');
  const rels = elementIndex
    .readZipEntry(out.bytes, 'ppt/slides/_rels/slide1.xml.rels')!
    .toString('utf-8');
  assert.match(rels, /Target="\.\.\/media\/image1\.png"/);
  const ct = elementIndex
    .readZipEntry(out.bytes, '[Content_Types].xml')!
    .toString('utf-8');
  assert.match(ct, /Extension="png" ContentType="image\/png"/);
  const slide2Before = elementIndex
    .readZipEntry(pptx, 'ppt/slides/slide2.xml')!
    .toString('utf-8');
  const slide2After = elementIndex
    .readZipEntry(out.bytes, 'ppt/slides/slide2.xml')!
    .toString('utf-8');
  assert.equal(slide2After, slide2Before, '其余页不变');
});

test('add/delete：新增元素可定位、删除后索引更新', async () => {
  const pptx = buildFixturePptx(8);
  const added = pageEdit.applyPageOps(pptx, 2, [
    {
      op: 'add_element',
      kind: 'text',
      text: '补充说明',
      rectIn: { x: 0.5, y: 6, width: 5, height: 0.8 },
    },
  ]);
  const view = pageEdit.getPageElements(added.bytes, 2);
  assert.equal(view.elements.length, 3);
  assert.equal(view.elements[2].elementId, 'el-p2-3');
  assert.equal(view.elements[2].text, '补充说明');
  const deleted = pageEdit.applyPageOps(added.bytes, 2, [
    { op: 'delete_element', elementId: 'el-p2-2' },
  ]);
  const view2 = pageEdit.getPageElements(deleted.bytes, 2);
  assert.equal(view2.elements.length, 2);
  assert.equal(view2.elements[1].elementId, 'el-p2-2');
  assert.equal(view2.elements[1].text, '补充说明');
});

test('getPageElements：未盖章旧稿 editable=false，盖章后 true', async () => {
  const raw = buildFixturePptx(8);
  assert.equal(pageEdit.getPageElements(raw, 1).editable, false);
  const stamped = elementIndex.stampElementIds(raw)!;
  assert.equal(pageEdit.getPageElements(stamped.bytes, 1).editable, true);
  assert.equal(
    pageEdit.getPageElements(stamped.bytes, 1).elements[0].elementId,
    'el-p1-1'
  );
});

// --- 服务层：page_get / page_edit / page_revert ------------------------------

test('page_get：返回元素清单与当前版本；口述定位不靠猜坐标', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const res = await request(
    'presentations_page_get',
    { jobId, pageNo: 1 },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  assert.equal(res.body.data.jobId, jobId);
  assert.equal(res.body.data.currentVersion, 0);
  assert.equal(res.body.data.editable, true);
  assert.equal(res.body.data.elements.length, 3);
  assert.equal(res.body.data.elements[0].elementId, 'el-p1-1');
  assert.equal(res.body.data.elements[0].type, 'text');
  assert.equal(res.body.data.elements[0].text, 'Hello Title');
  assert.equal(res.body.data.elements[1].type, 'image');
});

test('口述改一页：仅该页变化，其余页内容与版式不变', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const slide2Before = await slideXml(jobId, 2);
  const res = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [
        { op: 'set_text', elementId: 'el-p1-1', text: '企业大学新标题' },
        { op: 'set_style', elementId: 'el-p1-1', color: '#27AE60' },
      ],
    },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  assert.equal(res.body.data.executed, true);
  assert.equal(res.body.data.version, 1);
  assert.equal(res.body.data.applied.length, 2);
  assert.equal(res.body.data.pagePreview.rendered, false);
  assert.equal(res.body.data.pagePreview.elements[0].text, '企业大学新标题');
  assert.ok(
    res.body.data.downloadUrl.includes(
      '/api/admin/agent/presentations/download'
    )
  );
  const slide1After = await slideXml(jobId, 1);
  const slide2After = await slideXml(jobId, 2);
  assert.match(slide1After, /企业大学新标题/);
  assert.match(slide1After, /val="27AE60"/);
  assert.equal(slide2After, slide2Before, '第 2 页应逐字节不变');
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.body.data.currentVersion, 1);
});

test('截图模式：先收到拟改动清单，确认后改动与清单一致', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const up = await request(
    'presentations_image_upload',
    {
      file: {
        name: 'ref.png',
        mime: 'image/png',
        base64: uploadedPng.toString('base64'),
      },
      sourceType: 'paste',
    },
    ownerToken
  );
  assert.equal(up.body.code, 0, JSON.stringify(up.body));
  const imageId = up.body.data.imageId as string;
  const proposal = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [{ op: 'set_text', elementId: 'el-p1-1', text: '截图参考标题' }],
      referenceImageId: imageId,
    },
    ownerToken
  );
  assert.equal(proposal.body.code, 0, JSON.stringify(proposal.body));
  assert.equal(proposal.body.data.executed, false);
  assert.equal(proposal.body.data.requiresConfirmation, true);
  assert.equal(proposal.body.data.changes.length, 1);
  assert.match(proposal.body.data.changes[0].summary, /截图参考标题/);
  const rowsBefore = await db()
    .select()
    .from(schema.presentationPageVersion)
    .where(eq(schema.presentationPageVersion.jobId, jobId));
  assert.equal(rowsBefore.length, 0, '拟改动清单不应写版本');
  const confirmed = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [{ op: 'set_text', elementId: 'el-p1-1', text: '截图参考标题' }],
      referenceImageId: imageId,
      confirm: true,
    },
    ownerToken
  );
  assert.equal(confirmed.body.code, 0, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.executed, true);
  assert.equal(confirmed.body.data.version, 1);
  assert.match(await slideXml(jobId, 1), /截图参考标题/);
});

test('删除须先确认：未确认只出清单，确认后执行且可回退', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const originalBytes = await service.downloadJobPptx(await getJobRow(jobId));
  const proposal = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 2,
      ops: [{ op: 'delete_element', elementId: 'el-p2-2' }],
    },
    ownerToken
  );
  assert.equal(proposal.body.data.executed, false);
  assert.match(proposal.body.data.changes[0].summary, /删除元素/);
  const confirmed = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 2,
      ops: [{ op: 'delete_element', elementId: 'el-p2-2' }],
      confirm: true,
    },
    ownerToken
  );
  assert.equal(confirmed.body.data.version, 1);
  const afterDelete = await slideXml(jobId, 2);
  assert.doesNotMatch(afterDelete, /Rectangle 5/);
  const reverted = await request(
    'presentations_page_revert',
    { jobId, version: 0 },
    ownerToken
  );
  assert.equal(reverted.body.code, 0, JSON.stringify(reverted.body));
  assert.equal(reverted.body.data.version, 2);
  assert.equal(reverted.body.data.revertedTo, 0);
  const afterRevert = await service.downloadJobPptx(await getJobRow(jobId));
  assert.ok(
    afterRevert.equals(originalBytes),
    '回退到 0 后下载字节应与原稿一致'
  );
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.body.data.currentVersion, 2);
});

test('换图走 confirm 流程：新图落进该页图片，其余页不变', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const up = await request(
    'presentations_image_upload',
    {
      file: {
        name: 'newpic.png',
        mime: 'image/png',
        base64: uploadedPng.toString('base64'),
      },
      sourceType: 'upload',
    },
    ownerToken
  );
  const imageId = up.body.data.imageId as string;
  const slide2Before = await slideXml(jobId, 2);
  const proposal = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [{ op: 'replace_image', elementId: 'el-p1-2', imageId }],
    },
    ownerToken
  );
  assert.equal(proposal.body.data.executed, false);
  assert.equal(proposal.body.data.requiresConfirmation, true);
  const done = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [{ op: 'replace_image', elementId: 'el-p1-2', imageId }],
      confirm: true,
    },
    ownerToken
  );
  assert.equal(done.body.code, 0, JSON.stringify(done.body));
  assert.equal(done.body.data.version, 1);
  const bytes = await service.downloadJobPptx(await getJobRow(jobId));
  const media = elementIndex.readZipEntry(bytes, 'ppt/media/image1.png');
  assert.ok(media && media.equals(uploadedPng));
  assert.equal(await slideXml(jobId, 2), slide2Before);
});

test('非属主调用编辑接口返回 404，与查询、下载口径一致', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  for (const [op, input] of [
    ['presentations_page_get', { jobId, pageNo: 1 }],
    [
      'presentations_page_edit',
      {
        jobId,
        pageNo: 1,
        ops: [{ op: 'set_text', elementId: 'el-p1-1', text: 'x' }],
      },
    ],
    ['presentations_page_revert', { jobId, version: 0 }],
  ] as const) {
    const res = await request(op, input, otherToken);
    assert.equal(res.response.status, 404, `${op} 应返回 HTTP 404`);
    assert.match(res.body.message, /Presentation not found/);
  }
  const rows = await db()
    .select()
    .from(schema.presentationPageVersion)
    .where(eq(schema.presentationPageVersion.jobId, jobId));
  assert.equal(rows.length, 0, '非属主调用不应写版本');
});

test('旧稿拒绝：解析不出的稿子调用编辑，明确回不支持、不写版本', async () => {
  stub.downloadBytes = withDataDescriptorFlag(buildFixturePptx(8));
  try {
    const jobId = await makeCompletedJob(ownerToken);
    const res = await request(
      'presentations_page_edit',
      {
        jobId,
        pageNo: 1,
        ops: [{ op: 'set_text', elementId: 'el-p1-1', text: 'x' }],
      },
      ownerToken
    );
    assert.equal(res.response.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /旧稿不支持单页编辑/);
    const rows = await db()
      .select()
      .from(schema.presentationPageVersion)
      .where(eq(schema.presentationPageVersion.jobId, jobId));
    assert.equal(rows.length, 0, '旧稿拒绝不应写版本');
  } finally {
    stub.downloadBytes = null;
  }
});

test('move 越界与非主题色经 MCP 同样拒绝，不写版本', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const oob = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [
        {
          op: 'move',
          elementId: 'el-p1-2',
          rectIn: { x: 12, y: 1, width: 5.43, height: 2.89 },
        },
      ],
    },
    ownerToken
  );
  assert.equal(oob.response.status, 400, JSON.stringify(oob.body));
  assert.match(oob.body.message, /越界/);
  const color = await request(
    'presentations_page_edit',
    {
      jobId,
      pageNo: 1,
      ops: [{ op: 'set_style', elementId: 'el-p1-1', color: '#123456' }],
    },
    ownerToken
  );
  assert.equal(color.response.status, 400, JSON.stringify(color.body));
  assert.match(color.body.message, /不在主题色板中/);
  const rows = await db()
    .select()
    .from(schema.presentationPageVersion)
    .where(eq(schema.presentationPageVersion.jobId, jobId));
  assert.equal(rows.length, 0);
});
