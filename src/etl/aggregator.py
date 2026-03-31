from typing import Any


def run_aggregator(*, stat_year: int) -> dict[str, Any]:
    """
    DWD -> DWS 聚合写入契约（骨架）：

    - 覆盖刷新边界：`stat_year`
      - 采用 DELETE+INSERT 或等价原子策略写入单表 DWS（必须带过滤）
    - 查询契约：DWS 表必须可被 UI/规则引擎按 `stat_year=?`（必要时 `stat_month=?`）快速过滤
    """
    return {
        "status": "success",
        "stage": "aggregator",
        "stat_year": stat_year,
        "message": "aggregator 写入契约骨架已就绪",
    }
