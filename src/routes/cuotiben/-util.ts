import type { Card } from './-types';

export const isMath = (c: Pick<Card, 'subject'>) =>
  /数学|math/i.test(c.subject || '');

/** 只渲染我们自己的 SVG 图，防止富文本 XSS */
export function safeDiagram(d: string | null): string | null {
  if (!d || !d.trim().startsWith('<svg')) return null;
  // 简易消毒：去掉事件处理器属性与 script（innerHTML 插入不执行 parser script，
  // 但 onload/onbegin 等仍可能触发）
  return d
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}
