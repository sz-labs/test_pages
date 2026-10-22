from contextlib import asynccontextmanager
import hashlib
import hmac
import logging
from pathlib import Path
import secrets
import time
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .excel import MAX_BYTES, parse_excel
from .repository import InventoryRepository
from .settings import Settings, load_mysql_engine, load_settings

logger = logging.getLogger("inventory-api")
bearer = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


def create_app(repository: InventoryRepository | None = None, settings: Settings | None = None):
    config = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app):
        app.state.repository = repository
        app.state.ready = False
        try:
            if app.state.repository is None:
                engine = load_mysql_engine(config.mysql_file)
                app.state.repository = InventoryRepository(engine)
            await run_in_threadpool(app.state.repository.initialize)
            app.state.ready = True
        except Exception as error:
            logger.error("数据库未就绪，请检查 YAML 配置、连接和建表权限。错误类型：%s", type(error).__name__)
        yield
        if app.state.repository:
            app.state.repository.engine.dispose()

    app = FastAPI(title="SZ Labs Inventory API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=config.allowed_origins,
        allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"],
    )
    failed_logins = {}
    signing_key = config.admin_password.encode("utf-8")
    password_hash = hashlib.sha256(signing_key).digest()

    @app.middleware("http")
    async def request_limits(request, call_next):
        length = request.headers.get("content-length")
        if request.url.path == "/api/uploads" and request.method == "POST" and length:
            try:
                too_large = int(length) > MAX_BYTES + 1024 * 1024
            except ValueError:
                return JSONResponse({"detail": "请求大小不正确"}, status_code=400)
            if too_large:
                return JSONResponse({"detail": "文件过大，最大支持 20 MB"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def get_repository(request: Request):
        if not getattr(request.app.state, "ready", False):
            raise HTTPException(503, "共享数据库未就绪，请管理员检查后端配置")
        return request.app.state.repository

    def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        valid = False
        if credentials:
            try:
                expires, nonce, signature = credentials.credentials.split(".")
                payload = f"{expires}.{nonce}"
                expected = hmac.new(signing_key, payload.encode("ascii"), hashlib.sha256).hexdigest()
                valid = int(expires) > time.time() and hmac.compare_digest(signature, expected)
            except (ValueError, UnicodeError):
                pass
        if not valid:
            raise HTTPException(401, "请先以管理员身份登录", headers={"WWW-Authenticate": "Bearer"})

    @app.get("/api/health")
    def health(repo=Depends(get_repository)):
        try:
            repo.ping()
        except Exception:
            raise HTTPException(503, "数据库连接暂时不可用") from None
        return {"status": "ok", "database": "connected"}

    @app.post("/api/session")
    async def login(body: LoginRequest, request: Request):
        now = time.monotonic()
        client = request.client.host if request.client else "unknown"
        attempts = [moment for moment in failed_logins.get(client, []) if now - moment < 300]
        if len(attempts) >= 10:
            raise HTTPException(429, "尝试次数过多，请五分钟后重试")
        if not hmac.compare_digest(hashlib.sha256(body.password.encode("utf-8")).digest(), password_hash):
            attempts.append(now)
            if len(failed_logins) > 10000:
                failed_logins.clear()
            failed_logins[client] = attempts
            raise HTTPException(401, "管理口令不正确")
        failed_logins.pop(client, None)
        expires = int(time.time()) + 8 * 3600
        payload = f"{expires}.{secrets.token_hex(16)}"
        signature = hmac.new(signing_key, payload.encode("ascii"), hashlib.sha256).hexdigest()
        return {"accessToken": f"{payload}.{signature}", "expiresIn": 8 * 3600}

    @app.get("/api/uploads")
    def list_uploads(repo=Depends(get_repository)):
        try:
            return {"items": repo.list_uploads()}
        except Exception as error:
            logger.error("读取上传列表失败：%s", type(error).__name__)
            raise HTTPException(503, "暂时无法读取共享记录，请稍后重试") from None

    @app.get("/api/uploads/{upload_id}")
    def get_upload(upload_id: UUID, repo=Depends(get_repository)):
        try:
            upload = repo.get_upload(str(upload_id))
        except Exception as error:
            logger.error("读取库存记录失败：%s", type(error).__name__)
            raise HTTPException(503, "暂时无法读取数据，请稍后重试") from None
        if upload is None:
            raise HTTPException(404, "没有找到这份上传记录")
        return upload

    @app.post("/api/uploads", dependencies=[Depends(require_admin)])
    def upload_excel(file: UploadFile, response: Response, repo=Depends(get_repository)):
        filename = Path((file.filename or "").replace("\\", "/")).name
        if not filename.lower().endswith(".xlsx") or len(filename) > 255:
            raise HTTPException(400, "请选择文件名不超过 255 字符的 .xlsx 文件")
        content = file.file.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise HTTPException(413, "文件过大，最大支持 20 MB")
        try:
            parsed = parse_excel(content)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        try:
            result = repo.save_upload(filename, content, parsed)
        except Exception as error:
            logger.error("保存库存记录失败：%s", type(error).__name__)
            raise HTTPException(503, "保存失败，请检查数据库连接后重试；重复上传同一文件会自动去重") from None
        response.status_code = 200 if result["duplicate"] else 201
        return {**result, "skippedSheets": parsed["skippedSheets"]}

    return app


app = create_app()
