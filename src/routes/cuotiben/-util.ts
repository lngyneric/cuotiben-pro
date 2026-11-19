/** 只渲染我们自己的 SVG 图，防止富文本 XSS */
export function safeDiagram(d: string | null): string | null {
  if (!d || !d.trim().startsWith('<svg')) return null;
  // 简易消毒：去掉事件处理器属性与 script（innerHTML 插入不执行 parser script，
  // 但 onload/onbegin 等仍可能触发）
  return d
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** 取文本第一个非空行（去首尾空白）。记事时间线每条只显示一句简述。 */
export function firstLine(text: string): string {
  const line = (text || '').split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

/** ISO 时间转 YYYY-MM-DD（本地时区）；解析失败时原样截前 10 位。 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return (iso || '').slice(0, 10);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
