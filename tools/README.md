# 本地发布工具

## publish.py — MDX 解析 → 单文件 HTML

参考 capsule-viewer 的单文件发布理念：把 `src/content/posts/` 下的 MDX
解析成**单个自包含 HTML**（CSS 全内联，无外部依赖），微信/企业微信
可直接打开分享。

### 用法

```bash
# 发布全部
python3 tools/publish.py --all

# 按 slug 发布（自动找对应语言）
python3 tools/publish.py --slug g8-study-plan-1016 --locale zh

# 直接指定文件
python3 tools/publish.py --file src/content/posts/xxx.zh.mdx -o dist/xxx.html

# 换主题：light / dark / paper
python3 tools/publish.py --all --theme dark
```

输出目录：`dist/published/`（gitignored，不进仓库）

### 解析规则

- `export const meta = {...}` → 提取 title/description/created_at/author_name
- 去掉 `import`/`export` 行（MDX 特有语法）
- 剩余 Markdown 用 `markdown` 库转 HTML（支持表格、代码块、目录）

### 主题

三套内置主题（参考 capsule-viewer 的 themes/ 思路）：

- `light`：默认白底
- `dark`：深色模式
- `paper`：纸质阅读风，适合打印
