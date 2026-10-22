"""Run `python -m backend.check_connection` from the repository root."""
import sys

from sqlalchemy import text

from .settings import load_mysql_engine, load_settings


def main():
    engine = None
    try:
        config = load_settings()
        engine = load_mysql_engine(config.mysql_file)
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        print("MySQL connection OK. No tables or data were changed.")
        return 0
    except Exception as error:
        print("MySQL connection failed. Error type: " + type(error).__name__)
        return 1
    finally:
        if engine:
            engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
