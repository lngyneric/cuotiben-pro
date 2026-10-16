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
THEMES = {
    "light": {
        "bg": "#ffffff", "fg": "#1a1a1a", "muted": "#666",
        "accent": "#2563eb", "border": "#e5e7eb", "code_bg": "#f3f4f6",
        "quote_border": "#2563eb", "h_bg": "transparent",
    },
    "dark": {
        "bg": "#0f172a", "fg": "#e2e8f0", "muted": "#94a3b8",
        "accent": "#60a5fa", "border": "#1e293b", "code_bg": "#1e293b",
        "quote_border": "#60a5fa", "h_bg": "transparent",
    },
    "paper": {  # 打印/阅读友好
        "bg": "#faf9f7", "fg": "#2d2a26", "muted": "#78716c",
        "accent": "#b45309", "border": "#e7e5e4", "code_bg": "#f5f4f2",
        "quote_border": "#b45309", "h_bg": "transparent",
    },
}

CSS_TEMPLATE = """*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:{bg};color:{fg};font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.8;padding:0}}
.article{{max-width:720px;margin:0 auto;padding:32px 20px 80px}}
.meta{{border-bottom:1px solid {border};padding-bottom:20px;margin-bottom:28px}}
.meta h1{{font-size:1.6rem;line-height:1.4;margin-bottom:12px}}
.meta .desc{{color:{muted};font-size:.95rem;margin-bottom:10px}}
.meta .info{{color:{muted};font-size:.8rem}}
h2{{font-size:1.3rem;margin:1.8em 0 .8em;padding-bottom:.3em;border-bottom:1px solid {border};color:{fg}}}
h3{{font-size:1.1rem;margin:1.5em 0 .6em;color:{fg}}}
p{{margin:.8em 0}}
ul,ol{{margin:.8em 0;padding-left:1.6em}}
li{{margin:.4em 0}}
a{{color:{accent};text-decoration:none}}
a:hover{{text-decoration:underline}}
code{{background:{code_bg};padding:.15em .4em;border-radius:4px;font-size:.9em;font-family:ui-monospace,monospace}}
pre{{background:{code_bg};padding:16px;border-radius:8px;overflow-x:auto;margin:1em 0}}
pre code{{background:none;padding:0}}
blockquote{{border-left:3px solid {quote_border};padding:.5em 1em;margin:1em 0;color:{muted};background:{code_bg};border-radius:0 8px 8px 0}}
table{{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9rem}}
th,td{{border:1px solid {border};padding:8px 12px;text-align:left}}
th{{background:{code_bg};font-weight:600}}
img{{max-width:100%;border-radius:8px}}
hr{{border:none;border-top:1px solid {border};margin:2em 0}}
strong{{color:{fg}}}
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
