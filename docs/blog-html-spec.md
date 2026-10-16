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

## 5. 分类规范

上传时填写分类，用于左侧列表筛选。建议分类：

| 分类     | 用途                     |
| -------- | ------------------------ |
| G8学习   | 孩子的学习计划、作业报告 |
| 错题解析 | 错题本相关的讲解         |
| 工具     | 工具使用说明             |
| 未分类   | 默认                     |

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
