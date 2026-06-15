"""
演示分析数据种子：花名册 + 主体库 + DWD 发票 + 年度关系 + DWS 聚合。

固定统计年度 DEMO_STAT_YEAR（当前日历年），供 DWS 看板与分析主体池联调。
幂等：所有演示行带 demo_analysis_ 前缀，重跑前先清理。
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 演示年度：近三年（供 supplier_new / compare_charts 跨年度对比）
DEMO_STAT_YEAR = date.today().year
DEMO_STAT_YEARS: list[int] = [DEMO_STAT_YEAR - 2, DEMO_STAT_YEAR - 1, DEMO_STAT_YEAR]
DEMO_STAT_YEARS = [y for y in DEMO_STAT_YEARS if 1990 <= y <= 2100]

_DEMO_PREFIX = "demo_analysis_"
_DEMO_FILE = f"{_DEMO_PREFIX}invoices.xlsx"

_LEDGER_SEED = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "dim" / "data" / "property_ledger_seed.json"
)

# 主集团成员（来自 property_ledger_seed.json）
_MAIN_ENTITIES: list[tuple[str, str]] = [
    ("91110000MA01DEMO01", "华能示范集团有限公司"),
    ("91310000MA01DEMO02", "华东能源开发有限公司"),
    ("91440000MA01DEMO03", "粤电新能源科技有限公司"),
    ("91550000MA01DEMO04", "北方热电运营有限公司"),
    ("91660000MA01DEMO05", "西部储能科技有限公司"),
]

_COUNTERPARTIES: list[tuple[str, str]] = [
    ("91500000MA01DEMOA1", "示范电力设备有限公司"),
    ("91600000MA01DEMOB2", "全国煤炭贸易股份公司"),
    ("91700000MA01DEMOC3", "华南建材供应链有限公司"),
    ("91800000MA01DEMOD4", "华北工程服务有限责任公司"),
    ("91990000MA01DEMOE5", "中部物流运输有限公司"),
    ("92000000MA01DEMOF6", "沿海国际贸易有限公司"),
]

_TAX_RATES: list[tuple[str, float]] = [
    ("13%", 0.13),
    ("9%", 0.09),
    ("6%", 0.06),
    ("3%", 0.03),
    ("免税", 0.0),
]


def _now() -> datetime:
    return datetime.now()


def _batch_id(stat_year: int) -> str:
    return f"{_DEMO_PREFIX}batch_{stat_year}"


def _analysis_batch(stat_year: int) -> str:
    return f"{_DEMO_PREFIX}audit_{stat_year}"


def _hdr_uuid(stat_year: int, seq: int) -> str:
    return f"{_DEMO_PREFIX}hdr_{stat_year}_{seq:04d}"


def _dtl_uuid(hdr: str, line: int) -> str:
    raw = f"{hdr}|{line}"
    return f"{_DEMO_PREFIX}dtl_{hashlib.md5(raw.encode()).hexdigest()[:20]}"


def _cleanup_demo_rows(conn: Any) -> dict[str, int]:
    """删除 demo_analysis_ 前缀相关行（幂等重跑）。"""
    counts: dict[str, int] = {}
    steps: list[tuple[str, str]] = [
        ("dwd_inv_detail", f"import_batch_id LIKE '{_DEMO_PREFIX}%'"),
        ("dwd_inv_header", f"first_import_batch_id LIKE '{_DEMO_PREFIX}%'"),
        ("dm_audit_flag", f"analysis_batch LIKE '{_DEMO_PREFIX}%' OR flag_id LIKE '{_DEMO_PREFIX}%' OR analysis_batch = 'tax_deviation_sync'"),
        (
            "dim_enterprise_year_roster",
            f"enterprise_id LIKE '%DEMO%' OR data_source = '{_DEMO_PREFIX}seed' OR source_record_id LIKE '{_DEMO_PREFIX}%'",
        ),
        (
            "dim_subject_master",
            f"first_import_batch_id LIKE '{_DEMO_PREFIX}%' OR last_import_batch_id LIKE '{_DEMO_PREFIX}%'",
        ),
    ]
    for table, clause in steps:
        n = 0
        try:
            row = conn.execute(f"SELECT COUNT(*)::BIGINT FROM {table} WHERE {clause}").fetchone()
            n = int(row[0] or 0) if row else 0
            if n > 0:
                conn.execute(f"DELETE FROM {table} WHERE {clause}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("cleanup %s failed: %s", table, exc)
        counts[table] = n
    return counts


def _seed_registry_and_roster(conn: Any) -> dict[str, Any]:
    """写入演示台账并同步花名册（复用现有 bootstrap）。"""
    try:
        from src.local_api.audited_enterprise_dims import api_registry_bootstrap_demo

        return api_registry_bootstrap_demo(conn)
    except Exception as exc:  # noqa: BLE001
        logger.exception("registry bootstrap")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}



def _ensure_roster_for_years(conn: Any) -> int:
    """确保各演示年度花名册含演示成员。"""
    n = 0
    state_investor = "华能示范集团有限公司"
    state_code = "91110000MA01DEMO01"
    now = _now()
    for stat_year in DEMO_STAT_YEARS:
        for tax_no, name in _MAIN_ENTITIES:
            try:
                conn.execute(
                    """
                    INSERT INTO dim_enterprise_year_roster (
                        stat_year, enterprise_id, enterprise_name,
                        state_investor, state_investor_unified_credit_code,
                        is_member, data_source, in_registry, in_manual,
                        source_record_id, calc_version, updated_at
                    ) VALUES (?, ?, ?, ?, ?, TRUE, 'registry', TRUE, FALSE, ?, 'v2', ?)
                    ON CONFLICT (stat_year, enterprise_id) DO UPDATE SET
                        enterprise_name = excluded.enterprise_name,
                        state_investor = excluded.state_investor,
                        state_investor_unified_credit_code = excluded.state_investor_unified_credit_code,
                        is_member = TRUE,
                        data_source = 'registry',
                        in_registry = TRUE,
                        in_manual = FALSE,
                        source_record_id = excluded.source_record_id,
                        updated_at = excluded.updated_at
                    """,
                    [stat_year, tax_no, name, state_investor, state_code, f"{_DEMO_PREFIX}roster", now],
                )
                n += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("roster upsert %s/%s: %s", stat_year, tax_no, exc)
    return n


def _build_invoice_specs(stat_year: int) -> list[dict[str, Any]]:
    """构造发票规格：主实体购销双向 + 多往来 + 跨月 + 多税率 + 规则触发样本。"""
    specs: list[dict[str, Any]] = []
    seq = 1
    year_offset = max(0, stat_year - DEMO_STAT_YEAR)

    for month in range(1, 7):
        for buyer_tax, buyer_name in _MAIN_ENTITIES:
            cust = _COUNTERPARTIES[(month + seq + year_offset) % len(_COUNTERPARTIES)]
            rate_idx = seq % len(_TAX_RATES)
            specs.append(
                {
                    "seq": seq,
                    "month": month,
                    "seller": (buyer_tax, buyer_name),
                    "buyer": cust,
                    "tax_idx": rate_idx,
                    "amount": 50000 + seq * 1200 + year_offset * 5000,
                }
            )
            seq += 1
            sup = _COUNTERPARTIES[(month + seq + 1 + year_offset) % len(_COUNTERPARTIES)]
            rate_idx2 = (seq + 1) % len(_TAX_RATES)
            specs.append(
                {
                    "seq": seq,
                    "month": month,
                    "seller": sup,
                    "buyer": (buyer_tax, buyer_name),
                    "tax_idx": rate_idx2,
                    "amount": 30000 + seq * 800,
                }
            )
            seq += 1

    # 进销结构偏离：DEMO01 销项偏 13%、进项偏 6%（触发 RULE-TAX-DEV / 风险敞口）
    if stat_year == DEMO_STAT_YEAR:
        for month in range(1, 5):
            specs.append(
                {
                    "seq": seq,
                    "month": month,
                    "seller": _MAIN_ENTITIES[0],
                    "buyer": _COUNTERPARTIES[0],
                    "tax_idx": 0,
                    "amount": 180000,
                }
            )
            seq += 1
            specs.append(
                {
                    "seq": seq,
                    "month": month,
                    "seller": _COUNTERPARTIES[1],
                    "buyer": _MAIN_ENTITIES[0],
                    "tax_idx": 2,
                    "amount": 40000,
                }
            )
            seq += 1

    bidir_pairs = [
        ("91110000MA01DEMO01", "华能示范集团有限公司", "91600000MA01DEMOB2", "全国煤炭贸易股份公司"),
        ("91600000MA01DEMOB2", "全国煤炭贸易股份公司", "91110000MA01DEMO01", "华能示范集团有限公司"),
        ("91310000MA01DEMO02", "华东能源开发有限公司", "91600000MA01DEMOB2", "全国煤炭贸易股份公司"),
        ("91600000MA01DEMOB2", "全国煤炭贸易股份公司", "91310000MA01DEMO02", "华东能源开发有限公司"),
    ]
    for i, (st, sn, bt, bn) in enumerate(bidir_pairs):
        specs.append(
            {
                "seq": seq,
                "month": 7 + (i % 5),
                "seller": (st, sn),
                "buyer": (bt, bn),
                "tax_idx": i % len(_TAX_RATES),
                "amount": 88000 + i * 5000,
            }
        )
        seq += 1

    # 集团内关联交易
    internal = [
        ("91110000MA01DEMO01", "华能示范集团有限公司", "91310000MA01DEMO02", "华东能源开发有限公司"),
        ("91310000MA01DEMO02", "华东能源开发有限公司", "91440000MA01DEMO03", "粤电新能源科技有限公司"),
    ]
    for i, (st, sn, bt, bn) in enumerate(internal):
        specs.append(
            {
                "seq": seq,
                "month": 8 + i,
                "seller": (st, sn),
                "buyer": (bt, bn),
                "tax_idx": (i + 2) % len(_TAX_RATES),
                "amount": 120000 + i * 10000,
            }
        )
        seq += 1

    return specs


def _insert_invoices_for_year(conn: Any, stat_year: int) -> dict[str, int]:
    specs = _build_invoice_specs(stat_year)
    hdr_n = 0
    dtl_n = 0
    now = _now()
    fp_base = 10000000 + stat_year * 1000
    batch_id = _batch_id(stat_year)
    fpzt = str(specs[0].get("fpzt") or "正常") if specs else "正常"

    for spec in specs:
        seq = int(spec["seq"])
        month = int(spec["month"])
        if month > 12:
            month = 12
        day = min(28, 5 + (seq % 20))
        inv_date = date(stat_year, month, day)
        if spec.get("invoice_date"):
            inv_date = spec["invoice_date"]
        seller_tax, seller_name = spec["seller"]
        buyer_tax, buyer_name = spec["buyer"]
        slv_label, slv_num = _TAX_RATES[int(spec["tax_idx"]) % len(_TAX_RATES)]
        amount = Decimal(str(spec["amount"]))
        tax = (amount * Decimal(str(slv_num))).quantize(Decimal("0.01"))
        jshj = amount + tax
        row_fpzt = str(spec.get("fpzt") or "正常")
        net_jshj = float(-abs(jshj)) if row_fpzt != "正常" and float(jshj) > 0 else float(jshj)

        hdr_id = _hdr_uuid(stat_year, seq)
        fpdm = str(spec.get("fpdm") or "0440")
        fphm = str(spec.get("fphm") or str(fp_base + seq))
        sdfphm = str(spec.get("sdfphm") or f"{fpdm}{fphm}")

        try:
            conn.execute(
                """
                INSERT INTO dwd_inv_header (
                    header_uuid, stat_year, stat_month,
                    fpdm, fphm, sdfphm,
                    xfsbh, xfmc, gfsbh, gfmc,
                    kprq, invoice_date,
                    je, se, jshj, net_jshj,
                    fpzt, fply, fppz,
                    is_balanced, net_calc_status,
                    import_batch_id, first_import_batch_id, first_import_file,
                    source_excel_file, source_sheet, ingest_ts, dwd_build_ts
                ) VALUES (
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, '电子发票服务平台', '数电票',
                    '平账', '蓝票已计算',
                    ?, ?, ?,
                    ?, '信息汇总表', ?, ?
                )
                """,
                [
                    hdr_id,
                    stat_year,
                    month,
                    fpdm,
                    fphm,
                    sdfphm,
                    seller_tax,
                    seller_name,
                    buyer_tax,
                    buyer_name,
                    inv_date.isoformat(),
                    inv_date,
                    float(amount),
                    float(tax),
                    float(jshj),
                    net_jshj,
                    row_fpzt,
                    batch_id,
                    batch_id,
                    _DEMO_FILE,
                    _DEMO_FILE,
                    now,
                    now,
                ],
            )
            hdr_n += 1

            dtl_id = _dtl_uuid(hdr_id, 1)
            conn.execute(
                """
                INSERT INTO dwd_inv_detail (
                    detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
                    fpdm, fphm, sdfphm, invoice_date,
                    xfsbh, xfmc, gfsbh, gfmc,
                    hwlwmc, je, se, jshj, slv, slv_num,
                    import_batch_id, source_excel_file, source_sheet, ingest_ts, dwd_build_ts
                ) VALUES (
                    ?, ?, ?, ?, 1,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, '货物清单', ?, ?
                )
                """,
                [
                    dtl_id,
                    hdr_id,
                    stat_year,
                    month,
                    fpdm,
                    fphm,
                    sdfphm,
                    inv_date,
                    seller_tax,
                    seller_name,
                    buyer_tax,
                    buyer_name,
                    str(spec.get("hwlwmc") or "演示商品/服务"),
                    float(amount),
                    float(tax),
                    float(jshj),
                    slv_label,
                    float(slv_num),
                    batch_id,
                    _DEMO_FILE,
                    now,
                    now,
                ],
            )
            dtl_n += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("insert invoice year=%s seq=%s failed: %s", stat_year, seq, exc)

    _ = fpzt
    return {"headers": hdr_n, "details": dtl_n, "stat_year": stat_year}


def _insert_all_invoices(conn: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for y in DEMO_STAT_YEARS:
        out[str(y)] = _insert_invoices_for_year(conn, y)
    return out


def _rebuild_rel_and_dws(conn: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        from src.local_api.subject_library_dwd_ingest import ingest_dim_subject_master_from_dwd

        ingest = ingest_dim_subject_master_from_dwd(conn, run_id=f"{_DEMO_PREFIX}subject_ingest")
        out["subject_ingest"] = ingest
    except Exception as exc:  # noqa: BLE001
        logger.exception("subject ingest")
        out["subject_ingest"] = {"ok": False, "error": str(exc)}

    try:
        from src.local_api.enterprise_year_rel_build import rebuild_dim_enterprise_year_rel

        rel = rebuild_dim_enterprise_year_rel(
            conn,
            stat_years=DEMO_STAT_YEARS,
            trigger_source="demo_analysis_seed",
            run_id=f"{_DEMO_PREFIX}rel_{uuid.uuid4().hex[:8]}",
        )
        out["enterprise_year_rel"] = rel
    except Exception as exc:  # noqa: BLE001
        logger.exception("enterprise_year_rel rebuild")
        out["enterprise_year_rel"] = {"ok": False, "error": str(exc)}

    try:
        from src.etl.dws_build import refresh_dws_years

        dws = refresh_dws_years(conn, stat_years=DEMO_STAT_YEARS, run_id=f"{_DEMO_PREFIX}dws")
        out["dws_refresh"] = dws
    except Exception as exc:  # noqa: BLE001
        logger.exception("dws refresh")
        out["dws_refresh"] = {"ok": False, "error": str(exc)}

    return out


def _run_audit_scan(conn: Any) -> dict[str, Any]:
    try:
        from src.etl.dm_audit_build import refresh_audit_flags

        return refresh_audit_flags(
            conn,
            stat_years=DEMO_STAT_YEARS,
            trigger_source="demo_analysis_seed",
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("audit scan")
        return {"ok": False, "error": str(exc)}


def _seed_confirmed_flag(conn: Any) -> int:
    """一条已确认疑点供 flags_track 演示。"""
    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(DEMO_STAT_YEAR)
    fid = f"{_DEMO_PREFIX}flag_confirmed"
    try:
        conn.execute(
            """
            INSERT INTO dm_audit_flag (
                flag_id, rule_id, risk_level, flag_type, group_id,
                entity_id, entity_name, amount, description, suggestion,
                is_confirmed, confirm_note, analysis_batch, detail_json
            ) VALUES (?, 'RULE-02', '中风险', '异常开票日期', ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)
            ON CONFLICT (flag_id) DO UPDATE SET
                is_confirmed = TRUE,
                confirm_note = excluded.confirm_note,
                detail_json = excluded.detail_json
            """,
            [
                fid,
                gid,
                "91110000MA01DEMO01",
                "华能示范集团有限公司",
                88000.0,
                "演示：已确认疑点（报告附录用）",
                "已核对合同与出库单，留档备查",
                "演示已确认跟踪说明",
                _analysis_batch(DEMO_STAT_YEAR),
                '{"invoice_date":"2024-12-15","date_from":"2024-12-15","date_to":"2024-12-15"}',
            ],
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        logger.warning("confirmed flag: %s", exc)
        return 0


def _verification_counts(conn: Any) -> dict[str, Any]:
    """种子后验证计数。"""
    out: dict[str, Any] = {"stat_year": DEMO_STAT_YEAR, "stat_years": DEMO_STAT_YEARS}
    try:
        from src.local_api.analysis_subject_pool import api_analysis_subject_options

        pool = api_analysis_subject_options(conn, stat_year=str(DEMO_STAT_YEAR))
        out["analysis_subject_options"] = len(pool.get("options") or [])
        out["analysis_subject_sample"] = (pool.get("options") or [])[:3]
    except Exception as exc:  # noqa: BLE001
        out["analysis_subject_error"] = str(exc)

    queries = {
        "dwd_inv_header": (
            f"SELECT COUNT(*)::BIGINT FROM dwd_inv_header WHERE first_import_batch_id LIKE '{_DEMO_PREFIX}%'"
        ),
        "dws_trade_sum": (
            "SELECT COUNT(*)::BIGINT FROM dws_trade_sum WHERE stat_year = ?", [DEMO_STAT_YEAR]
        ),
        "dws_inv_trend": (
            "SELECT COUNT(*)::BIGINT FROM dws_inv_trend WHERE stat_year = ?", [DEMO_STAT_YEAR]
        ),
        "dim_enterprise_year_rel": (
            """
            SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_rel
            WHERE stat_year = ? AND COALESCE(invoice_count, 0) >= 10
            """,
            [DEMO_STAT_YEAR],
        ),
        "dm_audit_flag": (
            f"SELECT COUNT(*)::BIGINT FROM dm_audit_flag WHERE analysis_batch LIKE '{_DEMO_PREFIX}%'"
        ),
    }
    for key, spec in queries.items():
        try:
            if isinstance(spec, tuple):
                sql, params = spec
            else:
                sql, params = spec, []
            out[key] = int(conn.execute(sql, params).fetchone()[0] or 0)
        except Exception as exc:  # noqa: BLE001
            out[f"{key}_error"] = str(exc)
    return out


def seed_demo_analysis_data(conn: Any, *, skip_audit_flags: bool = False) -> dict[str, Any]:
    """
    幂等写入演示分析链路数据并返回摘要。
    """
    try:
        from db.schema_sqlfiles import init_all_tables

        init_all_tables(conn)
    except Exception as exc:  # noqa: BLE001
        logger.exception("init_all_tables")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    summary: dict[str, Any] = {
        "ok": True,
        "stat_year": DEMO_STAT_YEAR,
        "stat_years": DEMO_STAT_YEARS,
        "demo_prefix": _DEMO_PREFIX,
    }

    try:
        summary["deleted"] = _cleanup_demo_rows(conn)
        registry = _seed_registry_and_roster(conn)
        summary["registry_bootstrap"] = registry
        summary["roster_upserted"] = _ensure_roster_for_years(conn)
        try:
            from src.local_api.enterprise_year_roster_store import repair_roster_data_source

            summary["roster_data_source_repaired"] = repair_roster_data_source(conn)
        except Exception as exc:  # noqa: BLE001
            logger.warning("roster data_source repair skipped: %s", exc)
            summary["roster_data_source_repaired"] = 0
        summary["invoices"] = _insert_all_invoices(conn)
        summary["rebuild"] = _rebuild_rel_and_dws(conn)
        if not skip_audit_flags:
            summary["audit_scan"] = _run_audit_scan(conn)
            summary["confirmed_flag"] = _seed_confirmed_flag(conn)
        summary["verification"] = _verification_counts(conn)

        v = summary.get("verification") or {}
        pool_n = int(v.get("analysis_subject_options") or 0)
        trade_n = int(v.get("dws_trade_sum") or 0)
        if pool_n < 1 or trade_n < 1:
            summary["ok"] = False
            summary["warning"] = (
                f"种子已写入但验证未达标：分析主体池={pool_n}，dws_trade_sum={trade_n}。"
                "请检查花名册/主体库/年度关系重算。"
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("seed_demo_analysis_data")
        return {
            "ok": False,
            "stat_year": DEMO_STAT_YEAR,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    return summary
