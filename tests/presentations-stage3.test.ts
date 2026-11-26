import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { eq } from 'drizzle-orm';

// 阶段 3（图表与 Dashboard）：与 tests/presentations-stage2.test.ts 同款
// 隔离库 + 桩 Presenton。纯函数层（charts.ts 的校验/选型/标签语义/
// zip 手术）直接测；服务层（chart_add / chart_update / 生成时落图、
// 归属、缺数据拒绝）走 runAdminRoute 的 MCP 操作。
// 验收口径见实施清单能力四：原生图表可改数、四种标签显隐可切、
// Dashboard 卡图同源、不给数据明确拒绝、配色只用主题色板。

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-ppt-stage3-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${directory}/test.db`,
  AUTH_SECRET: 'stage3-test-secret-please-change-me-0123456789',
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
const charts = await import('../src/modules/presentations/charts');
const elementIndex = await import('../src/modules/presentations/element-index');
const service = await import('../src/modules/presentations/service');

// --- Helpers ----------------------------------------------------------------

const SAMPLE_DATA = {
  categories: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [
    { name: 'A区', values: [120, 150, 180, 200] },
    { name: 'B区', values: [90, 110, 130, 160] },
  ],
};
const RECT = { x: 0.5, y: 1.5, width: 6, height: 4 };

function chartXmlOf(bytes: Buffer, part = 'ppt/charts/chart1.xml'): string {
  const entry = elementIndex.readZipEntry(bytes, part);
  assert.ok(entry, `${part} 应存在`);
  return entry.toString('utf-8');
}

function slideXmlOf(bytes: Buffer, pageNo: number): string {
  const entry = elementIndex.readZipEntry(
    bytes,
    `ppt/slides/slide${pageNo}.xml`
  );
  assert.ok(entry, `slide${pageNo} 应存在`);
  return entry.toString('utf-8');
}

/** 最小 zip 写入（手写 xlsx 夹具用，与被测代码无关）。 */
function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 手写最小 xlsx（sharedStrings + sheet1，与实现无关的独立结构）。 */
function buildTestXlsx(): Buffer {
  const text = (s: string) => Buffer.from(s, 'utf-8');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  // sharedStrings: 0=A区 1=B区 2=Q1 3=Q2
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>A区</t></si><si><t>B区</t></si><si><t>Q1</t></si><si><t>Q2</t></si></sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120</v></c><c r="C2"><v>90</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>150</v></c><c r="C3"><v>110</v></c></row></sheetData></worksheet>`;
  return zipStore([
    { name: '[Content_Types].xml', data: text(contentTypes) },
    { name: '_rels/.rels', data: text(rels) },
    { name: 'xl/workbook.xml', data: text(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheet) },
    { name: 'xl/sharedStrings.xml', data: text(sharedStrings) },
  ]);
}

// --- Stubbed Presenton (同 stage2) ------------------------------------------

const stub = {
  statusCalls: 0,
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
let ownerUserId: string;
let ownerTokenId: string | null;

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
        'Idempotency-Key': `stage3-${++keyCounter}`,
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

async function downloadBytes(jobId: string): Promise<Buffer> {
  const job = await getJobRow(jobId);
  return service.downloadJobPptx(job);
}

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  await saveConfigs({
    presenton_base_url: 'http://presenton.test',
    presenton_api_key: 'stage3-test-presenton-key',
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
  // 供生成时落图测试直接造任务行用的属主身份（从一次真实生成里取）。
  const probeJobId = await makeCompletedJob(ownerToken);
  const probe = await getJobRow(probeJobId);
  ownerUserId = probe.ownerUserId;
  ownerTokenId = probe.ownerTokenId;
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

// --- 纯函数：数据校验与来源 ────────────────────────────────────────────────

test('数据校验：无数据明确拒绝，不编示例数字', () => {
  assert.throws(() => charts.validateChartData(undefined), /缺数据/);
  assert.throws(() => charts.validateChartData(null), /缺数据/);
  assert.throws(
    () => charts.validateChartData({ categories: [], series: [] }),
    /缺数据/
  );
  assert.throws(
    () =>
      charts.validateChartData({
        categories: ['A'],
        series: [],
      }),
    /缺数据/
  );
  assert.throws(
    () =>
      charts.validateChartData({
        categories: ['A', 'B'],
        series: [{ name: 'S', values: [1] }],
      }),
    /值个数/
  );
  assert.throws(
    () =>
      charts.validateChartData({
        categories: ['A'],
        series: [{ name: 'S', values: [Number.NaN] }],
      }),
    /须为数字/
  );
  assert.throws(
    () =>
      charts.validateChartData({
        categories: ['A'],
        series: Array.from({ length: 9 }, (_, i) => ({
          name: `S${i}`,
          values: [1],
        })),
      }),
    /系列最多 8 个/
  );
});

test('类型自动选择：单系列少类目→饼图，时间类目→折线，多系列→柱状', () => {
  const pie = charts.autoChartType(
    charts.validateChartData({
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S', values: [10, 20, 30] }],
    })
  );
  assert.equal(pie.chartType, 'pie');
  const line = charts.autoChartType(
    charts.validateChartData({
      categories: ['2023', '2024', '2025', '2026'],
      series: [{ name: 'S', values: [10, 20, 30, 40] }],
    })
  );
  assert.equal(line.chartType, 'line');
  const bar = charts.autoChartType(charts.validateChartData(SAMPLE_DATA));
  assert.equal(bar.chartType, 'bar');
});

test('类型冲突：饼图多系列/负值硬拒；软冲突给建议、不静默换型', () => {
  const data = charts.validateChartData(SAMPLE_DATA);
  assert.throws(() => charts.checkTypeMismatch('pie', data), /只支持单个系列/);
  assert.throws(
    () =>
      charts.checkTypeMismatch(
        'pie',
        charts.validateChartData({
          categories: ['A', 'B'],
          series: [{ name: 'S', values: [10, -5] }],
        })
      ),
    /不支持负值/
  );
  const manyCats = charts.validateChartData({
    categories: Array.from({ length: 10 }, (_, i) => `C${i + 1}`),
    series: [{ name: 'S', values: Array(10).fill(5) }],
  });
  const mismatch = charts.checkTypeMismatch('pie', manyCats);
  assert.ok(mismatch);
  assert.equal(mismatch!.suggestedType, 'bar');
  const lineMismatch = charts.checkTypeMismatch(
    'line',
    charts.validateChartData({
      categories: ['A', 'B'],
      series: [{ name: 'S', values: [1, 2] }],
    })
  );
  assert.ok(lineMismatch);
  assert.equal(lineMismatch!.suggestedType, 'bar');
  assert.equal(charts.checkTypeMismatch('bar', data), null);
});

test('百分比口径：饼按总计合计 100%，柱按类目合计 100%', () => {
  const pieData = charts.validateChartData({
    categories: ['A', 'B', 'C'],
    series: [{ name: 'S', values: [10, 20, 30] }],
  });
  const piePct = charts.percentages(pieData, 'pie');
  assert.ok(Math.abs(piePct[0].reduce((a, b) => a + b, 0) - 100) < 1e-9);
  const barPct = charts.percentages(
    charts.validateChartData(SAMPLE_DATA),
    'bar'
  );
  for (let i = 0; i < 4; i++) {
    const sum = barPct[0][i] + barPct[1][i];
    assert.ok(Math.abs(sum - 100) < 1e-9, `类目 ${i} 百分比合计应为 100`);
  }
});

test('表格文件：csv 解析（表头+首列类目）；xlsx 解析（sharedStrings）', () => {
  const csv = charts.parseTableFile({
    name: 'data.csv',
    mime: 'text/csv',
    base64: Buffer.from('类别,A区,B区\nQ1,120,90\nQ2,150,110\n').toString(
      'base64'
    ),
  });
  assert.deepEqual(csv.categories, ['Q1', 'Q2']);
  assert.deepEqual(csv.series[0], { name: 'A区', values: [120, 150] });
  assert.deepEqual(csv.series[1], { name: 'B区', values: [90, 110] });
  assert.throws(
    () =>
      charts.parseTableFile({
        name: 'bad.csv',
        mime: 'text/csv',
        base64: Buffer.from('类别,A区\nQ1,abc\n').toString('base64'),
      }),
    /不是数字/
  );
  assert.throws(
    () =>
      charts.parseTableFile({
        name: 'data.txt',
        mime: 'text/plain',
        base64: Buffer.from('x').toString('base64'),
      }),
    /只接受 csv \/ xlsx/
  );
  const xlsx = charts.parseTableFile({
    name: 'data.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: buildTestXlsx().toString('base64'),
  });
  assert.deepEqual(xlsx.categories, ['Q1', 'Q2']);
  assert.deepEqual(xlsx.series[0], { name: 'A区', values: [120, 150] });
  assert.deepEqual(xlsx.series[1], { name: 'B区', values: [90, 110] });
});

test('内嵌工作簿：写出后读回与入参一致', () => {
  const data = charts.validateChartData(SAMPLE_DATA);
  const wb = charts.buildEmbeddedWorkbook(data);
  const back = charts.readWorkbookData(wb);
  assert.deepEqual(back, data);
});

// --- 纯函数：标签语义与配色 ────────────────────────────────────────────────

function specFor(
  valueLabels: charts.ValueLabels,
  chartType: charts.ChartType = 'bar'
): charts.ChartSpec {
  return {
    data: charts.validateChartData(SAMPLE_DATA),
    chartType,
    chartTypeAuto: false,
    valueLabels,
  };
}

test('四种 value_labels：只改标签层，坐标轴与数据引用不变', () => {
  const xmls = (
    ['show_all', 'hide_all', 'total_only', 'percent_only'] as const
  ).map((labels) => charts.buildChartXml(specFor(labels), 'rId1'));
  const axes = (xml: string) => {
    const catAx = /<c:catAx>.*?<\/c:catAx>/s.exec(xml)?.[0];
    const valAx = /<c:valAx>.*?<\/c:valAx>/s.exec(xml)?.[0];
    return { catAx, valAx };
  };
  const first = axes(xmls[0]);
  for (const xml of xmls.slice(1)) {
    assert.deepEqual(axes(xml), first, '坐标轴在四种标签模式下应完全相同');
    // 数据引用（numRef/strRef 的 f 与缓存）也不变。
    assert.ok(xml.includes('Sheet1!$B$2:$B$5'));
    assert.ok(xml.includes('<c:v>120</c:v>'));
  }
  assert.match(xmls[0], /<c:showVal val="1"\/>/);
  assert.match(xmls[0], /<c:showPercent val="0"\/>/);
  assert.doesNotMatch(xmls[1], /<c:showVal val="1"\/>/);
  assert.doesNotMatch(xmls[1], /<c:showPercent val="1"\/>/);
  assert.match(xmls[3], /<c:showPercent val="1"\/>/);
  assert.doesNotMatch(xmls[3], /<c:showVal val="1"\/>/);
  // total_only：逐点标签文本是类目合计（210/260/310/360），不是单值。
  assert.match(xmls[2], /<c:dLbl><c:idx val="0"\/><c:tx>/);
  for (const total of ['210', '260', '310', '360'])
    assert.ok(
      xmls[2].includes(`<a:t>${total}</a:t>`),
      `total_only 应含类目合计 ${total}`
    );
  // 饼图 total_only：单个逐点标签是总计 1140。
  const pieTotal = charts.buildChartXml(
    {
      data: charts.validateChartData({
        categories: ['A', 'B', 'C'],
        series: [{ name: 'S', values: [100, 200, 300] }],
      }),
      chartType: 'pie',
      chartTypeAuto: false,
      valueLabels: 'total_only',
    },
    'rId1'
  );
  assert.ok(pieTotal.includes('<a:t>600</a:t>'), '饼图 total_only 应含总计');
});

test('配色只用主题色板：系列颜色可区分且与图例一一对应', () => {
  const xml = charts.buildChartXml(specFor('show_all'), 'rId1');
  const colors = [...xml.matchAll(/<a:srgbClr val="([0-9A-F]{6})"\/>/g)].map(
    (m) => `#${m[1]}`
  );
  const theme = new Set(Object.values(charts.THEME_SERIES_COLORS));
  // 系列填充色（前两个 srgbClr 即两系列颜色，标题色在后）。
  const seriesColors = colors.slice(0, 2);
  assert.deepEqual(seriesColors, ['#2F5597', '#005B9F']);
  for (const c of colors) {
    assert.ok(
      theme.has(c) || c === '#FFFFFF',
      `颜色 ${c} 应在主题色板内（白字除外）`
    );
  }
  assert.ok(new Set(seriesColors).size === 2, '两系列颜色须可区分');
  assert.match(xml, /<c:legend>/, '须有图例');
  // 饼图：每片颜色不同（单系列数据，4 个类目 → 4 片）。
  const pieXml = charts.buildChartXml(
    {
      data: charts.validateChartData({
        categories: ['A', 'B', 'C', 'D'],
        series: [{ name: 'S', values: [10, 20, 30, 40] }],
      }),
      chartType: 'pie',
      chartTypeAuto: false,
      valueLabels: 'show_all',
    },
    'rId1'
  );
  const pieColors = [
    ...pieXml.matchAll(
      /<c:dPt><c:idx val="\d+"\/><c:spPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"/g
    ),
  ].map((m) => m[1]);
  assert.equal(pieColors.length, 4);
  assert.equal(new Set(pieColors).size, 4, '四片扇区颜色须各不相同');
});

// --- 纯函数：zip 手术 ───────────────────────────────────────────────────────

test('插入图表：原生 chart 部件 + 内嵌工作簿可读，其余页逐字节不变', () => {
  const beforeBytes = buildFixturePptx(8);
  const spec = specFor('show_all');
  const { bytes, elementId } = charts.insertChart(beforeBytes, 1, RECT, spec);
  assert.equal(elementId, 'el-p1-4');
  const index = elementIndex.buildElementIndex(bytes)!;
  const el = index.pages
    .find((p) => p.pageNo === 1)!
    .elements.find((e) => e.elementId === elementId);
  assert.equal(el?.type, 'chart');
  const wbEntry = elementIndex.readZipEntry(
    bytes,
    'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx'
  );
  assert.ok(wbEntry, '内嵌工作簿应存在');
  assert.deepEqual(charts.readWorkbookData(wbEntry), spec.data);
  const beforeEntries = elementIndex.readZipEntries(beforeBytes)!;
  const afterEntries = elementIndex.readZipEntries(bytes)!;
  for (const entry of beforeEntries) {
    const after = afterEntries.find((e) => e.name === entry.name)!;
    if (entry.name === 'ppt/slides/slide1.xml') {
      assert.ok(!after.data.equals(entry.data), '目标页应变化');
      assert.match(after.data.toString('utf-8'), /Hello Title/);
    } else if (
      entry.name === '[Content_Types].xml' ||
      entry.name === 'ppt/slides/_rels/slide1.xml.rels'
    ) {
      // Content_Types 与新建的 slide rels 是手术的附带改动（夹具原本
      // 没有 slide rels 文件），不计入“其余页不变”。
      continue;
    } else {
      assert.ok(after.data.equals(entry.data), `${entry.name} 应逐字节不变`);
    }
  }
});

test('更新图表：只改标签时 slide XML 不动、其余页不动、仅标签变', () => {
  const spec = specFor('show_all');
  const inserted = charts.insertChart(buildFixturePptx(8), 1, RECT, spec);
  const beforeSlide = slideXmlOf(inserted.bytes, 1);
  const beforeSlide2 = slideXmlOf(inserted.bytes, 2);
  const beforeChart = chartXmlOf(inserted.bytes);
  const updated = charts.updateChart(inserted.bytes, 1, inserted.elementId, {
    valueLabels: 'hide_all',
  });
  assert.equal(updated.valueLabels, 'hide_all');
  assert.equal(
    slideXmlOf(updated.bytes, 1),
    beforeSlide,
    '只改标签时 slide XML 应不动'
  );
  assert.equal(slideXmlOf(updated.bytes, 2), beforeSlide2, '第 2 页应不动');
  const afterChart = chartXmlOf(updated.bytes);
  assert.ok(afterChart.includes('<c:barChart'), '图表类型应仍是柱状');
  assert.ok(afterChart.includes('Sheet1!$B$2:$B$5'), '数据引用应不变');
  assert.doesNotMatch(afterChart, /<c:showVal val="1"\/>/);
  // 坐标轴子串不变。
  const axes = (xml: string) => /<c:catAx>.*?<\/c:valAx>/s.exec(xml)?.[0];
  assert.equal(axes(afterChart), axes(beforeChart));
});

test('更新图表：换数据改工作簿、换类型保数据；非图表元素拒绝', () => {
  const spec = specFor('show_all');
  const inserted = charts.insertChart(buildFixturePptx(8), 1, RECT, spec);
  const newData = charts.validateChartData({
    categories: ['X', 'Y'],
    series: [{ name: 'A区', values: [5, 7] }],
  });
  const updated = charts.updateChart(inserted.bytes, 1, inserted.elementId, {
    data: newData,
    chartType: 'line',
  });
  assert.equal(updated.chartType, 'line');
  const info = charts.readChartInfo(updated.bytes, 1, inserted.elementId);
  assert.deepEqual(info.data, newData);
  assert.equal(info.chartType, 'line');
  const xml = chartXmlOf(updated.bytes);
  assert.match(xml, /<c:lineChart>/);
  assert.doesNotMatch(xml, /<c:barChart>/);
  // 非图表元素（文本框 el-p1-1）拒绝。
  assert.throws(
    () =>
      charts.updateChart(inserted.bytes, 1, 'el-p1-1', {
        valueLabels: 'hide_all',
      }),
    /不是图表/
  );
  assert.throws(
    () =>
      charts.updateChart(inserted.bytes, 1, 'el-p1-99', {
        valueLabels: 'hide_all',
      }),
    /没有元素/
  );
});

test('数字卡：fromData 同源通过、错数拒绝、无出处拒绝', () => {
  const data = charts.validateChartData(SAMPLE_DATA);
  // 类目合计 Q1=210、系列合计 A区=650、总计=1140。
  charts.validateKpiCards(
    [
      { title: 'Q1合计', value: 210, fromData: { category: 'Q1', agg: 'sum' } },
      { title: 'A区合计', value: 650, fromData: { series: 'A区', agg: 'sum' } },
      { title: '总计', value: 1140, fromData: { agg: 'total' } },
      {
        title: '单值',
        value: 150,
        fromData: { series: 'A区', category: 'Q2', agg: 'value' },
      },
    ],
    data
  );
  assert.throws(
    () =>
      charts.validateKpiCards(
        [{ title: '错数', value: 999, fromData: { agg: 'total' } }],
        data
      ),
    /对不上/
  );
  assert.throws(
    () => charts.validateKpiCards([{ title: '无出处', value: 1140 }], data),
    /既不在同页图表数据里/
  );
  // 内容源背书的卡跳过算术比对（归属由 service 层校验）。
  charts.validateKpiCards(
    [
      {
        title: '引用数',
        value: 12345,
        pageSourceRefs: [
          { sourceId: 's1', sourceKind: 'upload_text', locator: 'p1' },
        ],
      },
    ],
    data
  );
  // 插入数字卡：深海军蓝底 + 白字 26pt，元素 id 续排。
  const inserted = charts.insertChart(
    buildFixturePptx(8),
    1,
    RECT,
    specFor('show_all')
  );
  const withCards = charts.insertKpiCards(inserted.bytes, 1, [
    {
      title: '总计',
      value: 1140,
      unit: '人',
      rectIn: { x: 7, y: 1.5, width: 2.6, height: 1.14 },
    },
  ]);
  assert.deepEqual(withCards.elementIds, ['el-p1-5']);
  const slideXml = slideXmlOf(withCards.bytes, 1);
  assert.match(slideXml, /val="003266"/, '数字卡底色应为深海军蓝');
  assert.match(slideXml, /sz="2600" b="1"/, '数字卡数值应为 26pt 加粗');
  assert.match(slideXml, /1,140 人/, '数字卡数值应带千分位与单位');
});

// --- MCP：chart_add / chart_update -------------------------------------------

const CHART_BODY = {
  chart: {
    categories: SAMPLE_DATA.categories,
    series: SAMPLE_DATA.series,
    chartType: 'bar',
    valueLabels: 'show_all',
  },
  rectIn: RECT,
};

test('MCP chart_add：原生图表落入、版本+1、下载可读出数据', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const res = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...CHART_BODY },
    ownerToken
  );
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  assert.equal(res.body.data.executed, true);
  assert.equal(res.body.data.version, 1);
  assert.equal(res.body.data.chartType, 'bar');
  assert.match(res.body.data.chartElementId, /^el-p1-\d+$/);
  assert.ok(
    res.body.data.pagePreview.elements.some(
      (e: any) =>
        e.elementId === res.body.data.chartElementId && e.type === 'chart'
    ),
    '改后单页预览应含图表元素'
  );
  const bytes = await downloadBytes(jobId);
  const info = charts.readChartInfo(bytes, 1, res.body.data.chartElementId);
  assert.equal(info.chartType, 'bar');
  assert.deepEqual(info.data, charts.validateChartData(SAMPLE_DATA));
  // 第 2 页未动：与原稿夹具的 slide2 一致。
  const slide2 = slideXmlOf(bytes, 2);
  assert.match(slide2, /Second page/);
});

test('MCP chart_add：非属主 404；无数据 400 缺数据；错页 400', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const other = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...CHART_BODY },
    otherToken
  );
  assert.equal(other.response.status, 404);
  const noData = await request(
    'presentations_chart_add',
    {
      jobId,
      pageNo: 1,
      rectIn: RECT,
      chart: { chartType: 'bar' },
    },
    ownerToken
  );
  assert.equal(noData.response.status, 400);
  assert.match(noData.body.message, /缺数据/);
  // 错页：稿只有 2 页，第 3 页不存在（zod 层 pageNo 上限 50，99 会先
  // 被 zod 拦下、到不了服务层，测服务层口径用 3）。
  const badPage = await request(
    'presentations_chart_add',
    { jobId, pageNo: 3, ...CHART_BODY },
    ownerToken
  );
  assert.equal(badPage.response.status, 400);
  assert.match(badPage.body.message, /不存在/);
  const row = await getJobRow(jobId);
  assert.equal(row.chartAssignments, null, '失败调用不应留下图表记录');
});

test('MCP chart_add：类型软冲突先给拟确认清单，confirm 后按指定执行', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const manyCats = {
    chart: {
      categories: Array.from({ length: 10 }, (_, i) => `C${i + 1}`),
      series: [{ name: 'S', values: Array(10).fill(5) }],
      chartType: 'pie',
    },
    rectIn: RECT,
  };
  const proposal = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...manyCats },
    ownerToken
  );
  assert.equal(proposal.body.code, 0, JSON.stringify(proposal.body));
  assert.equal(proposal.body.data.requiresConfirmation, true);
  assert.equal(proposal.body.data.suggestedType, 'bar');
  assert.equal(proposal.body.data.executed, false);
  const row = await getJobRow(jobId);
  assert.equal(await service.getJobPageVersion(row), 0, '拟确认阶段不应写版本');
  const confirmed = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...manyCats, confirm: true },
    ownerToken
  );
  assert.equal(confirmed.body.code, 0, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.chartType, 'pie');
});

test('MCP chart_add：csv 文件作数据源；Dashboard 数字卡与图同源', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const csvRes = await request(
    'presentations_chart_add',
    {
      jobId,
      pageNo: 1,
      rectIn: RECT,
      chart: {
        sourceKind: 'file',
        file: {
          name: 'data.csv',
          mime: 'text/csv',
          base64: Buffer.from('类别,A区,B区\nQ1,120,90\nQ2,150,110\n').toString(
            'base64'
          ),
        },
      },
    },
    ownerToken
  );
  assert.equal(csvRes.body.code, 0, JSON.stringify(csvRes.body));
  const bytes = await downloadBytes(jobId);
  const info = charts.readChartInfo(bytes, 1, csvRes.body.data.chartElementId);
  assert.deepEqual(info.data.categories, ['Q1', 'Q2']);
  assert.deepEqual(info.data.series[0].values, [120, 150]);

  const dashJobId = await makeCompletedJob(ownerToken);
  const dash = await request(
    'presentations_chart_add',
    {
      jobId: dashJobId,
      pageNo: 1,
      rectIn: { x: 0.5, y: 3.0, width: 6, height: 4 },
      chart: {
        categories: SAMPLE_DATA.categories,
        series: SAMPLE_DATA.series,
        chartType: 'bar',
      },
      kpiCards: [
        {
          title: '总计',
          value: 1140,
          unit: '人',
          fromData: { agg: 'total' },
          rectIn: { x: 0.5, y: 1.5, width: 2.6, height: 1.14 },
        },
        {
          title: 'A区合计',
          value: 650,
          fromData: { series: 'A区', agg: 'sum' },
          rectIn: { x: 3.8, y: 1.5, width: 2.6, height: 1.14 },
        },
      ],
    },
    ownerToken
  );
  assert.equal(dash.body.code, 0, JSON.stringify(dash.body));
  assert.equal(dash.body.data.kpiCardElementIds.length, 2);
  const dashBytes = await downloadBytes(dashJobId);
  const dashSlide = slideXmlOf(dashBytes, 1);
  assert.match(dashSlide, /val="003266"/, '数字卡底色应为深海军蓝');
  assert.match(dashSlide, /1,140 人/);
  assert.match(dashSlide, /650/);
  // 错数卡拒绝。
  const badCard = await request(
    'presentations_chart_add',
    {
      jobId: dashJobId,
      pageNo: 1,
      rectIn: RECT,
      chart: {
        categories: SAMPLE_DATA.categories,
        series: SAMPLE_DATA.series,
      },
      kpiCards: [
        {
          title: '错数',
          value: 999,
          fromData: { agg: 'total' },
          rectIn: { x: 0.5, y: 1.5, width: 2.6, height: 1.14 },
        },
      ],
    },
    ownerToken
  );
  assert.equal(badCard.response.status, 400);
  assert.match(badCard.body.message, /对不上/);
});

test('MCP chart_update：四种标签依次切换，只改标签层；换数据改工作簿', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const added = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...CHART_BODY },
    ownerToken
  );
  const elementId = added.body.data.chartElementId as string;
  const v1Bytes = await downloadBytes(jobId);
  const v1Slide = slideXmlOf(v1Bytes, 1);
  const v1Slide2 = slideXmlOf(v1Bytes, 2);
  for (const labels of [
    'hide_all',
    'percent_only',
    'total_only',
    'show_all',
  ] as const) {
    const res = await request(
      'presentations_chart_update',
      { jobId, pageNo: 1, elementId, valueLabels: labels },
      ownerToken
    );
    assert.equal(res.body.code, 0, JSON.stringify(res.body));
    assert.equal(res.body.data.valueLabels, labels);
    const bytes = await downloadBytes(jobId);
    assert.equal(
      slideXmlOf(bytes, 1),
      v1Slide,
      `切到 ${labels} 时 slide XML 应不动`
    );
    assert.equal(slideXmlOf(bytes, 2), v1Slide2, '第 2 页应始终不动');
    const info = charts.readChartInfo(bytes, 1, elementId);
    assert.equal(info.valueLabels, labels);
    assert.deepEqual(
      info.data,
      charts.validateChartData(SAMPLE_DATA),
      '标签切换不应改数据'
    );
  }
  // percent_only 时百分比合计口径与源数据一致（柱：每类目合计 100%）。
  const pctBytes = await downloadBytes(jobId);
  const pctInfo = charts.readChartInfo(pctBytes, 1, elementId);
  const pct = charts.percentages(pctInfo.data, 'bar');
  for (let i = 0; i < 4; i++)
    assert.ok(Math.abs(pct[0][i] + pct[1][i] - 100) < 1e-9);
  // 换数据：工作簿更新、类型可换。柱→折线且类目非时间、只有 2 点是
  // 软冲突：先给拟确认清单，confirm 后按指定执行。
  const proposal = await request(
    'presentations_chart_update',
    {
      jobId,
      pageNo: 1,
      elementId,
      data: {
        categories: ['X', 'Y'],
        series: [{ name: 'S', values: [5, 7] }],
      },
      chartType: 'line',
    },
    ownerToken
  );
  assert.equal(proposal.body.code, 0, JSON.stringify(proposal.body));
  assert.equal(proposal.body.data.requiresConfirmation, true);
  assert.equal(proposal.body.data.suggestedType, 'bar');
  const replaced = await request(
    'presentations_chart_update',
    {
      jobId,
      pageNo: 1,
      elementId,
      data: {
        categories: ['X', 'Y'],
        series: [{ name: 'S', values: [5, 7] }],
      },
      chartType: 'line',
      confirm: true,
    },
    ownerToken
  );
  assert.equal(replaced.body.code, 0, JSON.stringify(replaced.body));
  assert.equal(replaced.body.data.chartType, 'line');
  const afterBytes = await downloadBytes(jobId);
  const afterInfo = charts.readChartInfo(afterBytes, 1, elementId);
  assert.deepEqual(afterInfo.data.categories, ['X', 'Y']);
  assert.deepEqual(afterInfo.data.series[0].values, [5, 7]);
});

test('MCP chart_update：非图表元素与不存在元素拒绝；回退仍可用', async () => {
  const jobId = await makeCompletedJob(ownerToken);
  const added = await request(
    'presentations_chart_add',
    { jobId, pageNo: 1, ...CHART_BODY },
    ownerToken
  );
  const elementId = added.body.data.chartElementId as string;
  const bad = await request(
    'presentations_chart_update',
    { jobId, pageNo: 1, elementId: 'el-p1-1', valueLabels: 'hide_all' },
    ownerToken
  );
  assert.equal(bad.response.status, 400);
  assert.match(bad.body.message, /不是图表/);
  // 回退到原稿（version 0）后图表消失，下载回到 Presenton 原稿。
  const reverted = await request(
    'presentations_page_revert',
    { jobId, version: 0 },
    ownerToken
  );
  assert.equal(reverted.body.code, 0, JSON.stringify(reverted.body));
  const bytes = await downloadBytes(jobId);
  const index = elementIndex.buildElementIndex(bytes)!;
  const chartEls = index.pages
    .find((p) => p.pageNo === 1)!
    .elements.filter((e) => e.elementId === elementId);
  assert.equal(chartEls.length, 0, '回退到原稿后插入的图表应消失');
});

// --- 生成时落图 ----------------------------------------------------------------

test('生成时落图：任务完成即带图表，版本 1，下载可读出数据', async () => {
  stub.statusCalls = 0;
  const now = new Date();
  const jobId = 'stage3-gen-chart-job';
  await db()
    .insert(schema.presentationJob)
    .values({
      id: jobId,
      ownerUserId,
      ownerTokenId,
      presentonId: 'pres-1',
      presentonTaskId: 'task-1',
      status: 'generating',
      title: 'Test Deck',
      slideCount: null,
      exportPath: null,
      chartAssignments: JSON.stringify([
        {
          pageNo: 1,
          rectIn: RECT,
          chart: {
            data: SAMPLE_DATA,
            chartType: 'bar',
            chartTypeAuto: false,
            valueLabels: 'show_all',
          },
        },
      ]),
      createdAt: now,
      updatedAt: now,
    });
  const first = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(first.body.data.status, 'generating');
  const second = await request('presentations_get', { id: jobId }, ownerToken);
  assert.equal(
    second.body.data.status,
    'completed',
    JSON.stringify(second.body)
  );
  assert.equal(second.body.data.currentVersion, 1);
  assert.ok(
    Array.isArray(second.body.data.chartAssignments) &&
      second.body.data.chartAssignments.length === 1,
    'presentations_get 应回显图表落图明细'
  );
  const bytes = await downloadBytes(jobId);
  const index = elementIndex.buildElementIndex(bytes)!;
  const chartEls = index.pages
    .find((p) => p.pageNo === 1)!
    .elements.filter((e) => e.type === 'chart');
  // 夹具第 1 页原有一张“Chart 1”图框 + 新落的一张原生图。
  const inserted = chartEls.find((e) => e.elementId === 'el-p1-4');
  assert.ok(inserted, '生成时落的图表应在元素清单里');
  const info = charts.readChartInfo(bytes, 1, 'el-p1-4');
  assert.deepEqual(info.data, charts.validateChartData(SAMPLE_DATA));
});
