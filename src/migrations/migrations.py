from db.duckdb_conn import get_conn


EXPECTED_SCHEMA_VERSION = "0.1.0"


def run_migrations() -> None:
    """
    迁移占位：后续按版本增量执行 SQL 迁移脚本。
    """
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meta_migration_log (
            id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            from_version VARCHAR,
            to_version VARCHAR,
            is_success BOOLEAN,
            message VARCHAR,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """
    )


if __name__ == "__main__":
    run_migrations()
    print("迁移骨架已就绪")
