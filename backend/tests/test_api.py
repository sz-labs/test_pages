from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.pool import StaticPool

from backend.excel import HEADERS, parse_excel
from backend.app import create_app
from backend.repository import InventoryRepository, records, uploads
from backend.settings import Settings
from backend.settings import load_mysql_engine

PASSWORD = "test-admin-password-12345"


def workbook_bytes(rows=None, headers=HEADERS):
    book = Workbook()
    sheet = book.active
    sheet.title = "库存记录"
    sheet.append(headers)
    for row in rows or [sample_row()]:
        sheet.append(row)
    output = BytesIO()
    book.save(output)
    return output.getvalue()


def sample_row(sku="000123", change="- 1"):
    return [sku, "测试商品", "test-account", "21 Oct 2026 17:24", "A-01", 100, change, 99, "测试仓", "10.98", "10.9800", "10.98", "出库 / 手动出库", "TEST-001"]


@pytest.fixture
def api():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    repo = InventoryRepository(engine)
    settings = Settings(Path("unused.yaml"), PASSWORD, ["https://sz-labs.github.io"])
    with TestClient(create_app(repo, settings)) as client:
        yield client, repo


def auth(client):
    response = client.post("/api/session", json={"password": PASSWORD})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["accessToken"]}


def test_admin_upload_then_anonymous_read(api):
    client, _ = api
    content = workbook_bytes([sample_row(), sample_row("SKU-2", "+ 5")])
    response = client.post("/api/uploads", headers=auth(client), files={"file": ("inventory.xlsx", content)})
    assert response.status_code == 201
    saved = response.json()
    assert saved["recordCount"] == 2
    # The next requests carry no authentication header, like another visitor.
    listing = client.get("/api/uploads").json()["items"]
    assert len(listing) == 1
    shared = client.get("/api/uploads/" + saved["id"]).json()
    assert shared["sheets"][0]["rows"][0][0] == "000123"
    assert shared["sheets"][0]["rows"][0][10] == "10.9800"
    assert shared["sheets"][0]["rowNumbers"] == [2, 3]


def test_duplicate_file_does_not_duplicate_database_rows(api):
    client, repo = api
    content = workbook_bytes()
    headers = auth(client)
    first = client.post("/api/uploads", headers=headers, files={"file": ("one.xlsx", content)})
    second = client.post("/api/uploads", headers=headers, files={"file": ("same-content.xlsx", content)})
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["duplicate"] is True
    with repo.engine.connect() as connection:
        assert connection.scalar(select(func.count()).select_from(records)) == 1


def test_upload_requires_valid_admin_session(api):
    client, _ = api
    assert client.post("/api/session", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/uploads", files={"file": ("file.xlsx", workbook_bytes())}).status_code == 401
    assert client.post("/api/uploads", headers={"Authorization": "Bearer 1.fake.fake"}, files={"file": ("file.xlsx", workbook_bytes())}).status_code == 401


def test_rejects_wrong_format_without_persisting_any_upload(api):
    client, repo = api
    response = client.post("/api/uploads", headers=auth(client), files={"file": ("file.xlsx", workbook_bytes(headers=HEADERS[:-1]))})
    assert response.status_code == 422
    assert "单据号" in response.json()["detail"]
    assert client.get("/api/uploads").json()["items"] == []
    response = client.post("/api/uploads", headers=auth(client), files={"file": ("file.xlsx", b"not an Excel workbook")})
    assert response.status_code == 422


def test_failed_database_insert_rolls_back_whole_import(api):
    client, repo = api
    def fail_records(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO pages_inventory_records"):
            raise RuntimeError("simulated write failure")
    event.listen(repo.engine, "before_cursor_execute", fail_records)
    response = client.post("/api/uploads", headers=auth(client), files={"file": ("file.xlsx", workbook_bytes())})
    event.remove(repo.engine, "before_cursor_execute", fail_records)
    assert response.status_code == 503
    with repo.engine.connect() as connection:
        assert connection.scalar(select(func.count()).select_from(uploads)) == 0
        assert connection.scalar(select(func.count()).select_from(records)) == 0


def test_private_configuration_files_are_never_served(api):
    client, _ = api
    for path in ("/.env", "/mysql.local.yaml", "/mysql.txt", "/backend/settings.py", "/", "/index.html", "/config.js"):
        assert client.get(path).status_code == 404


def test_cors_allows_the_pages_origin(api):
    client, _ = api
    response = client.options("/api/uploads", headers={"Origin": "https://sz-labs.github.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://sz-labs.github.io"


def test_preserves_literal_cells_and_leading_zero_number_format():
    book = Workbook()
    sheet = book.active
    sheet.append(HEADERS)
    sheet.append(sample_row(123))
    sheet["A2"].number_format = "000000"
    sheet["B2"] = "<img src=x onerror=alert(1)>"
    output = BytesIO()
    book.save(output)
    result = parse_excel(output.getvalue())
    assert result["sheets"][0]["records"][0]["cells"][0] == "000123"
    assert result["sheets"][0]["records"][0]["cells"][1] == "<img src=x onerror=alert(1)>"


def test_environment_provides_config_without_a_private_file(monkeypatch):
    monkeypatch.setenv("MYSQL_CONFIG_YAML", """
mysql:
  host: db.example.invalid
  port: 3306
  database: inventory_test
  username: test_user
  password: 'test@password:#with-special-characters'
""")
    engine = load_mysql_engine(Path("not-present-private-config.yaml"))
    assert engine.url.host == "db.example.invalid"
    assert engine.url.password == "test@password:#with-special-characters"
    assert "test@password" not in str(engine.url)
    engine.dispose()
