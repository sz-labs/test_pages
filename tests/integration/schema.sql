-- ONLY for the disposable inventory_ci database in GitHub Actions.
-- Mirrors the two existing develop business tables; never run against a real database.
CREATE TABLE pages_inventory_uploads (
 id VARCHAR(36) PRIMARY KEY, filename VARCHAR(255) NOT NULL, sha256 VARCHAR(64) NOT NULL UNIQUE,
 created_at DATETIME NOT NULL, record_count INT NOT NULL, sheet_names JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE pages_inventory_records (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, upload_id VARCHAR(36) NOT NULL,
 sheet_name VARCHAR(255) NOT NULL, source_row INT NOT NULL,
 sku_code VARCHAR(255) NOT NULL, sku_name TEXT NOT NULL, account VARCHAR(255) NOT NULL,
 occurred_at VARCHAR(255) NOT NULL, shelf VARCHAR(255) NOT NULL,
 original_qty DECIMAL(38,12), change_qty DECIMAL(38,12), new_qty DECIMAL(38,12),
 warehouse VARCHAR(255) NOT NULL, original_cost DECIMAL(38,12), movement_cost DECIMAL(38,12), current_cost DECIMAL(38,12),
 movement_type VARCHAR(255) NOT NULL, document_no VARCHAR(255) NOT NULL, cells JSON NOT NULL,
 FOREIGN KEY (upload_id) REFERENCES pages_inventory_uploads(id) ON DELETE CASCADE,
 INDEX ix_pages_inventory_upload_sheet_row(upload_id, sheet_name, source_row), INDEX ix_pages_inventory_sku(sku_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
