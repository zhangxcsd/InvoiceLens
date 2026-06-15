"""CI smoke: 审计疑点批量确认/驳回（撤销确认）API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.audit_flag_api import api_audit_flag_confirm


def _ensure_flag_table(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_audit_flag (
            flag_id VARCHAR PRIMARY KEY,
            rule_id VARCHAR,
            risk_level VARCHAR,
            flag_type VARCHAR,
            group_id VARCHAR,
            entity_id VARCHAR,
            entity_name VARCHAR,
            seller_name VARCHAR,
            seller_tax_no VARCHAR,
            amount DOUBLE,
            description VARCHAR,
            suggestion VARCHAR,
            is_confirmed BOOLEAN DEFAULT FALSE,
            confirm_note VARCHAR,
            analysis_batch VARCHAR,
            created_at TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dm_audit_flag (
            flag_id, rule_id, risk_level, flag_type, group_id,
            entity_id, entity_name, amount, description, suggestion,
            is_confirmed, confirm_note, analysis_batch
        ) VALUES
        ('FLAG-001', 'RULE-01', '高风险', '重复开票', 'Y2024', 'TAX001', '甲公司', 1000,
         '测试', '核查', FALSE, NULL, 'test_batch'),
        ('FLAG-002', 'RULE-FIN-DIFF', '中风险', '账票差异', 'Y2024', 'TAX002', '乙公司', 2000,
         '测试2', '核查2', FALSE, NULL, 'finance_reconcile_B001')
        """
    )


def test_batch_confirm_and_reject() -> None:
    conn = duckdb.connect(":memory:")
    _ensure_flag_table(conn)

    confirm = api_audit_flag_confirm(
        conn,
        flag_ids=["FLAG-001", "FLAG-002"],
        is_confirmed=True,
        confirm_note="批量确认测试",
    )
    assert confirm["ok"] is True
    assert confirm["updated"] == 2

    row = conn.execute(
        "SELECT is_confirmed, confirm_note FROM dm_audit_flag WHERE flag_id = 'FLAG-001'"
    ).fetchone()
    assert row is not None
    assert bool(row[0]) is True
    assert row[1] == "批量确认测试"

    reject = api_audit_flag_confirm(
        conn,
        flag_ids=["FLAG-001", "FLAG-002"],
        is_confirmed=False,
    )
    assert reject["ok"] is True
    assert reject["updated"] == 2

    pending = conn.execute(
        "SELECT count(*)::BIGINT FROM dm_audit_flag WHERE COALESCE(is_confirmed, FALSE) = FALSE"
    ).fetchone()[0]
    assert int(pending) == 2

    cleared = conn.execute(
        "SELECT confirm_note FROM dm_audit_flag WHERE flag_id = 'FLAG-001'"
    ).fetchone()[0]
    assert cleared is None


if __name__ == "__main__":
    test_batch_confirm_and_reject()
    print("test_audit_flag_confirm_smoke: OK")
