# 错题本 Pro Blog 内网部署（eu.sysmex.com.cn/wiki/）

> 一页纸。完整方案见目标机外的部署方案文档；这里只写实施时要敲的命令和要填的值。

## 架构

```
浏览器（公司网内） ── https://eu.sysmex.com.cn/wiki/ ──► PRD nginx (443)
                                                          location /wiki/
                                                          proxy_pass http://cuotiben-pro-blog:3000;
                                                                             │
                                                  ┌──────────────────────────┘
                                                  ▼
                                   cuotiben-pro-blog 容器 (Node 22, :3000)
                                     ├─ SQLite /app/data/blog.db
                                     │   （blog_html_file 元数据表）
                                     ├─ HTML 本体 /app/data/blog-html/*.html
                                     └─ AAD 校验 ──► http://10.40.20.195:8082
```

- **独立栈**：`docker-compose.intranet.yml` 一个服务，不动 ai-shifu 的任何
  compose/nginx/容器；唯一共享的是 `docker_default` 网络（PRD nginx 容器所
  在网，blog 容器加入该网，nginx 以容器名 `cuotiben-pro-blog:3000` 反代——
  nginx 容器不是 host 网络，容器内 `127.0.0.1:3210` 指它自己、到不了 blog）。
  应用另绑 `127.0.0.1:3210` 供主机侧直查，不直接对外。
- **存储**：本地磁盘 + SQLite。Cloudflare 线上站继续走 R2，代码按运行时
  自动选择（`globalThis.__CF_ENV__.HTML_BUCKET` 有则 R2，否则本地）。
- **登录**：内部 AAD（工号 + 密码，`POST /api/auth/aad`）。AAD 不是微软
  Entra，不走 OAuth；首次通过即建号（合成邮箱 `工号@sysmex.internal`），
  本地不存密码。密码错误 401、AAD 不可用 503。
- **可见范围**：上传时选「全体可见」（默认）或「仅自己可见」；列表与正文
  都在服务端按会话过滤；删除/改分类仅上传者本人或管理员。
- **正文鉴权**：内网版 `GET /api/blog/html/:key` 必须登录（未登录 401）；
  Cloudflare 版保持公开渲染不变。

## Env 清单（.env.intranet，服务器上从 .env.intranet.example 复制后真填）

| 变量                     | 值                              | 备注                           |
| ------------------------ | ------------------------------- | ------------------------------ |
| `VITE_APP_URL`           | `https://eu.sysmex.com.cn/wiki` | 构建期公开值（build arg）      |
| `AUTH_URL`               | 同上                            | better-auth base URL           |
| `AUTH_TRUSTED_ORIGINS`   | `eu.sysmex.com.cn`              |                                |
| `AUTH_COOKIE_PREFIX`     | `cuotiben_wiki_`                | 与 ai-shifu 的 cookie 分开     |
| `AUTH_SECRET`            | `openssl rand -base64 32` 生成  | **必须真填**，占位值会拒绝启动 |
| `APP_BASE_PATH`          | `/wiki`                         | 构建期 + 运行期都要是这个值    |
| `VITE_AAD_LOGIN_ENABLED` | `true`                          | 构建期公开值，显示工号登录表单 |
| `DATABASE_PROVIDER`      | `sqlite`                        |                                |
| `DATABASE_URL`           | `file:/app/data/blog.db`        | 在数据卷里                     |
| `AAD_AUTH_URL`           | `http://10.40.20.195:8082`      | 内网 AAD                       |
| `NO_PROXY` / `no_proxy`  | 含 `10.40.20.195`               | 见下                           |
| `BLOG_HTML_DIR`          | `/app/data/blog-html`           | 在数据卷里                     |

`NO_PROXY` 说明：Node 的 fetch 不读代理环境变量，AAD 调用本来就直连；
这里仍要求写上，是给 curl 排障和主机上其他代理感知工具用的。

## 部署步骤（服务器上，`/home/sysmex/cuotiben-pro-blog/` 或自选目录）

```bash
# 1. 取代码、建分支内容已在 feat/blog-intranet-aad，直接用它
git clone https://github.com/lngyneric/cuotiben-pro.git cuotiben-pro-blog
cd cuotiben-pro-blog
git checkout feat/blog-intranet-aad

# 2. 填 env（AUTH_SECRET 必须真生成，其他按上表）
cp .env.intranet.example .env.intranet
openssl rand -base64 32   # 把输出填进 .env.intranet 的 AUTH_SECRET
# 编辑 .env.intranet …

# 3. 构建并启动（只操作本项目的 compose 文件，绝不用裸 docker compose）
docker compose -f docker-compose.intranet.yml up -d --build

# 4. 看日志、确认监听在回环端口
docker logs cuotiben-pro-blog --tail 50
ss -tlnp | grep 3210   # 应只有 127.0.0.1:3210
```

## nginx 片段（PRD nginx，服务器上是 `/home/sysmex/ai-shifu/docker/nginx.conf`，容器 `ai-shifu-nginx`，443 server 块）

> 只加这一段，不动其他 location。改前备份原文件，改后 `nginx -t` 再 reload；
> Dev 的 `nginx.dev.conf` 一个字不动。

```nginx
# 错题本 Pro blog（内网版）——注意 proxy_pass 不带 URI，不剥离 /wiki 前缀，
# 应用原生匹配 /wiki/...（Vite base + router basepath 已 baked 进镜像）。
# 静态资源例外：Nitro 只在根路径 /assets/... 下提供 public 文件，HTML 里
# 的 /wiki/assets/... 到容器会 404（且应用层改写 URL 也救不了——Nitro 的
# 静态中间件在应用 handler 之前跑，改写后的请求只会撞上路由器的 basepath
# 重定向）。所以静态路径在 nginx 这一层先剥掉 /wiki 前缀再反代；页面与
# API 请求保持原样走 /wiki/。
location /wiki/assets/ {
    rewrite ^/wiki/(.*)$ /$1 break;
    proxy_pass http://cuotiben-pro-blog:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location /wiki/imgs/ {
    rewrite ^/wiki/(.*)$ /$1 break;
    proxy_pass http://cuotiben-pro-blog:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location = /wiki/favicon.svg {
    rewrite ^/wiki/(.*)$ /$1 break;
    proxy_pass http://cuotiben-pro-blog:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /wiki/logo.svg {
    rewrite ^/wiki/(.*)$ /$1 break;
    proxy_pass http://cuotiben-pro-blog:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /wiki/ {
    proxy_pass http://cuotiben-pro-blog:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    client_max_body_size 6m;
}
```

重载（只重载 PRD nginx 容器，不重建其他容器）：

```bash
docker exec ai-shifu-nginx nginx -t
docker exec ai-shifu-nginx nginx -s reload
```

## 验证步骤

```bash
# 1. 未登录调列表接口：应 401（不是 ai-shifu 的页面）
curl -s -o /dev/null -w '%{http_code}\n' https://eu.sysmex.com.cn/wiki/api/blog/html
# 2. 博客页能开，且 HTML 里的静态资源 URL 都带 /wiki 前缀
curl -s https://eu.sysmex.com.cn/wiki/blog | grep -o '/wiki/_build/[^"]*' | head -3
# 3. 工号登录（浏览器开 https://eu.sysmex.com.cn/wiki/sign-in，用“工号登录”表单）
#    错密码应提示“工号或密码不正确”；AAD 挂了应提示“企业账号服务暂时不可用”
# 4. 登录后上传一篇 HTML（选“仅自己可见”），列表只对自己可见；
#    换个号登录应看不到它；管理员能看到
# 5. 同时登录 ai-shifu 和 blog，确认互不踢下线（cookie 前缀已分开）
```

## 回滚

```bash
# 1. 删 nginx 的 location /wiki/ 段，nginx -t 后 reload
# 2. 停本项目容器（数据卷保留，文档不丢）
docker compose -f docker-compose.intranet.yml down
# 3. 云端站 https://cuotiben-pro.lng-yn.workers.dev/zh/blog 不受任何影响
```

备份：`cuotiben-blog-data` 卷（`blog.db` + `blog-html/` 目录）成对打包，
按日留 30 天；恢复时整个卷一起恢复，缺一半会出现“有元数据无文件”。

## 存量迁移（Cloudflare R2 里的 6 篇）

R2 的对象 key 已经是 `html/...`，与本地表主键格式一致。任选其一：

1. **重新上传**：从 `/zh/blog` 下载各篇 HTML，在内网 blog 页重新上传
   （标题/摘要/分类会自动提取，上传者记为操作人）；
2. **脚本迁移**：用 `wrangler r2 object get` 批量取回后按
   `BLOG_HTML_DIR` + `blog_html_file` 行写入（文件与元数据行必须成对）。
