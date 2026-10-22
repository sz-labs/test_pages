-- Run once in the existing inventory database. Existing business tables are not altered.
CREATE TABLE IF NOT EXISTS pages_inventory_import_sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  chunk_count SMALLINT UNSIGNED NOT NULL,
  upload_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX ix_inventory_import_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pages_inventory_import_chunks (
  session_id CHAR(36) NOT NULL,
  chunk_index SMALLINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  body MEDIUMBLOB NOT NULL,
  PRIMARY KEY (session_id, chunk_index),
  CONSTRAINT fk_inventory_import_session FOREIGN KEY (session_id)
    REFERENCES pages_inventory_import_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pages_inventory_auth_limits (
  client_key CHAR(64) NOT NULL PRIMARY KEY,
  failures TINYINT UNSIGNED NOT NULL DEFAULT 0,
  window_start DATETIME(3) NOT NULL,
  INDEX ix_inventory_auth_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
