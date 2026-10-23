# 将 Python 后端部署到自己的临时服务器

前端由 develop 分支构建并发布到 https://sz-labs.github.io/test_pages/ 。后端部署到你自己的服务器，连接现有 MySQL。浏览器访问公开 HTTPS API；MySQL 配置只在后端读取。

本指南以 Linux 服务器 + Docker Engine + Docker Compose 为例。服务器需要能够连接现有 MySQL，至少有足够内存处理 20 MiB Excel（建议 2 GB 可用内存），并有一个指向服务器公网 IP 的 API 域名。只有本机安装了 Docker 并能访问镜像源，才可以在本机预先构建镜像；提供的 tar.gz 是后端源码部署包，在服务器构建镜像。

## 1. 在 Windows 本机打包

在 PowerShell 执行：

```powershell
cd D:\CodexAIProject\github-pages
.\.venv\Scripts\python.exe scripts/package_backend.py
```

生成 dist/inventory-backend.tar.gz、SHA-256 校验文件和文件清单。部署包仅含 Python 源码、锁定依赖、Docker 配置、配置模板和本指南，不包含真实数据库配置、管理口令、GitHub token、前端依赖或原始 Excel。

如服务器已有 Docker 和 Compose，确认 `docker --version` 和 `docker compose version` 均成功即可。安装方法按服务器发行版使用 Docker 官方文档：https://docs.docker.com/engine/install/ 。Compose 插件：https://docs.docker.com/compose/install/linux/ 。Windows Server 或已有 Nginx/宝塔占用 80/443 时，先按实际环境调整部署方式，不要直接停掉已有服务。

## 2. 上传源码包和私有配置

先用服务器的 SSH 账号创建专用目录（将下面所有示例用户名、IP、域名替换成自己的）：

```powershell
ssh deploy@服务器IP "mkdir -p ~/inventory-pages"
scp dist/inventory-backend.tar.gz dist/inventory-backend.tar.gz.sha256 deploy@服务器IP:~/inventory-pages/
scp mysql.local.yaml deploy@服务器IP:~/inventory-pages/mysql.local.yaml
```

也可通过自己的 SFTP 工具上传相同文件。本项目根目录的 `.env` 是 GitHub token 文件，**不要上传**。当前私有 mysql.local.yaml 的库名已改为 business_database，复制这个文件即可；它不在公开仓库和部署包里。

若 YAML 启用了 MySQL TLS 且配置了 ca_file，同时上传对应 CA 证书，并把路径改为容器内可读取的路径（需要在 compose.yaml 为该证书增加只读挂载）。现有数据库的 IP 白名单应允许临时服务器的出口 IP。不要把 YAML 的主机改成 localhost，除非 MySQL 确实在 API 容器自身运行。

## 3. 在服务器解压并填写后端环境变量

SSH 登录服务器后执行（后续命令均为 Linux shell 命令）：

```sh
cd ~/inventory-pages
sha256sum -c inventory-backend.tar.gz.sha256
tar -xzf inventory-backend.tar.gz
chmod 600 mysql.local.yaml
cp backend/.env.example backend/.env
chmod 600 backend/.env
nano backend/.env
```

填写三项，管理口令请自行生成至少 16 字符的随机值：

```dotenv
API_DOMAIN=api.你的域名.com
ADMIN_PASSWORD=替换为自己的随机管理口令
ALLOWED_ORIGINS=https://sz-labs.github.io
```

API_DOMAIN 仅填域名，不带 https:// 和路径。ALLOWED_ORIGINS 填前端来源，不加 /test_pages/。在 DNS 添加 API 域名 A 记录指向临时服务器公网 IPv4；如有 AAAA 记录，确保 IPv6 也确实能到达该服务器。开放入站 TCP 80、443，确保这些端口可用。本配置不向公网开放 Python 8000 端口。

## 4. 构建并启动

先验证数据库连通性，这一步只执行 SELECT 1，不建表、不写业务数据：

```sh
docker compose --env-file backend/.env -f backend/compose.yaml build inventory-api
docker compose --env-file backend/.env -f backend/compose.yaml run --rm --no-deps inventory-api python -m backend.check_connection
```

成功后启动：

```sh
docker compose --env-file backend/.env -f backend/compose.yaml up -d
docker compose --env-file backend/.env -f backend/compose.yaml ps
docker compose --env-file backend/.env -f backend/compose.yaml logs --tail=100 inventory-api caddy
```

API 启动时自动检查并创建不存在的 pages_inventory_uploads、pages_inventory_records 表，不删除原有记录。此项目已在 business_database 使用这两张表；服务器连接同一个库后会读取同一份已发布数据。不要运行任何清库 SQL。

Caddy 在 DNS 和端口配置满足条件时自动申请并续期公网 HTTPS 证书。等待几十秒到数分钟后检查：

```sh
curl --fail https://api.你的域名.com/api/health
curl --fail https://api.你的域名.com/api/uploads
curl -i -X OPTIONS https://api.你的域名.com/api/uploads -H 'Origin: https://sz-labs.github.io' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'
```

健康检查预期：`{"status":"ok","database":"connected"}`；预检响应应带 `access-control-allow-origin: https://sz-labs.github.io`。可以浏览 https://api.你的域名.com/docs 查看接口文档。不要把管理口令写进 URL 或前端配置。

## 5. 将 Pages 前端连接到此后端

后端健康检查通过后，打开：

https://github.com/sz-labs/test_pages/actions/workflows/deploy.yml

点击 Run workflow：

1. Branch 选择 develop。
2. api_base_url 填完整 HTTPS 根地址，例如 https://api.你的域名.com ，不带结尾 /api。
3. 点击绿色 Run workflow，等待 build、deploy 都成功。

这次手动填写只对这次构建生效。后续推送也要沿用此地址时，打开 https://github.com/sz-labs/test_pages/settings/variables/actions 新增仓库变量 VITE_API_BASE_URL，值同上，然后再部署。变量中只能放公开 API 地址；不要放数据库密码或管理口令。

如果 Pages 设置当前仍是 Deploy from a branch，改成 GitHub Actions：https://github.com/sz-labs/test_pages/settings/pages 。发布结果以 Actions 的 deploy 成功为准。

## 6. 从公网验收

打开 https://sz-labs.github.io/test_pages/ 并刷新，应显示“共享服务已连接”，能看到现有上传历史。用后端 backend/.env 中的 ADMIN_PASSWORD 在页面登录，选择符合 14 列格式的 Excel → 预览 → 发布；再用无痕窗口或另一台电脑打开 Pages，验证无需登录即可看到发布数据。重复发布相同文件会去重。

Pages 上传限制 20 MiB / 50,000 行。后端管理令牌有效期 8 小时。服务器需持续运行，关闭本机开发服务不会影响服务器上的数据访问；临时服务器关闭后，Pages 页面仍可打开，但共享数据接口不可用。

## 排障、停止与更新

- 页面仍提示“共享服务未连接”：检查是否在 develop 的 Run workflow 填了地址，或仓库变量是否设置后重新构建。浏览器的旧标签页可强制刷新。
- 共享服务连接失败：先单独访问 /api/health；确认公网 HTTPS 证书有效、后端容器 healthy、MySQL 允许服务器出口 IP；CORS 只填 https://sz-labs.github.io。
- Caddy 启动失败或证书申请失败：检查 DNS、80/443 防火墙、安全组及端口占用。已有反向代理时应复用原代理和证书，而不是让两个服务抢占端口。
- 容器日志提示数据库未就绪：检查私有 YAML、数据库权限及网络；修改配置后执行 restart inventory-api。
- 轮换管理口令：编辑 backend/.env 后执行 up -d --force-recreate inventory-api，新口令会使旧登录令牌失效。
- 上传超时：检查服务器资源以及已有反向代理的请求体大小（至少允许 21 MiB multipart 请求）和超时（建议至少 120 秒）。

```sh
# 停止本项目，不操作 MySQL 数据；不要附加 -v 删除证书卷。
docker compose --env-file backend/.env -f backend/compose.yaml down

# 更新源码：上传并解压新包后，保留现有 mysql.local.yaml 和 backend/.env。
docker compose --env-file backend/.env -f backend/compose.yaml up -d --build
```

参考：GitHub Pages 自定义 Actions 工作流 https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages ；Caddy 自动 HTTPS https://caddyserver.com/docs/automatic-https 。
