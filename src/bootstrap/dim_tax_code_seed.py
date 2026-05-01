from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any


_SEED_NAME = "dim_tax_code"
_SEED_FILE = Path(__file__).resolve().parents[2] / "assets" / "bootstrap" / "dim_tax_code_seed.parquet"


def _ensure_seed_state_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sys_seed_state (
            seed_name VARCHAR PRIMARY KEY,
            seed_version VARCHAR,
            seed_file VARCHAR,
            row_count BIGINT,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _seed_version(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_force_seed_enabled() -> bool:
    v = (os.getenv("INVOICELENS_FORCE_SEED") or "").strip().lower()
    return v in {"1", "true", "yes", "on"}


def ensure_dim_tax_code_seeded(conn) -> dict[str, Any]:
    """
    幂等保证 dim_tax_code 初始化数据：
    - 表有数据则直接跳过；
    - 表为空时从 assets/bootstrap/dim_tax_code_seed.parquet 导入；
    - tax_code 全程按文本清洗为 19 位数字串，避免科学计数污染。
    """
    _ensure_seed_state_table(conn)

    cnt = int(conn.execute("SELECT COUNT(*) FROM dim_tax_code").fetchone()[0] or 0)
    force_seed = _is_force_seed_enabled()
    if cnt > 0 and not force_seed:
        return {"ok": True, "seeded": False, "reason": "dim_tax_code already has data", "row_count": cnt}

    if not _SEED_FILE.exists():
        return {"ok": False, "seeded": False, "reason": f"seed file missing: {_SEED_FILE}"}

    ver = _seed_version(_SEED_FILE)
    try:
        conn.execute("BEGIN TRANSACTION")
        conn.execute("DELETE FROM dim_tax_code")
        conn.execute(
            """
            INSERT INTO dim_tax_code (
                tax_code, goods_name, goods_short_name, description,
                level_pian, level_lei, level_zhang, level_jie, level_tiao,
                level_kuan, level_xiang, level_mu, level_zimu, level_ximu,
                level_depth, is_leaf, parent_code, full_path,
                data_version, clean_status, audit_risk_label,
                import_batch_id, import_session_id, ods_file_seq,
                source_excel_file, source_parquet_file, source_sheet, ingest_ts
            )
            SELECT
                lpad(right(regexp_replace(cast(tax_code as varchar), '[^0-9]', '', 'g'), 19), 19, '0') AS tax_code,
                cast(goods_name as varchar),
                cast(goods_short_name as varchar),
                cast(description as varchar),
                cast(level_pian as varchar),
                cast(level_lei as varchar),
                cast(level_zhang as varchar),
                cast(level_jie as varchar),
                cast(level_tiao as varchar),
                cast(level_kuan as varchar),
                cast(level_xiang as varchar),
                cast(level_mu as varchar),
                cast(level_zimu as varchar),
                cast(level_ximu as varchar),
                cast(level_depth as tinyint),
                cast(is_leaf as boolean),
                cast(parent_code as varchar),
                cast(full_path as varchar),
                coalesce(nullif(trim(cast(data_version as varchar)), ''), 'seed_bootstrap'),
                nullif(trim(cast(clean_status as varchar)), ''),
                coalesce(nullif(trim(cast(audit_risk_label as varchar)), ''), 'NORMAL'),
                coalesce(nullif(trim(cast(import_batch_id as varchar)), ''), 'BATCH_DIM_TAX_SEED'),
                coalesce(nullif(trim(cast(import_session_id as varchar)), ''), 'SID_DIM_SEED'),
                cast(ods_file_seq as integer),
                coalesce(nullif(trim(cast(source_excel_file as varchar)), ''), 'seed:dim_tax_code_seed.parquet'),
                nullif(trim(cast(source_parquet_file as varchar)), ''),
                coalesce(nullif(trim(cast(source_sheet as varchar)), ''), 'seed'),
                coalesce(cast(ingest_ts as timestamp), current_timestamp)
            FROM read_parquet(?)
            """,
            [str(_SEED_FILE)],
        )
        new_cnt = int(conn.execute("SELECT COUNT(*) FROM dim_tax_code").fetchone()[0] or 0)
        conn.execute(
            """
            INSERT INTO sys_seed_state (seed_name, seed_version, seed_file, row_count, applied_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(seed_name) DO UPDATE SET
                seed_version = excluded.seed_version,
                seed_file = excluded.seed_file,
                row_count = excluded.row_count,
                applied_at = excluded.applied_at
            """,
            [_SEED_NAME, ver, str(_SEED_FILE), new_cnt],
        )
        conn.execute("COMMIT")
        return {
            "ok": True,
            "seeded": True,
            "row_count": new_cnt,
            "seed_version": ver,
            "forced": force_seed,
        }
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        return {"ok": False, "seeded": False, "reason": str(exc)}
