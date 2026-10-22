# 库存更新记录工作台 · test

本分支基于 develop 的 `3ab8565`，改为 **Vue 3 + Vercel JavaScript 云函数 + 现有 MySQL**。浏览器解析 Excel 做预览，云函数独立重新解析原文件并写库，其他访客匿名读取完整发布的记录。无需 Python。推送到 `test` 后，GitHub Actions 先测试和构建，通过后自动发布 Vue 前端到 GitHub Pages。

## 项目结构

```text
frontend/                   Vue 页面、Worker、Vite 构建
shared/                     浏览器与服务端共用的 Excel 解析及格式规则
api/inventory.js             Vercel Node.js 24 云函数入口
service/                    路由、认证、MySQL 事务和分页
scripts/dev-api.mjs          本地 JavaScript API 服务
config/mysql.example.yaml   私有 MySQL 配置模板
database/001_import_support.sql  辅助表初始化（手动执行）
tests/                      单元及独立 MySQL 集成测试
vercel.json                 构建 frontend/dist，/api 转发到云函数
.github/workflows/test.yml   测试、构建及 test 分支 Pages 发布
```

## 本地启动

使用 Node.js **24.x**，在仓库根目录执行：

```powershell
npm ci
Copy-Item .env.example .env.local
# 没有现成私有配置时再复制；已有 mysql.local.yaml 请保留。
Copy-Item config/mysql.example.yaml mysql.local.yaml
```

填写 `mysql.local.yaml`。在 `.env.local` 设置独立、随机、至少 16 字符的 `ADMIN_PASSWORD`，以及 `MYSQL_CONFIG_FILE=./mysql.local.yaml`。管理口令不会自动采用旧 Python 服务的口令，可手动设置为原口令以延续管理员使用习惯。

连接配置、管理口令和 GitHub token 均属于私有配置。`.env` 继续用于本地 GitHub token，Node 服务只显式加载 `.env.local`，前端不会读取数据库配置。真实口令不要写入本 README、代码或任何 `VITE_` 环境变量。

首次使用 JavaScript 写入前，按下一节执行辅助表初始化，然后打开两个终端：

```powershell
# 终端一：API，http://127.0.0.1:8000
npm run dev:api
```

```powershell
# 终端二：页面，http://127.0.0.1:5173/
npm run dev
```

Vite 将 `/api` 代理至本机 8000 端口。前端默认同源 `/api`，不需要配置 `VITE_API_BASE_URL`。如需连接另一个已部署的 HTTPS API，可在 `frontend/.env.local` 配置 `VITE_API_BASE_URL`，并将网页来源加入服务端 `ALLOWED_ORIGINS`。

## 数据库初始化：只增加辅助表

继续使用 develop 的 `pages_inventory_uploads`、`pages_inventory_records` 两张业务表，字段及 SHA-256 唯一约束保持兼容。业务表需要事先存在，本版本不会自动建表或修改业务表。

在 Navicat 中连接**现有库存数据库**，检查后执行 `database/001_import_support.sql`，或使用 MySQL 客户端：

```text
mysql --host=你的主机 --user=你的用户 --password 你的库名
mysql> SOURCE database/001_import_support.sql;
```

SQL 只新增 `pages_inventory_import_sessions`、`pages_inventory_import_chunks`、`pages_inventory_auth_limits`。可重复执行。应用账号需要业务表和辅助表的 SELECT / INSERT / UPDATE / DELETE 权限；执行初始化的账号另外需要 CREATE / REFERENCES 权限。应用运行时不需要 DDL 权限。

`tests/integration/schema.sql` **只用于隔离测试库**，请勿在业务库执行。此次代码交付不会执行任何真实数据库迁移。

## GitHub Pages 自动发布

访问地址为 https://sz-labs.github.io/test_pages/。推送到 `test` 后，工作流在独立 MySQL 中运行测试，以 `/test_pages/` 为资源基础路径构建，然后只上传 `frontend/dist` 并发布。拉取请求只运行验证，不部署。

仓库 Settings → Pages 的 Source 需要为 GitHub Actions；Settings → Environments → github-pages 的部署分支规则需要允许 `test`。同一仓库的其他分支如果也发布 Pages，会覆盖这个站点。

Pages 只托管前端。未部署云函数时，可以打开页面、选择 Excel 并预览，数据库共享功能尚不可用。云函数部署完成后，在 Settings → Secrets and variables → Actions → Variables 配置公开变量 `VITE_API_BASE_URL`，值为 API 的 HTTPS 站点根地址（例如 `https://your-project.vercel.app`，不带 `/api`），然后重新运行工作流或推送提交。服务端 `ALLOWED_ORIGINS` 需包含 `https://sz-labs.github.io`。不要把 MySQL 凭据或管理口令放入该变量。

本机构建命令为 `npm run build --workspace frontend -- --base=/test_pages/`，生成文件位于 `frontend/dist`。本地构建不会自动发布；推送代码后的工作流负责发布。Vercel 继续使用默认 `/` 基础路径独立构建。

## 后续手动部署到 Vercel

Vercel 云函数需另行部署。可在 Vercel 中导入 `sz-labs/test_pages`，选择本分支 `test`，Root Directory 保持仓库根目录，Framework Preset 选择 Other。根目录 `vercel.json` 已配置：

- Node.js 24.x（根 `package.json` 的 engines）。
- 安装：`npm ci`；构建：`npm run build`；输出：`frontend/dist`。
- `/api/*` 路由至 JavaScript 云函数，单次完成发布最长 300 秒。

如果希望生产域名固定指向此版本，可在 Vercel 项目 Git 设置中将 Production Branch 设为 `test`；Preview 和 Production 各自需要对应环境变量。

设置以下**服务端**环境变量，再手动部署：

| 变量 | 内容 |
| --- | --- |
| `MYSQL_CONFIG_YAML` | 私有 YAML 文件的完整内容，根节点为 `mysql:`；密码用 YAML 字符串正确引用 |
| `ADMIN_PASSWORD` | 至少 16 字符的随机管理口令 |
| `ALLOWED_ORIGINS` | 可选，逗号分隔的额外网页来源；同源网页自动允许 |

Vercel 通过 `MYSQL_CONFIG_YAML` 读取连接信息，不依赖本机 `mysql.local.yaml`。TLS 如需自定义 CA，请使用 YAML 的 `mysql.ssl.ca_pem: |` 多行字符串，参见配置模板；验证服务端证书始终开启。数据库需要允许 Vercel 所在网络连接。先手动执行辅助表 SQL，再启用管理员公网写入。

部署后访问 Vercel 分配的 HTTPS 域名，可先检查 `/api/health`，再匿名读取上传列表。仅访问当前 GitHub Pages 域名不会自动运行云函数；需要 Vercel 部署完成后访问它的域名，或将 Pages 的前端构建指向已部署 API。

## 上传、发布与读取

支持 `.xlsx`，文件大小最大 **20 MiB**，总计最多 **50,000 条记录**。表头仍为原来的 14 列：SKU编号、SKU名称、账号、时间、货架位、原库存、变动、新库存、仓库、原成本价、出入库价、现成本价、类型、单据号。保留源单元格显示字符串、小数位和 SKU 前导零；数字投影另存 DECIMAL，不改变原始字符串。

1. 选择或拖入 Excel，Worker 解析并预览，可筛选、排序、查看统计。
2. 管理员登录，点击发布。令牌有效 8 小时，仅保存在页面内存中。
3. 原文件每块 **1 MiB**，最多两块并发上传。暂存位置为 MySQL 辅助表。
4. 完成接口重组原文件，校验大小和 SHA-256，服务端再次解析。一次事务写入两张现有业务表后才向访客可见。
5. 同一文件按 SHA-256 去重。重复完成请求、并发发布和完成响应丢失后重试返回原记录，不追加重复业务数据。事务失败保留分块供重试。

上传进度和会话编号保存在当前标签页的 sessionStorage（不保存管理口令或令牌）。刷新或中断后，在同一标签页重新登录、选择相同文件并点击发布，可查询已有分块继续上传。暂存会话固定保留 24 小时；新建上传请求触发过期会话及分块清理，每次最多 10 个会话。成功发布立即清除原始文件分块，保留会话回执至过期。取消接口可删除未完成会话。

为约束解压内存，工作簿最多 2,048 个内部 ZIP 条目，声明解压总量最多 128 MiB。数据库 VARCHAR 字段最多 255 字符、SKU 名称最多 65,535 UTF-8 字节，其他原始数值字段最多 4,096 字节。超出限制会提示拆分或整理文件。

匿名明细按游标读取，每页最多 500 条，JSON 响应不超过 1 MiB；前端合并完整记录后继续使用原有筛选、排序和统计。管理员连续 10 次口令失败后需等待 5 分钟，限流状态保存在 MySQL，可跨云函数实例生效。

## API

| 方法与路径 | 权限与用途 |
| --- | --- |
| `GET /api/health` | 匿名，连接健康检查 |
| `POST /api/session` | 管理口令换取 8 小时令牌，JSON `{password}` |
| `GET /api/uploads` | 匿名，最近 50 份完整发布记录 |
| `GET /api/uploads/:id` | 匿名，上传信息和工作表列表 |
| `GET /api/uploads/:id/records?cursor=0` | 匿名，`items` 和 `nextCursor`，null 表示结束 |
| `POST /api/imports` | 管理员，JSON `{fileName,size,sha256}`，创建会话或返回已发布记录 |
| `GET /api/imports/:id` | 管理员，已接收分块编号或发布回执 |
| `PUT /api/imports/:id/chunks/:index` | 管理员，原始二进制分块，编号从 0 起；相同内容可重试 |
| `POST /api/imports/:id/complete` | 管理员，完整校验并事务发布 |
| `DELETE /api/imports/:id` | 管理员，取消会话；不删除已发布的业务记录 |

管理员请求使用 `Authorization: Bearer <accessToken>`。4xx 错误需按提示处理，网络错误或 5xx 可重试；客户端自动重试临时失败的分块，发布请求失败后可再次点击发布查询原会话回执。

## 验证

```powershell
npm test
npm run build
```

GitHub Actions 在独立 MySQL 8.4 服务中运行 `npm run test:integration`，验证 20 MiB 上传、缺块、重复分块、哈希不符、损坏文件、断线重试、匿名分页、事务回滚、重复/并发发布和共享限流。测试显式要求 `INVENTORY_TEST_MYSQL=1`、数据库名 `inventory_ci`、主机为 localhost/127.0.0.1，且必须提供测试用 `MYSQL_CONFIG_YAML`；不会自动读取本机业务库配置。未配置隔离环境时，集成测试显示 skipped。

构建产物及源码不包含私有 YAML、GitHub token、管理口令和业务 Excel。`shared/vendor` 为原有 SheetJS 0.20.3 的本地模块和许可证，保持浏览器 Worker 与云函数解析一致。
