SCOPE = {
    "scope_root_id": "ROOT_PROV_SD",
    "scope_level": "PROV",
    "scope_sys_id": "PROV_SD",
    "instance_name": "InvoiceLens",
}

LICENSE = {
    "tier": "trial",
    "customer": "local-user",
    "expires_at": "2099-12-31",
    "max_entities": 3,
    "max_invoices": 50000,
    "max_years": 2,
    "export_report": False,
    "cross_group": False,
}

SETTINGS = {
    "cr1_warn": 0.30,
    "cr1_high": 0.50,
    "min_graph_amount": 10000.0,
    # 关联图谱 SVG 节点上限，超出则 API 返回 truncated 且不渲染全图
    "max_graph_nodes": 50,
    # L1 分析主体池：当年发票张数下限（含等于，见 analysis_subject_pool）
    "min_analysis_subject_invoice_count": 10,
    # 进销偏离：单档税率占比差（百分点，0~100）超过该阈值时告警并写入疑点
    "tax_in_out_deviation_threshold_pct": 10.0,
}

IMPORT_SETTINGS = {
    # 并发 worker 默认值：min(4, max(1, os.cpu_count()-1))
    "import_workers": None,
    "parquet_compression": "zstd",
    "timezone": "Asia/Shanghai",
}
