# Blog HTML 文件规范

> 适用于上传到 `/blog` 的单文件 HTML（R2 存储 `cuotiben-html` bucket）

## 1. 文件命名

| 规则            | 说明                         | 示例                              |
| --------------- | ---------------------------- | --------------------------------- |
| 小写字母+连字符 | URL 安全，无空格无中文       | `g8-study-plan-1016.zh.html`      |
| 格式            | `{slug}.{locale}.html`       | `g8-homework-report-1016.zh.html` |
| slug            | 英文短横线，日期后缀区分版本 | `g8-study-plan-1016`              |
| locale          | `zh` / `en`                  | `.zh.html`                        |
| 后缀            | 必须是 `.html`               | —                                 |

❌ 反例：`G8学习计划.html`、`g8 plan final (2).html`

## 2. HTML 结构

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>文章标题（必填，用于卡片显示）</title>
    <meta name="description" content="一句话摘要（必填，用于卡片显示）" />
    <style>
      /* 全部 CSS 内联，无外部引用 */
    </style>
  </head>
  <body>
    <article>...</article>
  </body>
</html>
```

### 必填项

- `<meta charset="utf-8">` —— 中文不乱码
- `<title>` —— 博客卡片显示的标题（不从文件名取）
- `<meta name="description">` —— 卡片显示的摘要
- `<html lang="zh">` —— 语言声明

### 禁止项

- ❌ 外部 CSS/JS 引用（`<link>`, `<script src>`）—— 单文件必须自包含
- ❌ 内联 `<script>` 写业务逻辑 —— 仅允许纯展示型脚本
- ❌ `<iframe>` 嵌套外部页面

## 3. 样式规范

- 使用 `tools/publish.py` 生成（已对齐博客 MDX 风格）
- 三套主题：`light` / `dark` / `paper`，默认 `light`
- 字体：`Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- 正文最大宽度 720px，移动端自适应
- 色彩：暖色系（`#f9f8f6` 背景 / `#3a3632` 文字），与站点一致

## 4. 内容规范

| 项       | 规范                                           |
| -------- | ---------------------------------------------- |
| 编码     | UTF-8 无 BOM                                   |
| 大小     | 单文件 ≤ 5MB（API 强制限制）                   |
| 图片     | 优先转 base64 内嵌；外链图片需 HTTPS           |
| 语言     | 中文内容用中文标点，英文内容用英文标点，不混用 |
| 标题层级 | `h1` 只出现一次（文章标题），正文从 `h2` 开始  |

## 5. 分类与关键词规范

分类与关键词同时覆盖 blog 文章与 HTML 文章：

| 项       | blog 文章                                                                             | HTML 文章                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 分类     | `post.categories`（逗号分隔多值文本）；管理页编辑页是下拉单选，选项来自 taxonomy 字典 | `blog_html_file.category`（单值文本）；上传与列表编辑都是下拉框，选项来自同一份 taxonomy 字典（`GET /api/blog/html-categories`） |
| 关键词   | `post.tags`（逗号分隔多值文本）；管理页编辑页在分类下方填                             | `blog_html_file.keywords`（逗号分隔多值文本）；上传表单与列表每条行内填，失焦保存                                                |
| 字典来源 | taxonomy 表（`type='category'` 且 `status='published'`）                              | 同左；“未分类”是遗留默认值，不在字典里                                                                                           |

分类字典在管理页 `/wiki/admin/categories` 维护（新建/改名/软删除）；只建分类不会自动挂到文章上，须在文章编辑页选。

关键词分隔口径：逗号 / 中文逗号 / 顿号 / 分号分隔，去空去空格（`splitKeywordList`，`src/modules/ai-assistant/service.ts`）。

AI 助手检索打分：标题 3 分 → 分类与关键词 2 分 → 简介 1 分。关键词是管理员手填的显式标注，与分类同级；仅关键词命中得 2 分，低于文档关键词兜底的 3 分门槛（`DOC_KEYWORD_MIN_SCORE`），须另有标题/分类/简介命中才进文档链路。

遗留值：旧的 G8学习 / 错题解析 / 工具三类不在字典里——已上传的文章保留原值，列表下拉框会把条目现有值一并列出；改一次分类即归入字典。上传时留空分类仍按标题/内容自动打标（`autoCategorize`）。

## 6. 版本管理

- 更新文章 → 重新上传同名文件（R2 按 key 覆盖，需手动删除旧版）
- 大改版 → 新 slug（如 `g8-study-plan-1023`），旧版保留
- 删除 → 联系管理员从 R2 删除（暂无自助删除 UI）

## 7. 生成工具

```bash
# 从 MDX 生成规范 HTML
python3 tools/publish.py --slug {slug} --locale {locale}

# 批量生成
python3 tools/publish.py --all --theme light
```

生成的文件在 `dist/published/`，直接上传到 `/zh/blog` 即可。
