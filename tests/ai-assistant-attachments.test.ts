import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';

// 附件解析是纯函数：不读库、不读配置、不联网。
const {
  AttachmentError,
  MAX_TEXT_PER_FILE_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  processAttachments,
} = await import('@/modules/ai-assistant/attachments');

const b64 = (s: string | Buffer) =>
  Buffer.isBuffer(s)
    ? s.toString('base64')
    : Buffer.from(s, 'utf-8').toString('base64');

const txt = (name: string, text: string, mime = 'text/plain') => ({
  name,
  mime,
  base64: b64(text),
});

// 1x1 透明 PNG（只做直通校验，不解码像素）。
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 手写最小 PDF（一页，含给定文字）。 */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++)
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// --- 最小 docx：STORED（不压缩）zip，手写 CRC32，不依赖 zip 库 ---
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const crc = crc32(e.data);
    offsets.push(offset);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);
    offset += local.length + nameBuf.length + e.data.length;
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt16LE(0, 38);
    cen.writeUInt32LE(0, 40);
    cen.writeUInt32LE(offsets[offsets.length - 1], 42);
    central.push(cen, nameBuf);
  }
  const centralOffset = offset;
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function minimalDocx(lines: string[]): Buffer {
  const paras = lines
    .map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`)
    .join('');
  return buildStoredZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`
      ),
    },
  ]);
}

function minimalXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['姓名', '分数'],
      ['张三', 90],
      ['李四', 85],
    ]),
    'Sheet1'
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function expectAttachmentError(
  p: Promise<unknown>,
  match: RegExp
): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(
      e instanceof AttachmentError,
      `expected AttachmentError, got ${e}`
    );
    assert.match((e as Error).message, match);
    return true;
  });
}

test('txt/md/csv/tsv 直接解码，拼成参考资料区块', async () => {
  const out = await processAttachments([
    txt('笔记.txt', '第一行\n第二行'),
    txt('表.csv', 'a,b\n1,2', 'text/csv'),
    txt('说明.md', '# 标题\n正文', 'text/markdown'),
  ]);
  assert.equal(out.images.length, 0);
  assert.deepEqual(out.fileNames, ['笔记.txt', '表.csv', '说明.md']);
  assert.match(out.context, /【参考资料：笔记\.txt】\n第一行\n第二行/);
  assert.match(out.context, /【参考资料：表\.csv】\na,b\n1,2/);
  assert.match(out.context, /【参考资料：说明\.md】\n# 标题\n正文/);
});

test('docx 抽出正文，pdf 抽出文字，xlsx 读表转 CSV', async () => {
  const out = await processAttachments([
    {
      name: '报告.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: b64(minimalDocx(['Hello DOCX', 'Second line'])),
    },
    {
      name: '资料.pdf',
      mime: 'application/pdf',
      base64: b64(minimalPdf('Hello PDF')),
    },
    {
      name: '数据.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: b64(minimalXlsx()),
    },
  ]);
  assert.match(out.context, /Hello DOCX/);
  assert.match(out.context, /Second line/);
  assert.match(out.context, /Hello PDF/);
  assert.match(out.context, /姓名,分数/);
  assert.match(out.context, /张三,90/);
});

test('图片只直通校验：mime 与 base64 原样返回，不进参考资料文本', async () => {
  const out = await processAttachments([
    { name: 'shot.png', mime: 'image/png', base64: PNG_1X1_B64 },
    txt('a.txt', '文字'),
  ]);
  assert.equal(out.context.includes('shot.png'), false);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mime, 'image/png');
  assert.equal(out.images[0].base64, PNG_1X1_B64);
  assert.match(out.context, /文字/);
});

test('空附件列表返回空上下文', async () => {
  const out = await processAttachments([]);
  assert.equal(out.context, '');
  assert.deepEqual(out.images, []);
  assert.deepEqual(out.fileNames, []);
});

test('不支持的类型中文报错：doc/pptx 列出支持的类型', async () => {
  await expectAttachmentError(
    processAttachments([txt('旧.doc', 'x', 'application/msword')]),
    /暂不支持旧版 Word.*支持 txt、md、csv/
  );
  await expectAttachmentError(
    processAttachments([
      {
        name: 'deck.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        base64: b64('x'),
      },
    ]),
    /暂不支持PowerPoint.*支持 txt、md、csv/
  );
  await expectAttachmentError(
    processAttachments([txt('a.xyz', 'x', 'application/octet-stream')]),
    /不支持的文件类型/
  );
});

test('MIME 与扩展名不符、空文件、无效 base64 都报错', async () => {
  await expectAttachmentError(
    processAttachments([
      { name: 'a.txt', mime: 'image/png', base64: b64('x') },
    ]),
    /文件类型与扩展名不符/
  );
  await expectAttachmentError(
    processAttachments([{ name: 'empty.txt', mime: 'text/plain', base64: '' }]),
    /是空文件/
  );
  await expectAttachmentError(
    processAttachments([
      { name: 'bad.txt', mime: 'text/plain', base64: '!!!not-base64!!!' },
    ]),
    /不是有效的 base64/
  );
});

test('数量上限：最多 5 个文件，其中图片最多 3 张', async () => {
  const six = Array.from({ length: 6 }, (_, i) => txt(`f${i}.txt`, 'x'));
  await expectAttachmentError(processAttachments(six), /一次最多上传 5 个附件/);
  const fourImages = Array.from({ length: 4 }, (_, i) => ({
    name: `i${i}.png`,
    mime: 'image/png',
    base64: PNG_1X1_B64,
  }));
  await expectAttachmentError(
    processAttachments(fourImages),
    /一次最多上传 3 张图片/
  );
});

test('单文件抽出文本超 8000 字截断并标注', async () => {
  const out = await processAttachments([txt('long.txt', 'a'.repeat(9000))]);
  assert.match(out.context, /已截断/);
  const body = out.context.replace(/【参考资料：long\.txt】\n/, '');
  assert.ok(body.length <= MAX_TEXT_PER_FILE_CHARS + 30);
  assert.ok(body.startsWith('a'.repeat(100)));
});

test('合计超 16000 字截断并标注', async () => {
  const out = await processAttachments([
    txt('a.txt', 'a'.repeat(6000)),
    txt('b.txt', 'b'.repeat(6000)),
    txt('c.txt', 'c'.repeat(6000)),
  ]);
  assert.match(out.context, /已截断到 16000 字/);
  assert.ok(out.context.length <= MAX_TOTAL_TEXT_CHARS + 60);
});

test('base64 总量超 2MB 报错', async () => {
  const big = Buffer.alloc(600_000, 'x');
  await expectAttachmentError(
    processAttachments([
      { name: 'a.txt', mime: 'text/plain', base64: b64(big) },
      { name: 'b.txt', mime: 'text/plain', base64: b64(big) },
      { name: 'c.txt', mime: 'text/plain', base64: b64(big) },
    ]),
    /超过 2MB/
  );
});

test('单文件解码后超 5MB 报错', async () => {
  const huge = Buffer.alloc(5_000_001, 'x');
  await expectAttachmentError(
    processAttachments([
      { name: 'huge.txt', mime: 'text/plain', base64: b64(huge) },
    ]),
    /超过 5MB/
  );
});

test('提不到文字的文档标注“未提取到文字内容”', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
  const out = await processAttachments([
    {
      name: 'empty.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: b64(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })),
    },
  ]);
  assert.match(out.context, /未提取到文字内容/);
});
