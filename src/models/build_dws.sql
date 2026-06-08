-- DWS 建模说明（执行逻辑见 src/etl/dws_build.py :: refresh_dws）
-- 审计含义：将 DWD 明细按 stat_year 聚合为主题分析宽表（DELETE + INSERT）。
-- 五表：dws_trade_sum / dws_inv_trend / dws_sup_conc / dws_goods_cat / dws_quality
-- 核心金额：COALESCE(net_jshj, jshj, 0)

SELECT 1 AS dws_build_doc_only;
