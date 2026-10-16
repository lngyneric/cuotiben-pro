#!/usr/bin/env python3
"""
本地解析 MDX 并发布单文件 HTML。

参考 capsule-viewer 的单文件发布理念：
- 解析 src/content/posts/ 下的 .mdx（export const meta + markdown 正文）
- Markdown 转 HTML，CSS 全内联，打包成单个 HTML 文件
- 微信/企业微信可直接打开分享，无需服务器

用法：
  python3 tools/publish.py --all                    # 发布全部
  python3 tools/publish.py --slug g8-study-plan-1016 --locale zh
  python3 tools/publish.py --file src/content/posts/xxx.zh.mdx -o dist/xxx.html
  python3 tools/publish.py --all --theme dark
"""

import argparse
import json
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
POSTS_DIR = ROOT / "src" / "content" / "posts"
DIST_DIR = ROOT / "dist" / "published"

# ─── 主题 ──────────────────────────────────────────────────────────────
# 对齐 blog MDX 渲染风格（shadcn/ui Base Nova，暖色系 oklch）
THEMES = {
    "light": {
        "bg": "#f9f8f6", "fg": "#3a3632", "muted": "#6b6560",
        "accent": "#1f1b17", "border": "#e8e4df", "code_bg": "#f0ede9",
        "quote_border": "#1f1b17",
    },
    "dark": {
        "bg": "#0a0a0a", "fg": "#fafafa", "muted": "#a1a1aa",
        "accent": "#fafafa", "border": "#27272a", "code_bg": "#18181b",
        "quote_border": "#fafafa",
    },
    "paper": {  # 打印/阅读友好
        "bg": "#faf9f7", "fg": "#2d2a26", "muted": "#78716c",
        "accent": "#44403c", "border": "#e7e5e4", "code_bg": "#f5f4f2",
        "quote_border": "#44403c",
    },
}

# 对齐 src/components/mdx-components.tsx 的排版：
# h1:text-xl/2xl semibold tracking-tight / h2:text-lg/xl / h3:text-base
# p:leading-7 mt-2 / a:text-primary font-medium
CSS_TEMPLATE = """*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:{bg};color:{fg};font-family:'Inter Variable','Inter',-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75;padding:0;-webkit-font-smoothing:antialiased}}
.article{{max-width:720px;margin:0 auto;padding:32px 20px 80px}}
.meta{{border-bottom:1px solid {border};padding-bottom:20px;margin-bottom:28px}}
.meta h1{{font-size:1.5rem;line-height:1.3;margin-bottom:12px;font-weight:600;letter-spacing:-0.02em}}
.meta .desc{{color:{muted};font-size:.95rem;margin-bottom:10px;line-height:1.7}}
.meta .info{{color:{muted};font-size:.8rem}}
h2{{font-size:1.25rem;margin:1.5em 0 .5em;font-weight:600;letter-spacing:-0.02em;color:{fg}}}
h3{{font-size:1rem;margin:1em 0 .375em;font-weight:600;letter-spacing:-0.02em;color:{fg}}}
p{{margin:.5em 0;line-height:1.75;color:{fg};opacity:.9}}
ul,ol{{margin:.5em 0;padding-left:1.6em}}
li{{margin:.25em 0;line-height:1.75}}
li::marker{{color:{muted}}}
a{{color:{accent};font-weight:500;text-underline-offset:4px}}
a:hover{{text-decoration:underline}}
code{{background:{code_bg};padding:.15em .4em;border-radius:4px;font-size:.875em;font-family:ui-monospace,SFMono-Regular,monospace}}
pre{{background:{code_bg};padding:16px;border-radius:8px;overflow-x:auto;margin:1em 0;border:1px solid {border}}}
pre code{{background:none;padding:0;border:none}}
blockquote{{border-left:2px solid {quote_border};padding:.25em 1em;margin:1em 0;color:{muted}}}
table{{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9rem}}
th,td{{border:1px solid {border};padding:8px 12px;text-align:left}}
th{{background:{code_bg};font-weight:600}}
img{{max-width:100%;border-radius:8px}}
hr{{border:none;border-top:1px solid {border};margin:2em 0}}
strong{{color:{fg};font-weight:600}}
.footer{{margin-top:3em;padding-top:1em;border-top:1px solid {border};color:{muted};font-size:.8rem;text-align:center}}
"""

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<style>{css}</style>
</head>
<body>
<article class="article">
<div class="meta">
<h1>{title}</h1>
<div class="desc">{description}</div>
<div class="info">{author} · {date}</div>
</div>
{body}
<div class="footer">错题本 Pro · 免费学习工具</div>
</article>
</body>
</html>
"""

# ─── MDX 解析 ──────────────────────────────────────────────────────────

META_RE = re.compile(
    r"export\s+const\s+meta\s*=\s*(\{.*?\});", re.DOTALL
)

def parse_mdx(path: Path):
    """解析 .mdx，返回 (meta dict, markdown 正文)。"""
    text = path.read_text(encoding="utf-8")
    m = META_RE.search(text)
    meta = {}
    if m:
        # 简单解析 meta 对象（只取常用字段）
        body = m.group(1)
        for key in ("title", "description", "created_at", "author_name"):
            km = re.search(
                rf"{key}\s*:\s*['\"](.*?)['\"]", body, re.DOTALL
            )
            if km:
                meta[key] = km.group(1).replace("\n", " ").strip()
        text = text[: m.start()] + text[m.end() :]

    # 去掉 import/export 行（MDX 特有）
    lines = []
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("import ") or s.startswith("export "):
            continue
        lines.append(line)
    md = "\n".join(lines).strip()
    return meta, md


def md_to_html(md: str) -> str:
    return markdown.markdown(
        md,
        extensions=["tables", "fenced_code", "toc", "sane_lists"],
    )


def build_html(meta: dict, md: str, theme: str, lang: str) -> str:
    t = THEMES.get(theme, THEMES["light"])
    css = CSS_TEMPLATE.format(**t)
    body = md_to_html(md)
    return HTML_TEMPLATE.format(
        lang=lang,
        title=meta.get("title", "未命名"),
        description=meta.get("description", ""),
        author=meta.get("author_name", ""),
        date=meta.get("created_at", ""),
        css=css,
        body=body,
    )


def publish_one(mdx_path: Path, out_path: Path, theme: str):
    meta, md = parse_mdx(mdx_path)
    # 从文件名推断语言：xxx.zh.mdx / xxx.en.mdx
    lang = "zh"
    if ".en." in mdx_path.name:
        lang = "en"
    html = build_html(meta, md, theme, lang)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    print(f"✓ {mdx_path.name} → {out_path} ({len(html)//1024}KB)")


def main():
    ap = argparse.ArgumentParser(description="MDX 本地解析 → 单文件 HTML 发布")
    ap.add_argument("--all", action="store_true", help="发布全部 posts")
    ap.add_argument("--slug", help="按 slug 发布（如 g8-study-plan-1016）")
    ap.add_argument("--locale", default="zh", help="语言（zh/en），默认 zh")
    ap.add_argument("--file", help="直接指定 .mdx 文件")
    ap.add_argument("-o", "--output", help="输出路径")
    ap.add_argument("--theme", default="light",
                    choices=list(THEMES.keys()), help="主题")
    ap.add_argument("--outdir", default=str(DIST_DIR), help="输出目录")
    args = ap.parse_args()

    outdir = Path(args.outdir)

    if args.file:
        src = Path(args.file)
        out = Path(args.output) if args.output else outdir / (src.stem + ".html")
        publish_one(src, out, args.theme)
        return

    if args.all:
        files = sorted(POSTS_DIR.glob("*.mdx"))
        # 跳过 index.ts
        for f in files:
            out = outdir / (f.stem + ".html")
            publish_one(f, out, args.theme)
        print(f"\n共 {len(files)} 篇 → {outdir}/")
        return

    if args.slug:
        # 找 slug.locale.mdx
        candidates = list(POSTS_DIR.glob(f"{args.slug}.{args.locale}.mdx"))
        if not candidates:
            candidates = list(POSTS_DIR.glob(f"{args.slug}.*.mdx"))
        if not candidates:
            print(f"未找到: {args.slug}", file=sys.stderr)
            sys.exit(1)
        src = candidates[0]
        out = Path(args.output) if args.output else outdir / (src.stem + ".html")
        publish_one(src, out, args.theme)
        return

    ap.print_help()


if __name__ == "__main__":
    main()
