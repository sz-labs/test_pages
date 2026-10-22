from dataclasses import dataclass
from pathlib import Path
import os
import secrets

import yaml
from sqlalchemy import URL, create_engine

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Settings:
    mysql_file: Path
    admin_password: str
    allowed_origins: list[str]


def load_settings() -> Settings:
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not password:
        password_file = ROOT / "backend" / "admin.local.txt"
        if password_file.exists():
            password = password_file.read_text(encoding="utf-8").strip()
        else:
            password = secrets.token_urlsafe(24)
            password_file.write_text(password + "\n", encoding="utf-8")
            try:
                password_file.chmod(0o600)
            except OSError:
                pass
    if len(password) < 16:
        raise ValueError("管理员口令至少需要 16 个字符，请设置 ADMIN_PASSWORD")
    origins = os.environ.get(
        "ALLOWED_ORIGINS",
        "https://sz-labs.github.io,http://127.0.0.1:5173,http://localhost:5173",
    )
    return Settings(
        mysql_file=Path(os.environ.get("MYSQL_CONFIG_FILE", str(ROOT / "mysql.local.yaml"))),
        admin_password=password,
        allowed_origins=[value.strip().rstrip("/") for value in origins.split(",") if value.strip()],
    )


def load_mysql_engine(filename: Path):
    try:
        source = os.environ.get("MYSQL_CONFIG_YAML") or filename.read_text(encoding="utf-8-sig")
        config = yaml.safe_load(source)["mysql"]
    except Exception:
        raise ValueError("无法读取 MySQL YAML 配置，请检查文件路径和 YAML 格式") from None
    for key in ("host", "database", "username", "password"):
        if not isinstance(config.get(key), str) or not config[key] or "你的" in config[key]:
            raise ValueError(f"请在 MySQL YAML 配置中填写 mysql.{key}")
    if config.get("charset", "utf8mb4") != "utf8mb4":
        raise ValueError("库存数据包含中文，mysql.charset 请使用 utf8mb4")
    port = int(config.get("port", 3306))
    pool_size = int(config.get("pool_size", 5))
    timeout = int(config.get("connect_timeout_ms", 10000)) / 1000
    if not 1 <= port <= 65535 or not 1 <= pool_size <= 20 or not 1 <= timeout <= 60:
        raise ValueError("MySQL 端口、连接池大小或超时设置不正确")
    connect_args = {"connect_timeout": int(timeout), "read_timeout": 30, "write_timeout": 30}
    ssl = config.get("ssl") or {}
    if ssl.get("enabled"):
        tls = {"check_hostname": True}
        if ssl.get("ca_file"):
            ca = Path(ssl["ca_file"])
            if not ca.is_absolute():
                ca = filename.parent / ca
            if not ca.is_file():
                raise ValueError("MySQL TLS CA 证书文件不存在")
            tls["ca"] = str(ca)
        connect_args["ssl"] = tls
        connect_args["ssl_verify_cert"] = True
        connect_args["ssl_verify_identity"] = True
    url = URL.create(
        "mysql+pymysql", host=config["host"], port=port, username=config["username"],
        password=config["password"], database=config["database"], query={"charset": "utf8mb4"},
    )
    return create_engine(
        url, connect_args=connect_args, pool_size=pool_size,
        max_overflow=pool_size, pool_pre_ping=True, pool_recycle=300,
    )
