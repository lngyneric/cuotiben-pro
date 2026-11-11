// Blog HTML service — upload sanitizing and visibility/owner rules.
//
// The HTML files rendered in the blog iframe come from authenticated users,
// but they are still untrusted input: a stored `<script>` in a same-origin
// iframe could steal the reader's session. Uploads are therefore scrubbed
// server-side (before storage) AND rendered inside a sandboxed iframe
// (see src/routes/blog/index.tsx). The scrubber below is regex-based and
// deliberately conservative — it removes whole dangerous constructs rather
// than trying to parse HTML. It is not a substitute for the iframe sandbox.

import { getUserRoles } from '@/modules/rbac/service';

import type { BlogHtmlMeta } from './storage';

/**
 * Strip active content from an uploaded single-file HTML document.
 * Removes, in order:
 * - `<script>` elements (including `<script src>`)
 * - `<iframe>`, `<object>`, `<embed>`, `<base>`, `<form>` elements
 * - `<meta http-equiv="refresh">` (redirects the reader away)
 * - `on*` event-handler attributes (`onclick`, `onload`, …)
 * - `javascript:` / `vbscript:` / `data:text/html` URLs in href/src/action
 *   attributes (also with leading whitespace/control chars)
 * - `style` attributes containing `expression(` or `javascript:`
 *
 * Benign content is untouched: `<style>` blocks, inline `style` without
 * those patterns, `<img>` with http(s)/relative src, links, tables, etc.
 * External `<link>`/`<script src>` are already forbidden by
 * docs/blog-html-spec.md; the scrubber enforces the script half of it.
 */
export function sanitizeBlogHtml(html: string): string {
  let out = html;

  // Whole dangerous elements (with content, non-greedy, case-insensitive).
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<script\b[^>]*\/?>/gi, '');
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  out = out.replace(/<iframe\b[^>]*\/?>/gi, '');
  out = out.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '');
  out = out.replace(/<object\b[^>]*\/?>/gi, '');
  out = out.replace(/<embed\b[^>]*\/?>/gi, '');
  out = out.replace(/<base\b[^>]*\/?>/gi, '');
  out = out.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, '');
  out = out.replace(/<form\b[^>]*\/?>/gi, '');
  out = out.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\/?>/gi,
    ''
  );

  // Event-handler attributes: on*="..." / on*='...' / on*=bare. Quoted
  // values may contain `>`; match the closing quote of the same kind.
  out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/gi, '');

  // Dangerous URL schemes in href/src/action/xlink:href attributes.
  // The value is replaced with `#`; the attribute itself stays so the
  // document structure (and the author's link text) survives.
  // Note the data: branch: real data URLs are `data:text/html,<...>` /
  // `data:text/html;base64,...` (comma/semicolon, NOT a second colon) —
  // matching a colon there would miss every real data:text/html payload.
  out = out.replace(
    /((?:href|src|action|xlink:href)\s*=\s*["']?)\s*(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html\s*[,;])[^"'\s>]*/gi,
    '$1#'
  );

  // Inline styles that can execute script.
  out = out.replace(
    /\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/gi,
    (match) => (/expression\s*\(|javascript\s*:/i.test(match) ? '' : match)
  );

  return out;
}

export interface BlogViewer {
  userId: string;
  isAdmin: boolean;
}

/** Is this user a blog admin (role `admin` or `super_admin`, active)? */
export async function isBlogAdmin(userId: string): Promise<boolean> {
  try {
    const roles = await getUserRoles(userId);
    return roles.some(
      (r: any) => r.roleName === 'admin' || r.roleName === 'super_admin'
    );
  } catch {
    return false;
  }
}

/** `self` items are visible only to their uploader and to admins. */
export function canViewBlogHtml(
  meta: BlogHtmlMeta,
  viewer: BlogViewer | null
): boolean {
  if (meta.visibility !== 'self') return true;
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return !!meta.uploaderId && meta.uploaderId === viewer.userId;
}

/**
 * Who may delete / re-categorize an item: its uploader, or an admin.
 * Items with no recorded uploader (uploaded to R2 before ownership was
 * tracked) keep the legacy behaviour: any signed-in user may manage them.
 */
export function canManageBlogHtml(
  meta: BlogHtmlMeta,
  viewer: BlogViewer
): boolean {
  if (viewer.isAdmin) return true;
  if (!meta.uploaderId) return true;
  return meta.uploaderId === viewer.userId;
}
