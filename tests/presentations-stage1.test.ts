import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { eq } from 'drizzle-orm';

// 阶段 1（内容源 + 图片库 + 超时告警）：与 tests/presentations.test.ts
// 同款隔离库 + 桩 Presenton。端到端实测口径见实施清单能力一/二验收标准；
// 本文件覆盖：来源登记/校验（25MB 边界、空抽取、字数上限、权限过滤）、
// outline 生成与确认、图片检索/上传/槽位映射/裁切规则、超时日志字段。

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-ppt-stage1-test-'));
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
const { runAdminRoute, findOperation } =
  await import('../src/server/admin/execute');
const { buildFixturePptx } = await import('./pptx-fixture');
const sources = await import('../src/modules/presentations/sources');
const images = await import('../src/modules/presentations/images');
const { Route: sourcesRoute } =
  await import('../src/routes/api/ai-assistant/presentations/sources');
const XLSX = await import('xlsx');

// --- Fixture builders -------------------------------------------------------

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

/** 最小 zip（STORE），与 tests/pptx-fixture.ts 同款写法。 */
function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, entry.data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc32(entry.data), 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += 30 + nameBuf.length + entry.data.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
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

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf(lines: string[]): Buffer {
  const content = lines
    .map(
      (line, i) =>
        `BT /F1 12 Tf 72 ${720 - i * 20} Td (${escapePdfText(line)}) Tj ET`
    )
    .join('\n');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'utf-8')];
  const offsets: number[] = [0];
  let pos = parts[0].length;
  objects.forEach((obj, i) => {
    const buf = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'utf-8');
    offsets.push(pos);
    parts.push(buf);
    pos += buf.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++)
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  parts.push(Buffer.from(xref, 'utf-8'));
  return Buffer.concat(parts);
}

function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        'utf-8'
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        'utf-8'
      ),
    },
  ]);
}

function makeXlsx(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function slideXml(paragraphs: string[]): string {
  const ps = paragraphs
    .map(
      (p) =>
        `<a:p><a:r><a:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a:t></a:r></a:p>`
    )
    .join('');
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

function makePptx(slides: string[][], themeColors: string[] = []): Buffer {
  const entries: { name: string; data: Buffer }[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
        'utf-8'
      ),
    },
    {
      name: 'ppt/presentation.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
        'utf-8'
      ),
    },
  ];
  slides.forEach((paras, i) => {
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: Buffer.from(slideXml(paras), 'utf-8'),
    });
  });
  if (themeColors.length > 0) {
    const scheme = themeColors
      .map(
        (c, i) =>
          `<a:accent${i + 1}><a:srgbClr val="${c.replace('#', '')}"/></a:accent${i + 1}>`
      )
      .join('');
    entries.push({
      name: 'ppt/theme/theme1.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements><a:clrScheme name="s"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${scheme}</a:clrScheme></a:themeElements></a:theme>`,
        'utf-8'
      ),
    });
  }
  return zipStore(entries);
}

// --- Stubbed Presenton -------------------------------------------------------
const stub = {
  mode: 'pending-then-completed' as 'pending-then-completed' | 'pending',
  statusCalls: 0,
  uploadCalls: [] as Array<{ name: string; base64: string }>,
  lastGenerateBody: '',
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
    stub.uploadCalls.push(
      ...parsed.files.map((f) => ({
        name: f.filename,
        base64: f.content_base64,
      }))
    );
    return json({
      file_paths: parsed.files.map((f) => `/uploads/${f.filename}`),
    });
  }
  if (url.endsWith('/api/v1/ppt/presentation/generate/async')) {
    stub.lastGenerateBody = body;
    return json({
      id: 'task-1',
      status: 'pending',
      data: { presentation_id: 'pres-1' },
    });
  }
  if (url.includes('/api/v1/ppt/presentation/status/')) {
    stub.statusCalls += 1;
    if (stub.mode === 'pending' || stub.statusCalls === 1)
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
    const bytes = buildFixturePptx(8);
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
let otherAgentId: string;
let keyCounter = 0;

function clearRateLimits() {
  (globalThis as any).__minIntervalRateLimitStore?.clear();
}

async function request(
  operation: string,
  input: Record<string, unknown>,
  token: string
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
  const response = await runAdminRoute(operation, {
    request: new Request(url, {
      method: definition.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `stage1-${++keyCounter}`,
      },
      ...(query ? {} : { body: JSON.stringify(body) }),
    }),
    ...(definition.path.includes('{id}')
      ? { params: { id: String(input.id) } }
      : {}),
  });
  return { response, body: (await response.json()) as any };
}

const owner = { userId: '', tokenId: null as string | null };
const other = { userId: '', tokenId: null as string | null };

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
      // other 有 generate 权限，但无权查看 owner 的 self 文档/草稿/上传图：
      // 本文件的“无权”测的是内容可见性，不是操作权限。
      { id: 'rp-gen2', roleId: 'role-other', permissionId: 'perm-gen' },
      { id: 'rp-read2', roleId: 'role-other', permissionId: 'perm-read' },
    ]);
  const ownerAgent = await access.createAgent({
    name: 'PPT owner agent',
    roleIds: ['role-owner'],
    operatorPermissions: ['*'],
  });
  ownerAgentId = ownerAgent.id;
  owner.userId = ownerAgentId;
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
  otherAgentId = otherAgent.id;
  other.userId = otherAgentId;
  otherToken = (
    await access.createAgentKey({
      agentId: otherAgent.id,
      name: 'Other',
      expiresAt: null,
    })
  ).token;
  await db()
    .insert(schema.post)
    .values([
      {
        id: 'post-kb-pub',
        slug: 'kb-pub',
        type: 'article',
        title: '带教培训手册',
        content: '带教培训第一章：导师职责与学员成长路径。',
        status: 'published',
        userId: ownerAgentId,
      },
      {
        id: 'post-kb-draft',
        slug: 'kb-draft',
        type: 'article',
        title: '带教草稿',
        content: '带教草稿内容培训机密。',
        status: 'draft',
        userId: ownerAgentId,
      },
      {
        id: 'post-kb-long',
        slug: 'kb-long',
        type: 'article',
        title: '销售培训要点',
        content:
          '销售培训第二章：客户沟通技巧与异议处理方法，包含开场白、需求挖掘、方案呈现、成交促成四个环节的详细说明与演练要点。',
        status: 'published',
        userId: ownerAgentId,
      },
      {
        id: 'post-cover',
        slug: 'cover-post',
        type: 'article',
        title: '封面文章',
        content: '封面文章正文。',
        image: '/uploads/seed-cover.png',
        status: 'published',
        userId: ownerAgentId,
      },
    ]);
  // blog_html 文档（本地后端：表 + 磁盘文件）。
  await db()
    .insert(schema.blogHtmlFile)
    .values([
      {
        key: 'html/kb-doc.html',
        title: '知识库文档',
        description: '培训手册文档',
        category: '未分类',
        keywords: '培训,手册',
        visibility: 'all',
        uploaderId: ownerAgentId,
        uploaderEmployeeNo: '',
        sha256: 'x',
        size: 10,
      },
      {
        key: 'html/self-doc.html',
        title: '私人文档培训',
        description: '私人培训文档',
        category: '未分类',
        keywords: '培训',
        visibility: 'self',
        uploaderId: ownerAgentId,
        uploaderEmployeeNo: '',
        sha256: 'x',
        size: 10,
      },
    ]);
  await mkdir(join(process.cwd(), 'public', 'uploads'), { recursive: true });
  await writeFile(
    join(process.cwd(), 'public', 'uploads', 'seed-cover.png'),
    makePng(800, 600)
  );
  await writeFile(
    join(process.cwd(), 'public', 'uploads', 'seed-html.png'),
    makePng(200, 150)
  );
  await writeFile(
    join(process.cwd(), 'public', 'uploads', 'seed-self.png'),
    makePng(100, 100)
  );
  await mkdir(join(process.cwd(), 'data', 'blog-html'), { recursive: true });
  await writeFile(
    join(process.cwd(), 'data', 'blog-html', 'kb-doc.html'),
    '<html><body><h1>知识库文档</h1><p>培训手册正文内容。</p><img src="/uploads/seed-html.png"></body></html>'
  );
  await writeFile(
    join(process.cwd(), 'data', 'blog-html', 'self-doc.html'),
    '<html><body><p>私人培训内容</p><img src="/uploads/seed-self.png"></body></html>'
  );
});

after(async () => {
  for (const f of ['seed-cover.png', 'seed-html.png', 'seed-self.png']) {
    await rm(join(process.cwd(), 'public', 'uploads', f), { force: true });
  }
  for (const f of ['kb-doc.html', 'self-doc.html']) {
    await rm(join(process.cwd(), 'data', 'blog-html', f), { force: true });
  }
  await rm(directory, { recursive: true, force: true });
});

// --- 内容源：上传文件 ---------------------------------------------------------

test('source_add upload_text: pdf / docx / xlsx 各抽出文字', async () => {
  const pdf = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'handbook.pdf',
        mime: 'application/pdf',
        base64: makePdf([
          'PDF training content first sentence.',
          'Second point line.',
        ]).toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(pdf.response.status, 200, JSON.stringify(pdf.body));
  assert.equal(pdf.body.code, 0);
  assert.equal(pdf.body.data.status, 'ready');
  assert.ok(pdf.body.data.extractChars > 0);
  const [row] = await db()
    .select()
    .from(schema.presentationSource)
    .where(eq(schema.presentationSource.id, pdf.body.data.sourceId));
  assert.match(row.text ?? '', /PDF training content first sentence/);

  const docx = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'notes.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        base64: makeDocx(['DOCX 培训内容第一句。']).toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(docx.body.code, 0);
  const [docxRow] = await db()
    .select()
    .from(schema.presentationSource)
    .where(eq(schema.presentationSource.id, docx.body.data.sourceId));
  assert.match(docxRow.text ?? '', /DOCX 培训内容第一句/);

  const xlsx = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'data.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        base64: makeXlsx([
          ['培训', '内容'],
          ['XLSX 培训内容第一句', '第二列'],
        ]).toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(xlsx.body.code, 0);
  const [xlsxRow] = await db()
    .select()
    .from(schema.presentationSource)
    .where(eq(schema.presentationSource.id, xlsx.body.data.sourceId));
  assert.match(xlsxRow.text ?? '', /XLSX 培训内容第一句/);
});

test('source_add upload_text: 空文件记 empty，超 8000 字明确报错', async () => {
  const empty = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'empty.txt',
        mime: 'text/plain',
        base64: Buffer.from('   \n  ', 'utf-8').toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(empty.body.code, 0);
  assert.equal(empty.body.data.status, 'empty');
  const outline = await request(
    'presentations_outline',
    { sourceIds: [empty.body.data.sourceId] },
    ownerToken
  );
  assert.equal(outline.body.code, -1);
  assert.match(outline.body.message, /empty/);

  const big = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name: 'big.txt',
        mime: 'text/plain',
        base64: Buffer.from('字'.repeat(8001), 'utf-8').toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(big.body.code, -1);
  assert.match(big.body.message, /8000/);
  assert.match(big.body.message, /big\.txt/);
});

test('source_add reference_ppt: 逐页抽文字与标题，页序与原稿一致', async () => {
  const res = await request(
    'presentations_source_add',
    {
      kind: 'reference_ppt',
      use: 'content',
      file: {
        name: 'ref.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        base64: makePptx([
          ['原稿第一页标题', '第一页要点一', '第一页要点二'],
          ['原稿第二页标题', '第二页要点一'],
        ]).toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  assert.equal(res.body.data.pageCount, 2);
  assert.deepEqual(
    res.body.data.slides.map((s: any) => s.title),
    ['原稿第一页标题', '原稿第二页标题']
  );
  const outline = await request(
    'presentations_outline',
    { sourceIds: [res.body.data.sourceId] },
    ownerToken
  );
  assert.equal(outline.body.code, 0, JSON.stringify(outline.body));
  assert.equal(outline.body.data.pages.length, 2);
  assert.equal(outline.body.data.pages[0].title, '原稿第一页标题');
  assert.equal(outline.body.data.pages[1].title, '原稿第二页标题');
  assert.equal(outline.body.data.pages[0].sources[0].locator, '原稿第 1 页');
});

test('source_add reference_ppt: 超 25MB 拒绝并提示转 PDF 或图片', async () => {
  await assert.rejects(
    sources.registerReferencePpt(
      owner,
      { name: 'huge.pptx', bytes: Buffer.alloc(26 * 1024 * 1024) },
      'content'
    ),
    (e: any) => {
      assert.match(e.message, /25MB/);
      assert.match(e.message, /转 PDF/);
      assert.match(e.message, /转图片/);
      return true;
    }
  );
});

test('source_add reference_ppt: style 用途抽主题色，outline 注明以既定主题为准', async () => {
  const res = await request(
    'presentations_source_add',
    {
      kind: 'reference_ppt',
      use: 'style',
      file: {
        name: 'style.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        base64: makePptx(
          [['样式页标题', '样式要点']],
          ['#112233', '#445566']
        ).toString('base64'),
      },
    },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  assert.ok(res.body.data.themeColors.includes('#112233'));
  // 纯版式参考不产生内容页：单独做 outline 应明确无可用来源。
  const outline = await request(
    'presentations_outline',
    { sourceIds: [res.body.data.sourceId] },
    ownerToken
  );
  assert.equal(outline.body.code, -1);
  assert.match(outline.body.message, /无可用来源/);
});

// --- 内容源：知识库 -----------------------------------------------------------

test('wiki_kb: 只命中已发布内容，草稿与无权文档不进清单', async () => {
  const asOwner = await request(
    'presentations_source_add',
    { kind: 'wiki_kb', keyword: '培训' },
    ownerToken
  );
  assert.equal(asOwner.body.code, 0, JSON.stringify(asOwner.body));
  const ownerHits = asOwner.body.data.hits as Array<any>;
  assert.ok(ownerHits.some((h) => h.refId === 'post-kb-pub'));
  assert.ok(!ownerHits.some((h) => h.refId === 'post-kb-draft'));
  // 本人的 self 文档可见。
  assert.ok(ownerHits.some((h) => h.refId === 'html/self-doc.html'));

  const asOther = await request(
    'presentations_source_add',
    { kind: 'wiki_kb', keyword: '培训' },
    otherToken
  );
  assert.equal(asOther.body.code, 0);
  const otherHits = asOther.body.data.hits as Array<any>;
  assert.ok(otherHits.some((h) => h.refId === 'post-kb-pub'));
  assert.ok(!otherHits.some((h) => h.refId === 'post-kb-draft'));
  // 他人的 self 文档不可见。
  assert.ok(!otherHits.some((h) => h.refId === 'html/self-doc.html'));
});

test('wiki_kb: 无命中回“无可用来源”，勾选草稿登记被拒绝', async () => {
  const none = await request(
    'presentations_source_add',
    { kind: 'wiki_kb', keyword: '不存在的主题词xyz' },
    ownerToken
  );
  assert.equal(none.body.code, 0);
  assert.deepEqual(none.body.data.hits, []);
  assert.match(none.body.data.message, /无可用来源/);

  const draft = await request(
    'presentations_source_add',
    {
      kind: 'wiki_kb',
      postIds: [{ refType: 'post', refId: 'post-kb-draft' }],
    },
    ownerToken
  );
  assert.equal(draft.body.code, -1);
  assert.match(draft.body.message, /不存在/);

  const ok = await request(
    'presentations_source_add',
    {
      kind: 'wiki_kb',
      postIds: [{ refType: 'post', refId: 'post-kb-pub' }],
    },
    ownerToken
  );
  assert.equal(ok.body.code, 0, JSON.stringify(ok.body));
  assert.equal(ok.body.data.kind, 'wiki_kb');
  const [row] = await db()
    .select()
    .from(schema.presentationSource)
    .where(eq(schema.presentationSource.id, ok.body.data.sourceId));
  assert.match(row.text ?? '', /带教培训第一章/);
});

// --- Outline 与生成 -----------------------------------------------------------

async function registerText(
  name: string,
  text: string,
  token: string = ownerToken
): Promise<string> {
  const res = await request(
    'presentations_source_add',
    {
      kind: 'upload_text',
      file: {
        name,
        mime: 'text/plain',
        base64: Buffer.from(text, 'utf-8').toString('base64'),
      },
    },
    token
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  return res.body.data.sourceId as string;
}

async function confirmAndGenerate(
  sourceIds: string[],
  extra: Record<string, unknown> = {},
  token: string = ownerToken
) {
  const draft = await request('presentations_outline', { sourceIds }, token);
  assert.equal(draft.body.code, 0, JSON.stringify(draft.body));
  const confirmed = await request(
    'presentations_outline_confirm',
    { outlineId: draft.body.data.outlineId },
    token
  );
  assert.equal(confirmed.body.code, 0, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.status, 'confirmed');
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  stub.uploadCalls = [];
  stub.lastGenerateBody = '';
  const gen = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds,
      outlineId: confirmed.body.data.outlineId,
      ...extra,
    },
    token
  );
  assert.equal(gen.body.code, 0, JSON.stringify(gen.body));
  const jobId = gen.body.data.jobId as string;
  await request('presentations_get', { id: jobId }, token);
  const got = await request('presentations_get', { id: jobId }, token);
  assert.equal(got.body.data.status, 'completed', JSON.stringify(got.body));
  return { jobId, outline: confirmed.body.data, got: got.body.data };
}

test('outline: 多主题材料先出草稿，确认后成稿页数与划分一致', async () => {
  const sourceId = await registerText(
    'multi.txt',
    '# 主题甲\n甲要点一内容详细描述。\n甲要点二内容详细描述。\n\n# 主题乙\n乙要点一内容详细描述。\n乙要点二内容详细描述。\n'
  );
  const draft = await request(
    'presentations_outline',
    { sourceIds: [sourceId] },
    ownerToken
  );
  assert.equal(draft.body.code, 0, JSON.stringify(draft.body));
  assert.equal(draft.body.data.pages.length, 2);
  assert.deepEqual(
    draft.body.data.pages.map((p: any) => p.title),
    ['主题甲', '主题乙']
  );
  assert.ok(
    draft.body.data.pages.every((p: any) => p.layout && p.layoutReason)
  );
  const { jobId, got } = await confirmAndGenerate([sourceId]);
  assert.equal(got.sourceMode, 'sourced');
  assert.equal(got.layoutAssignments.length, 2);
  assert.equal(got.pageSourceRefs.length, 2);
  assert.equal(got.pageSourceRefs[0].sources[0].sourceId, sourceId);
  // 下发内容只含来源文字：逐页要点均可在来源文本中找到。
  assert.match(stub.lastGenerateBody, /主题甲/);
  assert.match(stub.lastGenerateBody, /甲要点一内容详细描述/);
  assert.match(stub.lastGenerateBody, /主题乙/);
  const jobRow = await db()
    .select()
    .from(schema.presentationJob)
    .where(eq(schema.presentationJob.id, jobId))
    .limit(1);
  assert.ok(jobRow[0].pageSourceRefs);
  assert.ok(jobRow[0].layoutAssignments);
});

test('outline: 确认时可改版式，成稿按确认版执行', async () => {
  const sourceId = await registerText(
    'adj.txt',
    '# 可调主题\n要点一内容详细描述。\n要点二内容详细描述。\n'
  );
  const draft = await request(
    'presentations_outline',
    { sourceIds: [sourceId] },
    ownerToken
  );
  const pages = draft.body.data.pages as Array<any>;
  pages[0].layout = 'E';
  pages[0].layoutReason = '用户指定：上图下文';
  const confirmed = await request(
    'presentations_outline_confirm',
    { outlineId: draft.body.data.outlineId, pages },
    ownerToken
  );
  assert.equal(confirmed.body.code, 0);
  assert.equal(confirmed.body.data.version, 2);
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  const gen = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds: [sourceId],
      outlineId: confirmed.body.data.outlineId,
    },
    ownerToken
  );
  assert.equal(gen.body.code, 0);
  const jobId = gen.body.data.jobId as string;
  await request('presentations_get', { id: jobId }, ownerToken);
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.body.data.layoutAssignments[0].layout, 'E');
});

test('generate: 有来源无 outline 被拒绝；无来源标注 unsourced', async () => {
  const sourceId = await registerText(
    'solo.txt',
    '#  solo\n要点内容详细描述。\n'
  );
  const noOutline = await request(
    'presentations_generate',
    { mode: 'standard', sourceIds: [sourceId] },
    ownerToken
  );
  assert.equal(noOutline.body.code, -1);
  assert.match(noOutline.body.message, /presentations_outline/);

  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  const plain = await request(
    'presentations_generate',
    { mode: 'standard', content: '纯提示词成稿主题' },
    ownerToken
  );
  assert.equal(plain.body.code, 0, JSON.stringify(plain.body));
  const jobId = plain.body.data.jobId as string;
  await request('presentations_get', { id: jobId }, ownerToken);
  const got = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(got.body.data.sourceMode, 'unsourced');
});

test('outline: 上传优先于知识库，知识库只作补充且分开标注', async () => {
  const uploadId = await registerText(
    'up.txt',
    '# 销售培训\n上传文件里的销售培训要点内容详细描述。\n'
  );
  const kb = await request(
    'presentations_source_add',
    {
      kind: 'wiki_kb',
      postIds: [{ refType: 'post', refId: 'post-kb-long' }],
    },
    ownerToken
  );
  const kbId = kb.body.data.sourceId as string;
  const draft = await request(
    'presentations_outline',
    { sourceIds: [kbId, uploadId] },
    ownerToken
  );
  assert.equal(draft.body.code, 0, JSON.stringify(draft.body));
  const pages = draft.body.data.pages as Array<any>;
  assert.equal(pages[0].primaryKind, 'upload_text');
  const kbPage = pages.find((p: any) => p.primaryKind === 'wiki_kb');
  assert.ok(kbPage);
  assert.equal(kbPage.note, '知识库补充');
});

// --- 图片库 -------------------------------------------------------------------

async function uploadImage(
  name: string,
  width: number,
  height: number,
  sourceType: 'upload' | 'paste' = 'upload',
  token: string = ownerToken
): Promise<string> {
  const res = await request(
    'presentations_image_upload',
    {
      file: {
        name,
        mime: 'image/png',
        base64: makePng(width, height).toString('base64'),
      },
      sourceType,
    },
    token
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  return res.body.data.imageId as string;
}

test('image_upload: 上传与粘贴截图返回宽高；search 按文件名/标签/来源筛选', async () => {
  const id = await uploadImage('team-photo.png', 800, 600, 'upload');
  const res = await request(
    'presentations_image_search',
    { q: 'team-photo' },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  const hit = (res.body.data.items as Array<any>).find((i) => i.imageId === id);
  assert.ok(hit);
  assert.equal(hit.width, 800);
  assert.equal(hit.height, 600);
  assert.equal(hit.sourceType, 'upload');
  assert.equal(hit.ownerId, ownerAgentId);

  const bySource = await request(
    'presentations_image_search',
    { sourceType: 'wiki_blog' },
    ownerToken
  );
  assert.ok(
    (bySource.body.data.items as Array<any>).some(
      (i) => i.imageId === 'blog:post-cover'
    )
  );
});

test('image_search: 无权账号看不到他人上传图，但看得到已发布文章配图', async () => {
  const id = await uploadImage('private-shot.png', 400, 300, 'upload');
  const asOther = await request(
    'presentations_image_search',
    { q: 'private-shot' },
    otherToken
  );
  assert.equal(asOther.body.code, 0);
  assert.ok(
    !(asOther.body.data.items as Array<any>).some((i) => i.imageId === id)
  );
  const blog = await request(
    'presentations_image_search',
    { q: 'cover-post' },
    otherToken
  );
  assert.ok(
    (blog.body.data.items as Array<any>).some(
      (i) => i.imageId === 'blog:post-cover'
    )
  );
  // 引用他人 image_id 生成被拒绝：用 other 自己的来源与 outline，
  // 只把 image_id 换成 owner 的上传图。
  const otherSourceId = await registerText(
    'imgx-other.txt',
    '# 图文\n要点内容详细描述。\n',
    otherToken
  );
  const otherDraft = await request(
    'presentations_outline',
    { sourceIds: [otherSourceId] },
    otherToken
  );
  const otherConfirmed = await request(
    'presentations_outline_confirm',
    { outlineId: otherDraft.body.data.outlineId },
    otherToken
  );
  const gen = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds: [otherSourceId],
      outlineId: otherConfirmed.body.data.outlineId,
      images: [{ imageId: id, pageNo: 1 }],
    },
    otherToken
  );
  assert.equal(gen.body.code, -1);
  assert.match(gen.body.message, /图片不存在/);
});

test('images: 指定槽位落位、默认槽位、low_res 标记与缺图页', async () => {
  const bigId = await uploadImage('big.png', 800, 600, 'upload');
  const tinyId = await uploadImage('tiny.png', 10, 10, 'paste');
  const sourceId = await registerText(
    'img-slots.txt',
    '# 左文右图页\n要点一内容详细描述。\n要点二内容详细描述。\n'
  );
  // 大图指定 main_image（B 版式），小图默认槽位。
  const { got } = await confirmAndGenerate([sourceId], {
    images: [
      { imageId: bigId, pageNo: 1, slotId: 'main_image' },
      { imageId: tinyId, pageNo: 1 },
    ],
  });
  const assignments = got.imageAssignments as Array<any>;
  assert.equal(assignments.length, 2);
  const main = assignments.find((a) => a.imageId === bigId);
  assert.equal(main.slotId, 'main_image');
  assert.equal(main.fitMode, 'cover');
  assert.equal(main.lowRes, false);
  const tiny = assignments.find((a) => a.imageId === tinyId);
  assert.equal(tiny.lowRes, true);
  // 两张图都经 mcp-upload 上了 Presenton（PNG 魔数可验）。
  assert.ok(stub.uploadCalls.length >= 2);
  for (const call of stub.uploadCalls) {
    const bytes = Buffer.from(call.base64, 'base64');
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
  }
  // 不给图时，第 1 页（B 版式有 main_image 槽）列明缺图。
  const { got: gotMissing } = await confirmAndGenerate([sourceId]);
  assert.deepEqual(gotMissing.missingImagePages, [1]);
  assert.match(gotMissing.missingImagesNote, /第 1 页缺图/);
});

test('images: 槽位校验与数量上限', async () => {
  const imgId = await uploadImage('slot.png', 800, 600, 'upload');
  const sourceId = await registerText(
    'slot-err.txt',
    '# 槽位页\n要点一内容详细描述。\n要点二内容详细描述。\n'
  );
  const draft = await request(
    'presentations_outline',
    { sourceIds: [sourceId] },
    ownerToken
  );
  const confirmed = await request(
    'presentations_outline_confirm',
    { outlineId: draft.body.data.outlineId },
    ownerToken
  );
  const outlineId = confirmed.body.data.outlineId as string;
  const badSlot = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds: [sourceId],
      outlineId,
      images: [{ imageId: imgId, pageNo: 1, slotId: 'header_title' }],
    },
    ownerToken
  );
  assert.equal(badSlot.body.code, -1);
  assert.match(badSlot.body.message, /不是图片槽位/);

  const six = [];
  for (let i = 0; i < 6; i++)
    six.push(await uploadImage(`n${i}.png`, 100, 100));
  const tooMany = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds: [sourceId],
      outlineId,
      images: six.map((imageId) => ({ imageId, pageNo: 1 })),
    },
    ownerToken
  );
  assert.equal(tooMany.body.code, -1);
  assert.match(tooMany.body.message, /Too big|最多引用 5 张图片/);

  const fourPastes = [];
  for (let i = 0; i < 4; i++)
    fourPastes.push(await uploadImage(`p${i}.png`, 100, 100, 'paste'));
  const tooManyPastes = await request(
    'presentations_generate',
    {
      mode: 'standard',
      sourceIds: [sourceId],
      outlineId,
      images: fourPastes.map((imageId) => ({ imageId, pageNo: 1 })),
    },
    ownerToken
  );
  assert.equal(tooManyPastes.body.code, -1);
  assert.match(tooManyPastes.body.message, /最多引用 3 张截图/);
});

test('images: 最近使用排序——用过的图排在前面', async () => {
  const first = await uploadImage('first-used.png', 100, 100, 'upload');
  const second = await uploadImage('second-unused.png', 100, 100, 'upload');
  const sourceId = await registerText(
    'recent.txt',
    '# 最近使用\n要点一内容详细描述。\n要点二内容详细描述。\n'
  );
  await confirmAndGenerate([sourceId], {
    images: [{ imageId: first, pageNo: 1 }],
  });
  const res = await request(
    'presentations_image_search',
    { sort: 'recent' },
    ownerToken
  );
  const ids = (res.body.data.items as Array<any>).map((i) => i.imageId);
  assert.ok(ids.indexOf(first) < ids.indexOf(second));
});

// --- 超时告警 -----------------------------------------------------------------

test('timeout: 超时任务置 generation_timeout，结构化日志字段齐全', async () => {
  stub.mode = 'pending';
  stub.statusCalls = 0;
  const gen = await request(
    'presentations_generate',
    { mode: 'standard', content: '超时测试主题' },
    ownerToken
  );
  assert.equal(gen.body.code, 0, JSON.stringify(gen.body));
  const jobId = gen.body.data.jobId as string;
  // 把受理时间拨回 11 分钟前，再轮询一次即触发超时判定。
  await db()
    .update(schema.presentationJob)
    .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(schema.presentationJob.id, jobId));
  const origError = console.error;
  const lines: string[] = [];
  console.error = (...args: any[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const got = await request('presentations_get', { id: jobId }, ownerToken);
    assert.equal(got.body.data.status, 'failed', JSON.stringify(got.body));
    assert.equal(got.body.data.errorCode, 'generation_timeout');
    assert.match(got.body.data.error, /timed out/);
  } finally {
    console.error = origError;
  }
  const timeoutLine = lines.find((l) =>
    l.includes('[presentations][generation_timeout]')
  );
  assert.ok(timeoutLine, `missing timeout log, got: ${lines.join('\n')}`);
  const logged = JSON.parse(
    timeoutLine!.slice(timeoutLine!.indexOf('{'))
  ) as Record<string, any>;
  assert.equal(logged.job_id, jobId);
  assert.ok(
    typeof logged.elapsed_ms === 'number' && logged.elapsed_ms > 600_000
  );
  assert.ok(typeof logged.prompt_chars === 'number' && logged.prompt_chars > 0);
  assert.equal(logged.prompt_length, logged.prompt_chars);
  assert.equal(logged.model, 'magpie (Presenton default)');
  assert.equal(logged.stage, 'polling');
  const [row] = await db()
    .select()
    .from(schema.presentationJob)
    .where(eq(schema.presentationJob.id, jobId))
    .limit(1);
  assert.equal(row.errorCode, 'generation_timeout');
});

// --- 页面 multipart 上传路由 ---------------------------------------------------

test('sources route: multipart 登记参考 PPT；25MB 以上拒绝', async () => {
  clearRateLimits();
  const handlers = sourcesRoute.options.server!.handlers as {
    POST: (context: { request: Request }) => Promise<Response>;
  };
  const form = new FormData();
  form.append('kind', 'reference_ppt');
  form.append(
    'file',
    new File(
      [makePptx([['路由页标题', '路由要点']]) as unknown as BlobPart],
      'route-ref.pptx',
      {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }
    )
  );
  const ok = await handlers.POST({
    request: new Request(
      'http://localhost/api/ai-assistant/presentations/sources',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: form,
      }
    ),
  });
  const okBody = (await ok.json()) as any;
  assert.equal(okBody.code, 0, JSON.stringify(okBody));
  assert.equal(okBody.data.kind, 'reference_ppt');
  assert.equal(okBody.data.pageCount, 1);

  clearRateLimits();
  const bigForm = new FormData();
  bigForm.append('kind', 'reference_ppt');
  bigForm.append(
    'file',
    new File(
      [Buffer.alloc(26 * 1024 * 1024) as unknown as BlobPart],
      'big.pptx',
      {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }
    )
  );
  const big = await handlers.POST({
    request: new Request(
      'http://localhost/api/ai-assistant/presentations/sources',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: bigForm,
      }
    ),
  });
  const bigBody = (await big.json()) as any;
  assert.equal(bigBody.code, -1);
  assert.match(bigBody.message, /25MB/);
  assert.match(bigBody.message, /转 PDF/);
});
