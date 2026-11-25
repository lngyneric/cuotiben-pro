// element_id 体系 —— 阶段 0 地基（实施清单能力三的定位依据）。
//
// 落地方式（按 service.ts 的实际调用方式定）：Presenton 的生成接口不接受
// 元素 ID，也没有任何“给形状写 ID”的参数；wiki 能拿到 PPTX 字节的唯一
// 时机是下载时向 Presenton 取回文件。所以 element_id 不在生成请求里写，
// 而是在下载路径上写：downloadJobPptx() 取回字节后，用 stampElementIds()
// 把稳定 ID 写进每个形状的 <p:cNvPr name="...">（PowerPoint 选窗里可见的
// 名字），并把逐页元素索引缓存到任务行的 element_index 列；“逐页元素可按
// ID 列出”由 listJobElements()（读缓存，缺失时现算）提供。
// ID 是确定性的：同一份文件每次盖章得到同一组 ID，重复下载不会漂移。
// 盖章只改形状名，不动任何可见内容、位置与样式；盖不上（不是合法 zip、
// 含数据描述符/加密/未知压缩方法）时原样返回原字节，不让下载失败。

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export type PptxElementType = 'text' | 'shape' | 'image' | 'chart' | 'other';

export interface PptxElementEntry {
  elementId: string;
  pageNo: number;
  type: PptxElementType;
  /** 盖章前形状在文件里的名字（为空时记 ''）。 */
  name: string;
  /** 文本形状的文字（截断到 200 字），非文本形状为空。 */
  text: string;
  /** 阶段 0 不做几何映射，恒为 null；阶段 1/2 按版式注册表填。 */
  slotId: string | null;
}

export interface PptxElementPage {
  pageNo: number;
  elements: PptxElementEntry[];
}

export interface PptxElementIndex {
  version: 1;
  pages: PptxElementPage[];
}

/** 元素 ID：el-p<页码>-<页内序号>，如 el-p2-3。页内序号按形状在页内的出现顺序。 */
export function elementIdFor(pageNo: number, ordinal: number): string {
  return `el-p${pageNo}-${ordinal}`;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** 中央目录里本条目的起始偏移（手术改写时原样复制中央记录用）。 */
  centralOffset: number;
  modTime: number;
  modDate: number;
  /** 压缩后的原始字节（从 local header 后截取）。 */
  raw: Buffer;
}

/** 最小 zip 解析：只接受 method 0（store）/ 8（deflate）、无加密、无数据描述符。 */
function parseZip(bytes: Buffer): ZipEntry[] | null {
  if (bytes.length < 22) return null;
  let eocd = -1;
  const scanStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  let p = centralOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== CENTRAL_SIG)
      return null;
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const modTime = bytes.readUInt16LE(p + 12);
    const modDate = bytes.readUInt16LE(p + 14);
    const crc = bytes.readUInt32LE(p + 16);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const size = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localHeaderOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    // 加密（bit 0）与数据描述符（bit 3）一律不处理；方法只认 store/deflate。
    if (flags & 0x1) return null;
    if (flags & 0x8) return null;
    if (method !== 0 && method !== 8) return null;
    if (seen.has(name)) return null;
    seen.add(name);
    if (
      localHeaderOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localHeaderOffset) !== LOCAL_SIG
    )
      return null;
    const lhNameLen = bytes.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    if (dataStart + compressedSize > bytes.length) return null;
    entries.push({
      name,
      method,
      flags: 0,
      crc,
      compressedSize,
      size,
      localHeaderOffset,
      centralOffset: p,
      modTime,
      modDate,
      raw: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(entry: ZipEntry): Buffer | null {
  try {
    const data =
      entry.method === 8 ? inflateRawSync(entry.raw) : Buffer.from(entry.raw);
    if (data.length !== entry.size) return null;
    if (crc32(data) !== entry.crc) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 读 zip 全部条目（名 + 解压后字节），供阶段 1 的 PPTX 文本抽取复用
 * （pptx-text.ts）。不是合法 zip 或任一条目解不开时返回 null。
 */
export function readZipEntries(
  bytes: Buffer
): Array<{ name: string; data: Buffer }> | null {
  const entries = parseZip(bytes);
  if (!entries) return null;
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const entry of entries) {
    const data = entryData(entry);
    if (!data) return null;
    out.push({ name: entry.name, data });
  }
  return out;
}

interface SlideShape {
  name: string;
  type: PptxElementType;
  text: string;
}

/** 从一页 slide XML 里按出现顺序读形状：只看 <p:cNvPr>，向前找最近的容器定类型。 */
function parseSlideShapes(xml: string): SlideShape[] {
  const shapes: SlideShape[] = [];
  const cNvPrRe = /<p:cNvPr\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = cNvPrRe.exec(xml)) !== null) {
    const tag = match[0];
    const at = match.index;
    const nameMatch = /name="([^"]*)"/.exec(tag);
    const name = nameMatch ? nameMatch[1] : '';
    // 组合本身的 <p:nvGrpSpPr><p:cNvPr> 不是内容形状，跳过。
    const grpIdx = xml.lastIndexOf('<p:nvGrpSpPr>', at);
    const grpEnd = xml.lastIndexOf('</p:nvGrpSpPr>', at);
    if (grpIdx >= 0 && grpIdx > grpEnd) continue;
    const before = xml.slice(0, at);
    const spIdx = before.lastIndexOf('<p:sp>');
    const spEnd = before.lastIndexOf('</p:sp>');
    const picIdx = before.lastIndexOf('<p:pic>');
    const picEnd = before.lastIndexOf('</p:pic>');
    const frameIdx = before.lastIndexOf('<p:graphicFrame>');
    const frameEnd = before.lastIndexOf('</p:graphicFrame>');
    // 最近一个未闭合的容器即本形状的容器。
    const open = [
      { idx: spIdx, end: spEnd, kind: 'sp' },
      { idx: picIdx, end: picEnd, kind: 'pic' },
      { idx: frameIdx, end: frameEnd, kind: 'frame' },
    ]
      .filter((c) => c.idx >= 0 && c.idx > c.end)
      .sort((a, b) => b.idx - a.idx)[0];
    if (!open) {
      shapes.push({ name, type: 'other', text: '' });
      continue;
    }
    if (open.kind === 'pic') {
      shapes.push({ name, type: 'image', text: '' });
      continue;
    }
    if (open.kind === 'frame') {
      const segment = xml.slice(at, xml.indexOf('</p:graphicFrame>', at));
      shapes.push({
        name,
        type: segment.includes('<c:chart') ? 'chart' : 'shape',
        text: '',
      });
      continue;
    }
    const segment = xml.slice(at, xml.indexOf('</p:sp>', at));
    const texts: string[] = [];
    const textRe = /<a:t>([^<]*)<\/a:t>/g;
    let t: RegExpExecArray | null;
    while ((t = textRe.exec(segment)) !== null) texts.push(t[1]);
    shapes.push({
      name,
      type: texts.length > 0 ? 'text' : 'shape',
      text: texts.join('').slice(0, 200),
    });
  }
  return shapes;
}

function slideEntries(
  entries: ZipEntry[]
): { pageNo: number; entry: ZipEntry }[] {
  return entries
    .map((entry) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name);
      return m ? { pageNo: Number(m[1]), entry } : null;
    })
    .filter((x): x is { pageNo: number; entry: ZipEntry } => x !== null)
    .sort((a, b) => a.pageNo - b.pageNo);
}

/** 从 PPTX 字节读逐页元素索引；不是合法 PPTX 时返回 null。 */
export function buildElementIndex(pptx: Buffer): PptxElementIndex | null {
  const entries = parseZip(pptx);
  if (!entries) return null;
  const slides = slideEntries(entries);
  if (slides.length === 0) return null;
  const pages: PptxElementPage[] = [];
  for (const { pageNo, entry } of slides) {
    const data = entryData(entry);
    if (!data) return null;
    const shapes = parseSlideShapes(data.toString('utf-8'));
    pages.push({
      pageNo,
      elements: shapes.map((s, i) => ({
        elementId: elementIdFor(pageNo, i + 1),
        pageNo,
        type: s.type,
        name: s.name,
        text: s.text,
        slotId: null,
      })),
    });
  }
  return { version: 1, pages };
}

/** 把 <p:cNvPr name="..."> 逐个改写成 element_id；返回改写后的整页 XML。 */
function stampSlideXml(xml: string, pageNo: number): string {
  let ordinal = 0;
  return xml.replace(/<p:cNvPr\b[^>]*>/g, (tag, offset: number) => {
    // 与 parseSlideShapes 一致：组合本身的 cNvPr 不算元素，不盖章。
    const grpIdx = xml.lastIndexOf('<p:nvGrpSpPr>', offset);
    const grpEnd = xml.lastIndexOf('</p:nvGrpSpPr>', offset);
    if (grpIdx >= 0 && grpIdx > grpEnd) return tag;
    ordinal += 1;
    const id = elementIdFor(pageNo, ordinal);
    if (/name="[^"]*"/.test(tag))
      return tag.replace(/name="[^"]*"/, `name="${id}"`);
    return tag.replace('<p:cNvPr', `<p:cNvPr name="${id}"`);
  });
}

function rebuildZip(
  entries: ZipEntry[],
  contents: Map<string, Buffer>
): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = contents.get(entry.name) ?? entryData(entry)!;
    const compressed =
      entry.method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.modTime, 10);
    local.writeUInt16LE(entry.modDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIG, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt16LE(entry.modTime, 12);
    centralHeader.writeUInt16LE(entry.modDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/**
 * 给 PPTX 每个形状写 element_id 并返回改写后的字节与元素索引。
 * 不是合法 PPTX（或含本实现处理不了的条目）时返回 null——调用方原样
 * 返回原字节，下载不受影响。
 */
export function stampElementIds(pptx: Buffer): {
  bytes: Buffer;
  index: PptxElementIndex;
} | null {
  const entries = parseZip(pptx);
  if (!entries) return null;
  const slides = slideEntries(entries);
  if (slides.length === 0) return null;
  const contents = new Map<string, Buffer>();
  const pages: PptxElementPage[] = [];
  for (const { pageNo, entry } of slides) {
    const data = entryData(entry);
    if (!data) return null;
    const xml = data.toString('utf-8');
    const shapes = parseSlideShapes(xml);
    contents.set(entry.name, Buffer.from(stampSlideXml(xml, pageNo), 'utf-8'));
    pages.push({
      pageNo,
      elements: shapes.map((s, i) => ({
        elementId: elementIdFor(pageNo, i + 1),
        pageNo,
        type: s.type,
        name: s.name,
        text: s.text,
        slotId: null,
      })),
    });
  }
  let bytes: Buffer;
  try {
    bytes = rebuildZip(entries, contents);
  } catch {
    return null;
  }
  // 盖章结果自检：重读一遍能解析且 ID 一致，否则不交付改写过的字节。
  const check = buildElementIndex(bytes);
  if (!check) return null;
  return { bytes, index: { version: 1, pages } };
}

// ─── zip 级手术（阶段 2 单页编辑） ──────────────────────────────────────────
//
// 单页重写只改目标 slide 的 XML：其余条目的 local 记录（含压缩字节）逐字
// 节原样复制，不经过重新压缩；中央目录只改目标条目的 crc/尺寸与被顶动
// 的偏移量；其余中央记录原样复制。于是其余 slide 解压后的内容逐字节不
// 变（验收口径“逐页导出比对”即以此为准），且 PowerPoint 打开不受影响。
// 结构稍有异常（中央偏移对不上、重名、含注释等解析不出的情况）一律返回
// null，调用方不交付半成品字节。

const ELEMENT_ID_NAME_RE = /^el-p\d+-\d+$/;

/** 读单个条目的解压后字节；不存在或解不开时返回 null。 */
export function readZipEntry(bytes: Buffer, name: string): Buffer | null {
  const entries = parseZip(bytes);
  if (!entries) return null;
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return entryData(entry);
}

/** 某份 PPTX 是否每个形状的名字都已是 element_id（即已盖过章）。 */
export function hasStampedElementIds(pptx: Buffer): boolean | null {
  const entries = parseZip(pptx);
  if (!entries) return null;
  const slides = slideEntries(entries);
  if (slides.length === 0) return null;
  for (const { entry } of slides) {
    const data = entryData(entry);
    if (!data) return null;
    const shapes = parseSlideShapes(data.toString('utf-8'));
    if (shapes.length === 0) return null;
    for (const s of shapes) {
      if (!ELEMENT_ID_NAME_RE.test(s.name)) return false;
    }
  }
  return true;
}

/** local 记录全长（header + 名 + extra + 压缩数据）。 */
function localRecordLength(bytes: Buffer, entry: ZipEntry): number | null {
  const off = entry.localHeaderOffset;
  if (off + 30 > bytes.length) return null;
  const nameLen = bytes.readUInt16LE(off + 26);
  const extraLen = bytes.readUInt16LE(off + 28);
  return 30 + nameLen + extraLen + entry.compressedSize;
}

/** 中央记录全长（header + 名 + extra + comment）。 */
function centralRecordLength(bytes: Buffer, entry: ZipEntry): number | null {
  const off = entry.centralOffset;
  if (off + 46 > bytes.length) return null;
  const nameLen = bytes.readUInt16LE(off + 28);
  const extraLen = bytes.readUInt16LE(off + 30);
  const commentLen = bytes.readUInt16LE(off + 32);
  return 46 + nameLen + extraLen + commentLen;
}

function eocdInfo(bytes: Buffer): {
  eocd: number;
  totalEntries: number;
  centralOffset: number;
  centralSize: number;
} | null {
  const scanStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (bytes.readUInt32LE(i) !== EOCD_SIG) continue;
    return {
      eocd: i,
      totalEntries: bytes.readUInt16LE(i + 10),
      centralOffset: bytes.readUInt32LE(i + 16),
      centralSize: bytes.readUInt32LE(i + 12),
    };
  }
  return null;
}

function buildLocalRecord(
  entry: ZipEntry,
  data: Buffer
): { record: Buffer; crc: number; compressed: Buffer } {
  const compressed =
    entry.method === 8 ? deflateRawSync(data) : Buffer.from(data);
  const crc = crc32(data);
  const nameBuf = Buffer.from(entry.name, 'utf-8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(entry.method, 8);
  local.writeUInt16LE(entry.modTime, 10);
  local.writeUInt16LE(entry.modDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return {
    record: Buffer.concat([local, nameBuf, compressed]),
    crc,
    compressed,
  };
}

/**
 * 只替换一个条目的内容，返回新 zip 字节；其余条目的 local 记录逐字节
 * 原样保留。目标不存在或结构异常时返回 null。
 */
export function replaceZipEntry(
  bytes: Buffer,
  name: string,
  newData: Buffer
): Buffer | null {
  const entries = parseZip(bytes);
  const info = eocdInfo(bytes);
  if (!entries || !info) return null;
  const targetIdx = entries.findIndex((e) => e.name === name);
  if (targetIdx < 0) return null;
  const target = entries[targetIdx];
  // 逐条拼 local 区：目标用新记录，其余原样切片；同时算出每条的新偏移。
  const localParts: Buffer[] = [];
  const newOffsets: number[] = [];
  let offset = 0;
  let newTarget: { crc: number; compressedSize: number; size: number } | null =
    null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const len = localRecordLength(bytes, entry);
    if (len === null) return null;
    newOffsets.push(offset);
    if (i === targetIdx) {
      const built = buildLocalRecord(entry, newData);
      localParts.push(built.record);
      newTarget = {
        crc: built.crc,
        compressedSize: built.compressed.length,
        size: newData.length,
      };
      offset += built.record.length;
    } else {
      localParts.push(
        bytes.subarray(entry.localHeaderOffset, entry.localHeaderOffset + len)
      );
      offset += len;
    }
  }
  if (!newTarget) return null;
  const centralStart = offset;
  const centralParts: Buffer[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const len = centralRecordLength(bytes, entry);
    if (len === null) return null;
    const record = Buffer.from(
      bytes.subarray(entry.centralOffset, entry.centralOffset + len)
    );
    if (i === targetIdx) {
      record.writeUInt32LE(newTarget.crc, 16);
      record.writeUInt32LE(newTarget.compressedSize, 20);
      record.writeUInt32LE(newTarget.size, 24);
    }
    if (newOffsets[i] !== entry.localHeaderOffset)
      record.writeUInt32LE(newOffsets[i], 42);
    centralParts.push(record);
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  const out = Buffer.concat([...localParts, centralBuf, eocd]);
  // 自检：新包能解析、目标内容一致、其余条目解压后不变。
  const check = parseZip(out);
  if (!check) return null;
  for (const entry of check) {
    const orig = entries.find((e) => e.name === entry.name);
    if (!orig) return null;
    const a = entryData(entry);
    const b = entry.name === name ? newData : entryData(orig);
    if (!a || !b || !a.equals(b)) return null;
  }
  return out;
}

/**
 * 追加新条目（换图时加 ppt/media 与 rels 用）：新 local 记录插在中央
 * 目录之前，旧条目的 local 记录与中央记录、偏移一律不动。
 * 有重名或结构异常时返回 null。
 */
export function addZipEntries(
  bytes: Buffer,
  additions: Array<{ name: string; data: Buffer }>
): Buffer | null {
  const entries = parseZip(bytes);
  const info = eocdInfo(bytes);
  if (!entries || !info) return null;
  const names = new Set(entries.map((e) => e.name));
  for (const a of additions) {
    if (names.has(a.name)) return null;
    names.add(a.name);
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = info.centralOffset;
  for (const a of additions) {
    const compressed = deflateRawSync(a.data);
    const crc = crc32(a.data);
    const nameBuf = Buffer.from(a.name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(a.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(a.data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    centralParts.push(header, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const newCentralOffset = offset;
  const oldCentral = bytes.subarray(
    info.centralOffset,
    info.centralOffset + info.centralSize
  );
  const newCentral = Buffer.concat([oldCentral, ...centralParts]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  const total = entries.length + additions.length;
  eocd.writeUInt16LE(total, 8);
  eocd.writeUInt16LE(total, 10);
  eocd.writeUInt32LE(newCentral.length, 12);
  eocd.writeUInt32LE(newCentralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  const out = Buffer.concat([
    bytes.subarray(0, info.centralOffset),
    ...localParts,
    newCentral,
    eocd,
  ]);
  const check = parseZip(out);
  if (!check || check.length !== total) return null;
  return out;
}
