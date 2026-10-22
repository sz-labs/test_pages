from datetime import datetime, timezone
import hashlib
import uuid

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Index, Integer, JSON, MetaData, Numeric, String, Table, Text, insert, select
from sqlalchemy.exc import IntegrityError

from .excel import number

metadata = MetaData()
uploads = Table(
    "pages_inventory_uploads", metadata,
    Column("id", String(36), primary_key=True),
    Column("filename", String(255), nullable=False),
    Column("sha256", String(64), nullable=False, unique=True),
    Column("created_at", DateTime, nullable=False),
    Column("record_count", Integer, nullable=False),
    Column("sheet_names", JSON, nullable=False),
    mysql_charset="utf8mb4",
)
records = Table(
    "pages_inventory_records", metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("upload_id", String(36), ForeignKey("pages_inventory_uploads.id", ondelete="CASCADE"), nullable=False),
    Column("sheet_name", String(255), nullable=False),
    Column("source_row", Integer, nullable=False),
    Column("sku_code", String(255), nullable=False),
    Column("sku_name", Text, nullable=False),
    Column("account", String(255), nullable=False),
    Column("occurred_at", String(255), nullable=False),
    Column("shelf", String(255), nullable=False),
    Column("original_qty", Numeric(38, 12)), Column("change_qty", Numeric(38, 12)),
    Column("new_qty", Numeric(38, 12)), Column("warehouse", String(255), nullable=False),
    Column("original_cost", Numeric(38, 12)), Column("movement_cost", Numeric(38, 12)),
    Column("current_cost", Numeric(38, 12)),
    Column("movement_type", String(255), nullable=False), Column("document_no", String(255), nullable=False),
    Column("cells", JSON, nullable=False),
    mysql_charset="utf8mb4",
)
Index("ix_pages_inventory_upload_sheet_row", records.c.upload_id, records.c.sheet_name, records.c.source_row)
Index("ix_pages_inventory_sku", records.c.sku_code)


def upload_metadata(row):
    return {
        "id": row["id"], "fileName": row["filename"],
        "uploadedAt": row["created_at"].replace(tzinfo=timezone.utc).isoformat(),
        "recordCount": row["record_count"], "sheetCount": len(row["sheet_names"]),
    }


class InventoryRepository:
    def __init__(self, engine):
        self.engine = engine

    def initialize(self):
        metadata.create_all(self.engine)

    def ping(self):
        with self.engine.connect() as connection:
            connection.execute(select(1))

    def list_uploads(self, limit=50):
        with self.engine.connect() as connection:
            rows = connection.execute(select(uploads).order_by(uploads.c.created_at.desc()).limit(limit)).mappings().all()
        return [upload_metadata(row) for row in rows]

    def get_upload(self, upload_id):
        with self.engine.connect() as connection:
            row = connection.execute(select(uploads).where(uploads.c.id == upload_id)).mappings().first()
            if row is None:
                return None
            saved = connection.execute(
                select(records.c.sheet_name, records.c.source_row, records.c.cells)
                .where(records.c.upload_id == upload_id).order_by(records.c.id)
            ).mappings().all()
        sheets = {name: {"name": name, "rows": [], "rowNumbers": []} for name in row["sheet_names"]}
        for record in saved:
            sheets[record["sheet_name"]]["rows"].append(record["cells"])
            sheets[record["sheet_name"]]["rowNumbers"].append(record["source_row"])
        return {**upload_metadata(row), "schemaVersion": 1, "sheets": list(sheets.values())}

    def save_upload(self, filename, content, parsed):
        digest = hashlib.sha256(content).hexdigest()
        with self.engine.connect() as connection:
            existing = connection.execute(select(uploads).where(uploads.c.sha256 == digest)).mappings().first()
        if existing:
            return {**upload_metadata(existing), "duplicate": True}
        values = {
            "id": str(uuid.uuid4()), "filename": filename, "sha256": digest,
            "created_at": datetime.now(timezone.utc).replace(tzinfo=None),
            "record_count": parsed["recordCount"],
            "sheet_names": [sheet["name"] for sheet in parsed["sheets"]],
        }
        try:
            with self.engine.begin() as connection:
                connection.execute(insert(uploads), values)
                batch = []
                for sheet in parsed["sheets"]:
                    for record in sheet["records"]:
                        cells = record["cells"]
                        batch.append({
                            "upload_id": values["id"], "sheet_name": sheet["name"], "source_row": record["rowNumber"],
                            "sku_code": cells[0], "sku_name": cells[1], "account": cells[2], "occurred_at": cells[3],
                            "shelf": cells[4], "original_qty": number(cells[5]), "change_qty": number(cells[6]),
                            "new_qty": number(cells[7]), "warehouse": cells[8], "original_cost": number(cells[9]),
                            "movement_cost": number(cells[10]), "current_cost": number(cells[11]),
                            "movement_type": cells[12], "document_no": cells[13], "cells": cells,
                        })
                        if len(batch) == 500:
                            connection.execute(insert(records), batch)
                            batch.clear()
                if batch:
                    connection.execute(insert(records), batch)
        except IntegrityError:
            with self.engine.connect() as connection:
                existing = connection.execute(select(uploads).where(uploads.c.sha256 == digest)).mappings().first()
            if existing:
                return {**upload_metadata(existing), "duplicate": True}
            raise
        return {**upload_metadata(values), "duplicate": False}
