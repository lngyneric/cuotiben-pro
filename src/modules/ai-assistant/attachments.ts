// AI 学习助手附件：参考文档抽取文本 + 图片直通校验。
//
// 纯函数，不读库、不读配置。解析在内存里完成，用完即弃；抽出的文本只
// 拼进本轮对话的参考资料区块，不落盘、不记日志。
//
// 支持：txt / md / csv / tsv（直接解码）、docx（mammoth）、pdf
// （pdf-parse）、xls / xlsx（读表转 CSV 文本）；图片 png / jpg / jpeg /
// gif / webp 不解析文本，只做直通校验，由模型直接读图。
// 明确拒绝：doc / odt / rtf / ppt / pptx（不在解析支持范围），错误里
// 用中文提示并列出支持的类型。

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

export class AttachmentError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface AttachmentInput {
  name: string;
  mime: string;
  base64: string;
}

/** 直通给模型看的图片（前端已缩放，只保留 mime + base64）。 */
export interface AttachmentImage {
  mime: string;
  base64: string;
}

export interface ProcessedAttachments {
  /** 拼好的参考资料文本（空字符串表示本次没有文字类附件）。 */
  context: string;
  /** 直通图片（最多 3 张）。 */
  images: AttachmentImage[];
  /** 本次成功处理的文件名（含图片），供前端显示。 */
  fileNames: string[];
}

/** 每次请求最多 5 个文件，其中图片最多 3 张。 */
export const MAX_ATTACHMENT_FILES = 5;
export const MAX_ATTACHMENT_IMAGES = 3;
/** base64 总量上限（按 base64 字符串长度计，与请求体 2MB 上限一致）。 */
export const MAX_TOTAL_BASE64_CHARS = 2_000_000;
/** 单个文件解码后上限 5MB。 */
export const MAX_FILE_DECODED_BYTES = 5_000_000;
/** 每个文件抽出的文本上限 8000 字，全部合计上限 16000 字。 */
export const MAX_TEXT_PER_FILE_CHARS = 8_000;
export const MAX_TOTAL_TEXT_CHARS = 16_000;

/** 扩展名 → 允许的 MIME（不含 SVG；图片只直通不解析）。 */
const ALLOWED_FILE_TYPES: Record<string, string[]> = {
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  csv: ['text/csv', 'text/plain'],
  tsv: ['text/tab-separated-values', 'text/plain'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  pdf: ['application/pdf'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** 明确拒绝、但用户常会尝试传的类型：给出中文提示并列出支持的类型。 */
const UNSUPPORTED_EXTS: Record<string, string> = {
  doc: '旧版 Word（.doc）',
  odt: 'ODT 文档',
  rtf: 'RTF 文档',
  ppt: 'PowerPoint（.ppt）',
  pptx: 'PowerPoint（.pptx）',
};

const SUPPORTED_TEXT =
  '支持 txt、md、csv、tsv、docx、pdf、xls、xlsx 与 png、jpg、gif、webp 图片';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function truncateName(name: string): string {
  return name.length > 100 ? `${name.slice(0, 97)}…` : name;
}

function decodeBase64(file: AttachmentInput): Buffer {
  const b64 = (file.base64 ?? '').replace(/\s/g, '');
  if (!b64) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new AttachmentError(`「${file.name}」不是有效的 base64 内容`);
  }
  return Buffer.from(b64, 'base64');
}

function extractTextFile(buf: Buffer): string {
  // 纯文本类：直接 UTF-8 解码，去 BOM。
  return buf.toString('utf-8').replace(/^\uFEFF/, '');
}

async function extractDocx(buf: Buffer): Promise<string> {
  const out = await mammoth.extractRawText({ buffer: buf });
  return out.value ?? '';
}

async function extractPdf(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buf });
  try {
    const out = await parser.getText();
    return out.text ?? '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function extractSpreadsheet(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (!csv.trim()) continue;
    parts.push(wb.SheetNames.length > 1 ? `【表：${sheetName}】\n${csv}` : csv);
  }
  return parts.join('\n');
}

async function extractText(ext: string, buf: Buffer): Promise<string> {
  switch (ext) {
    case 'txt':
    case 'md':
    case 'csv':
    case 'tsv':
      return extractTextFile(buf);
    case 'docx':
      return extractDocx(buf);
    case 'pdf':
      return extractPdf(buf);
    case 'xls':
    case 'xlsx':
      return extractSpreadsheet(buf);
    default:
      return '';
  }
}

interface DecodedFile {
  name: string;
  ext: string;
  base64: string;
  buf: Buffer;
}

/**
 * 校验并处理一次请求里的附件：抽取文字类附件的文本、直通图片。
 * 失败抛 AttachmentError（中文、带文件名）；成功返回拼好的参考资料
 * 文本与图片。调用方负责把 context 带回给前端、把 images 传给模型。
 */
export async function processAttachments(
  files: AttachmentInput[]
): Promise<ProcessedAttachments> {
  if (!Array.isArray(files)) {
    throw new AttachmentError('附件格式不正确');
  }
  if (files.length === 0) {
    return { context: '', images: [], fileNames: [] };
  }
  if (files.length > MAX_ATTACHMENT_FILES) {
    throw new AttachmentError(`一次最多上传 ${MAX_ATTACHMENT_FILES} 个附件`);
  }

  let totalBase64 = 0;
  for (const f of files) totalBase64 += String(f.base64 ?? '').length;

  // 第一阶段：逐个校验类型/MIME、解码、查单文件大小。先报单文件的问题，
  // 再报总量问题（单文件超 5MB 时总量必然也超，报错要指到具体文件）。
  const decoded: DecodedFile[] = [];
  for (const file of files) {
    const name = truncateName(String(file.name ?? '').trim());
    if (!name) throw new AttachmentError('附件缺少文件名');
    const ext = extOf(name);
    const mime = String(file.mime ?? '').toLowerCase();
    const allowed = ALLOWED_FILE_TYPES[ext];
    if (!allowed) {
      const unsupported = UNSUPPORTED_EXTS[ext];
      throw new AttachmentError(
        unsupported
          ? `「${name}」暂不支持${unsupported}解析。${SUPPORTED_TEXT}。`
          : `「${name}」是不支持的文件类型。${SUPPORTED_TEXT}。`
      );
    }
    // MIME 为空（部分浏览器不给）或 application/octet-stream 时只认扩展
    // 名；否则 MIME 必须与扩展名对应，防改后缀名绕过。
    if (
      mime &&
      mime !== 'application/octet-stream' &&
      !allowed.includes(mime)
    ) {
      throw new AttachmentError(
        `「${name}」的文件类型与扩展名不符。${SUPPORTED_TEXT}。`
      );
    }

    const buf = decodeBase64(file);
    if (buf.length === 0) {
      throw new AttachmentError(`「${name}」是空文件`);
    }
    if (buf.length > MAX_FILE_DECODED_BYTES) {
      throw new AttachmentError(`「${name}」超过 5MB，请拆小再传`);
    }
    decoded.push({ name, ext, base64: file.base64, buf });
  }

  if (totalBase64 > MAX_TOTAL_BASE64_CHARS) {
    throw new AttachmentError('附件总体积超过 2MB，请减少附件或分开发送');
  }

  // 第二阶段：抽取文本、直通图片。
  const images: AttachmentImage[] = [];
  const sections: string[] = [];
  const fileNames: string[] = [];
  let totalChars = 0;

  for (const item of decoded) {
    const { name, ext, base64, buf } = item;
    if (IMAGE_EXTS.has(ext)) {
      if (images.length >= MAX_ATTACHMENT_IMAGES) {
        throw new AttachmentError(
          `一次最多上传 ${MAX_ATTACHMENT_IMAGES} 张图片`
        );
      }
      images.push({ mime: ALLOWED_FILE_TYPES[ext][0], base64 });
      fileNames.push(name);
      continue;
    }

    let text: string;
    try {
      text = await extractText(ext, buf);
    } catch {
      throw new AttachmentError(`「${name}」解析失败，请换一份文件再试`);
    }
    text = (text ?? '').replace(/\r\n?/g, '\n').trim();
    if (text.length > MAX_TEXT_PER_FILE_CHARS) {
      text = `${text.slice(0, MAX_TEXT_PER_FILE_CHARS)}\n（本文件内容过长，已截断）`;
    }
    if (!text) {
      sections.push(`【参考资料：${name}】\n（未提取到文字内容）`);
    } else {
      sections.push(`【参考资料：${name}】\n${text}`);
    }
    totalChars += text.length;
    fileNames.push(name);
  }

  let context = sections.join('\n\n');
  if (totalChars > MAX_TOTAL_TEXT_CHARS) {
    context = `${context.slice(0, MAX_TOTAL_TEXT_CHARS)}\n（参考资料过长，已截断到 16000 字）`;
  }
  return { context, images, fileNames };
}
