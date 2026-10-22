# 库存更新记录

Vue 3 + Vite 前端，Python FastAPI 后端，MySQL 持久化。GitHub Pages 只部署前端；Python 需要单独运行在可提供 HTTPS 接口的服务器上。

```text
frontend/
├── src/                    # Vue 单文件组件、样式、Excel 解析 worker
├── tests/                  # 前端数据处理测试
├── package.json
├── package-lock.json
└── vite.config.js
backend/
├── app.py                  # 独立 FastAPI 服务，只提供 API
├── excel.py                # 服务端 Excel 校验和解析
├── repository.py           # MySQL 事务、查询和文件去重
├── settings.py
├── mysql.example.yaml      # 数据库连接模板，不含真实凭据
├── requirements.txt
├── tests/
└── Dockerfile
.github/workflows/deploy.yml # 仅构建并部署 frontend/dist
```

## 功能和表格格式

选择或拖放 `.xlsx` 文件，先预览，再由管理员登录发布。发布后保存在 MySQL，其他访客无需登录即可查看已发布记录。支持上传历史、搜索、仓库和类型筛选、排序、分页，以及记录数、SKU 数、入库和出库数量统计。

使用 `库存更新记录_2026-10-22.xlsx` 的 14 列格式：SKU编号、SKU名称、账号、时间、货架位、原库存、变动、新库存、仓库、原成本价、出入库价、现成本价、类型、单据号。支持表头换序和多工作表，保留 SKU 前导零及原始小数位。同一文件按 SHA-256 去重；每次导入在一个数据库事务内完成。单文件最大 20 MB、50,000 条记录。

## 本地启动

需要 Python 3.12+、Node.js 24。以下命令均从仓库根目录开始，终端示例使用 PowerShell。

1. 配置 Python 和数据库：

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
   # 已有 mysql.local.yaml 时保留原文件，不要覆盖。
   Copy-Item backend/mysql.example.yaml mysql.local.yaml
   ```

   填写根目录 `mysql.local.yaml`。它与 GitHub token 所在的 `.env` 都已被 Git 忽略，不会进入前端构建。后端也可通过 `MYSQL_CONFIG_FILE` 指定私有 YAML 路径，或通过 `MYSQL_CONFIG_YAML` 环境变量传入完整 YAML。

2. 在第一个终端启动 API：

   ```powershell
   .\.venv\Scripts\python.exe -m backend.check_connection
   .\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
   ```

   首次运行会创建 `pages_inventory_uploads` 和 `pages_inventory_records` 两张应用表。未设置 `ADMIN_PASSWORD` 时，本机生成的管理口令保存在被忽略的 `backend/admin.local.txt`。接口文档：<http://127.0.0.1:8000/docs>。

3. 在第二个终端启动前端：

   ```powershell
   cd frontend
   npm ci
   npm run dev
   ```

   打开 <http://127.0.0.1:5173/test_pages/>。开发环境通过 Vite 将 `/api` 代理到 `127.0.0.1:8000`，不需要额外配置。Excel 解析在 worker 中执行。

## GitHub Pages 部署

1. 在 [Pages 设置](https://github.com/sz-labs/test_pages/settings/pages) 的 **Build and deployment → Source** 选择 **GitHub Actions**。
2. 推送 `develop` 上的前端修改会运行 `Deploy frontend to GitHub Pages`；也可以在 [Actions](https://github.com/sz-labs/test_pages/actions) 中手动运行。
3. 工作流安装前端依赖、运行前端测试、执行 Vite 构建，只上传 `frontend/dist`。`base` 已设置为 `/test_pages/`。
4. 部署成功后访问 <https://sz-labs.github.io/test_pages/>。

目前只有 MySQL 时，Pages 上可以导入并预览本机 Excel；共享数据库功能还需要独立 Python 服务。Pages 和 Actions 都不会持续运行此后端。

后端部署完成后，在 [Actions 仓库变量](https://github.com/sz-labs/test_pages/settings/variables/actions) 中添加 `VITE_API_BASE_URL`，填入公网 HTTPS API 根地址，例如 `https://api.example.com`（不带 `/api`），然后手动运行部署工作流。这个变量会写入公开的网页文件，只能填写公开接口地址。未配置时页面会提示共享服务未连接。

## 独立部署后端

将 Python 后端部署到服务器，设置私有数据库 YAML 和至少 16 字符的 `ADMIN_PASSWORD`，启动 `python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000`，通过反向代理提供 HTTPS。`ALLOWED_ORIGINS` 默认允许 `https://sz-labs.github.io`；自定义域名时设置为实际前端的 origin，多个以逗号分隔。

也可使用仓库内的 Docker 配置：将 `backend/.env.example` 复制为 `backend/.env` 并填写域名和管理口令，保留根目录的私有 `mysql.local.yaml`，在服务器执行：

```sh
docker compose --env-file backend/.env -f backend/compose.yaml up -d --build
```

需提前将 API 域名指向服务器，并开放 80/443；Caddy 会申请 HTTPS 证书。镜像只包含 Python 服务，数据库配置以只读文件挂载。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest
cd frontend
npm test
npm run build
```

后端测试使用内存 SQLite，不写入真实 MySQL。覆盖管理员上传、匿名读取、重复文件去重、失败事务回滚、Excel 原始值保留及前后端隔离；前端测试覆盖 14 列解析、格式校验、筛选、数值排序和统计。
