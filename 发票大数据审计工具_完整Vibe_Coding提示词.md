# InvoiceLens · 票鉴——发票大数据审计分析工具完整 Vibe Coding 提示词

> 使用说明：将本文档全文复制，粘贴给 AI 编程助手（Cursor / Claude / Copilot 均可）。
> 建议使用 Cursor Agent 模式或 Claude Projects，支持多轮迭代补充细节。

---

### 编写前一致性裁决（分阶段落地时以本节为准）

以下条款用于消解正文不同章节「起草时间不同」带来的口径漂移；**若与下文某段字面冲突，优先本节 +「关键设计决策备忘」+ 仓库内 `db/schema_duckdb.py` 实际 DDL**。

| 主题 | 裁决 |
|------|------|
| **DWD/DWS 表形态** | **单表 + `stat_year`（决策九）**，无 `dwd_*_{YYYY}`、无 `ensure_year_tables` / 年度联合视图。正文中凡出现 `dwd_inv_header_{YYYY}`、`dws_trade_sum_{YYYY}` 等字样，实施时一律视为 **`dwd_inv_header`、`dws_trade_sum` … + `WHERE stat_year=?`** 的简写，须改写到单表口径。 |
| **性能过滤** | 主路径为 **`WHERE stat_year`（+ 必要时的 `stat_month`）**。**`dwd_inv_header` / `dwd_inv_detail` / `dwd_inv_map` / DWS 各表均不含 `group_id`**；按「集团/审计范围」切片时，在应用层或 **JOIN `dim_org_*`** 用税号/主体等过滤，**不在 DWD/DWS 落 `group_id` 列**。 |
| **`group_id` 出现位置** | **仅 DM 层（及与疑点/分析批次相关的应用输出）**；与 DWD/DWS 物理发票明细解耦。 |
| **ODS** | 以 **「ODS 文件名与目录规范」** 为准：`批次/表类型/序号` + `{YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet`。 |
| **存储** | 分析层以 **`warehouse.duckdb`（DuckDB）** 为主。 |
| **SQLite** | **【遗留】**：旧稿曾出现 SQLite 模块名；**本阶段不实现 SQLite 业务库**，仅保留「为何选 DuckDB」中与 SQLite 的**对比说明**。详见下文「SQLite【遗留】」。 |
| **待确认** | 见文末 **「分阶段编写前须确认清单」**（非 `group_id` 相关，多为久其/枚举等）。 |

---

## 一、项目总体描述

请帮我开发一个面向**国有企业集团审计部门**使用的**发票大数据审计分析桌面工具**。

**工具名称：InvoiceLens（中文：票鉴）**
口号：透过发票数据，洞见审计风险

### 核心定位
- 使用对象：集团审计部人员（非技术背景，熟悉 Excel）
- 核心场景：集团层面对多家下属企业发票数据进行统一归集与审计分析
- 数据来源：各下属企业从金税系统（金税三期 / 四期）导出的标准 Excel 文件
- 部署方式：**本地运行，数据不出内网**，打包为单一可执行文件（.exe）

### 技术选型
- 语言：Python 3.10+
- UI 框架：Streamlit（本地 Web 界面，双击 .exe 自动打开浏览器）
- 大数据分析引擎：**DuckDB**（ODS / DWD / DWS 层，列存储，自动多核并行）
- 存储引擎：**DuckDB**（统一引擎，ODS视图/DWD/DWS/DIM/DM/ADS 全部层）
- 数据处理：Pandas、NumPy
- 图表：Plotly（交互式图表）
- 网络分析：NetworkX（关联交易图谱）
- 报告生成：python-docx（Word）、reportlab（PDF）
- 打包工具：PyInstaller（打包为单文件 .exe）
- 依赖管理：requirements.txt

### 数据库引擎选型说明（以 DuckDB 为唯一业务分析库；SQLite 仅作对比，见【遗留】）

#### 为什么不用纯 SQLite（仅作选型对比；本阶段不采用 SQLite 业务库）

> **说明**：下表用于解释**为何选用 DuckDB** 作为分析引擎；**并非**要求实现 SQLite。**本文凡出现 `sqlite_conn.py` / `schema_sqlite.py` 等字样，一律视为【遗留】初稿，本阶段可忽略。**

SQLite 是行存储 OLTP 数据库，面对大规模分析查询有三个硬伤：

| 场景 | SQLite | DuckDB |
|------|--------|--------|
| 1000 万行 GROUP BY | 数十分钟 | 1–5 秒 |
| 税号自连接（关联交易） | 超时或崩溃 | 5–30 秒 |
| 批量写入 1000 万行 | 20 分钟以上 | 2–5 分钟 |
| 多核并行 | 单线程 | 自动并行 |
| 内存溢出处理 | 崩溃 | 自动溢写磁盘 |

#### 为什么选 DuckDB 而不是 PostgreSQL / MySQL

DuckDB 和 SQLite 一样是嵌入式数据库——零安装、单文件、Python `pip install duckdb` 即可、可打包进 `.exe`。但底层是列存储 OLAP 引擎，专为分析负载设计，已有生产案例处理超过 10 TB 数据。

#### 30 户省属企业集团的数据规模评估

```
背景规模：
- 30 户省属一级集团
- 每户集团下属单位：300–500 户（加权平均约 400 户）
- 全省下属企业总数：约 12,000 户
- 每户下属企业年均发票：约 8,000 张（进项 + 销项合计）
- 3 年累计 ODS 发票总量：12,000 × 8,000 × 3 ≈ 2.9 亿行

各层数据量估算：
- ODS 层（Parquet）：   约 3 亿行，压缩后约 15–20 GB
- DWD 层（DuckDB）：   约 3 亿行（单表 + `stat_year` 列），约 50–60 GB
- DWS 汇总层：         约 3,000 万行（聚合压缩），约 8 GB
- DIM 维度层：         万级（企业、编码、行业），< 1 GB
- DM 疑点层：          约 1–2 亿行，约 20 GB
- ADS 应用层：         万级，< 1 GB
全量合计：             约 8–9 亿行，磁盘占用 80–150 GB
```

**结论：DuckDB 技术上完全可以支撑，但必须配合以下三条策略，否则全库扫描或跨主体分析会很慢。**

#### 30 户场景必须执行的三条策略

**策略一：按 `stat_year`（+ 维度/税号限定审计范围；DWD/DWS 无 `group_id`）**

DWD/DWS 为 **单表 + `stat_year` 列**（决策九）。**`group_id` 不在 DWD/DWS 落库**；「按集团看数」通过 **DM 层 `group_id`**（疑点结果）或 **UI 侧 JOIN `dim_org_node` / 税号过滤** 完成，而非在明细表增加 `group_id` 列：

```sql
-- 索引示例（以实际 schema 为准）
CREATE INDEX IF NOT EXISTS idx_dwd_header_year_date ON dwd_inv_header (stat_year, invoice_date);
CREATE INDEX IF NOT EXISTS idx_dwd_header_ym ON dwd_inv_header (stat_year, stat_month);

-- 单年 + 按销方税号范围（示例：与维度或参数表结合，非 group_id 列）
SELECT *
FROM dwd_inv_header
WHERE stat_year = 2024
  AND seller_tax_no IN (SELECT tax_no FROM dim_org_node WHERE ...);
```

**策略二：ODS 层改用 Parquet 文件存储**

3 亿行原始数据不写入 DuckDB，改为每批次导入时直接保存为 Parquet 文件，DuckDB 通过视图直接查询，无需导入。压缩比约 10:1，3 亿行约占 15–20 GB：

```python
from pathlib import Path
from uuid import uuid4
import polars as pl

# 导入时写 Parquet（不写 DuckDB）；目录与文件名见下文「ODS 文件名与目录规范」
# 示例：data/ods/批次=20260326/表类型=信息汇总表/序号=0001/20260327143022_信息汇总表_<uuid>.parquet
out_path = (
    Path("data/ods")
    / f"批次={batch_yyyymmdd}"
    / f"表类型={path_sheet}"
    / f"序号={seq:04d}"
    / f"{import_ts_14}_{path_sheet}_{uuid4().hex}.parquet"
)
df_pl.write_parquet(out_path, compression="zstd")

# DuckDB 用视图覆盖所有 Parquet（hive_partitioning 解析 批次/表类型/序号）
conn.execute("""
    CREATE OR REPLACE VIEW ods_invoice_raw AS
    SELECT *,
           CAST("批次" AS VARCHAR)   AS ods_batch_id,
           CAST("表类型" AS VARCHAR) AS table_type,
           CAST("序号" AS VARCHAR)   AS ods_seq
    FROM parquet_scan('data/ods/**/*.parquet', hive_partitioning=true, filename=true)
""")
```

**策略三：跨集团分析只查 DWS 汇总层**

30 户横向对比（评分卡、集中度排名）只读 DWS 层（3500 万行），不扫 6 亿行明细。DWS 层在每次新数据写入后增量刷新，跨集团查询响应时间控制在 10 秒以内。

#### 典型查询性能参考（32 GB RAM / 8 核工作站）

| 查询类型 | 数据量 | 预估耗时 |
|----------|--------|----------|
| 单户月度趋势（GROUP BY） | 1000 万行 | 1–5 秒 |
| 单户供应商集中度 | 1000 万行 | 2–8 秒 |
| 单户全量疑点扫描（10 条规则） | 1000 万行 | 10–30 秒 |
| 30 户横向对比（读 DWS） | 3500 万行 | 5–15 秒 |
| 全库税号自连接（关联交易） | 3 亿行 | 60–300 秒（建议异步执行） |

内存不足时（如 16 GB 机器），DuckDB 自动溢写磁盘临时文件，性能下降但不崩溃。

#### 数据库文件布局

```
data/
├── warehouse.duckdb          # DuckDB：DWD + DWS 层（含分区索引）
# DM/ADS 数据已并入 warehouse.duckdb
└── ods/                      # Parquet 文件目录（ODS 原始层）
    └── 批次={YYYYMMDD}/      # 业务导入批次（可与实际写入日不同）
        └── 表类型={Sheet}/     # 经归一化+安全化后的 sheet 名
            └── 序号={0001}/   # 同批次同表类型下，成功写出 Parquet 的递增序号
                └── {YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet
```

### 项目文件结构（目标）

```
invoice_audit_tool/
├── main.py                    # 程序入口，启动 Streamlit
├── requirements.txt
├── config/
│   ├── settings.py            # 全局配置（阈值、规则开关、SCOPE、LICENSE）
│   ├── license.py             # 授权模块（.lic 文件加载/验证/功能门控）
│   ├── field_mapping.py       # 字段映射表
│   └── industry_benchmarks.py # 行业基准阈值模板（按行业门类）
├── db/
│   ├── duckdb_conn.py         # DuckDB 连接管理（分析引擎）
│   ├── sqlite_conn.py         # 【遗留】初稿占位；本阶段不引入 SQLite 业务库
│   ├── schema_duckdb.py       # DuckDB DDL（dwd_/dws_/dim_ 单表 + stat_year，决策九）
│   ├── schema_sqlite.py       # 【遗留】初稿占位；DM/ADS 以 DuckDB 为准
│   └── migrations.py          # 版本升级脚本
├── modules/
│   ├── loader.py              # 金税 Excel → ODS Parquet
│   ├── cleaner.py             # ODS → DWD（清洗 + 质量标记）
│   ├── aggregator.py          # DWD → DWS 增量刷新
│   ├── dim_loader.py          # 维度数据导入（企业信息 / 税收编码 / 层级）
│   ├── jiuqi_loader.py        # 久其报表数据导入（Excel 导出方式）
│   ├── analyzer/
│   │   ├── overview.py        # 基础看板
│   │   ├── supplier.py        # 供应商集中度
│   │   ├── anomaly.py         # 审计疑点自动标记
│   │   ├── related_party.py   # 关联交易识别
│   │   └── cross_validation.py # 发票 vs 久其财务数据交叉校验
│   └── reporter.py            # 报告生成
├── ui/
│   ├── pages/
│   │   ├── 01_数据导入.py      # 金税发票导入
│   │   ├── 02_维度管理.py      # 企业维度 / 编码维度维护
│   │   ├── 03_数据概览.py
│   │   ├── 04_供应商分析.py
│   │   ├── 05_审计疑点.py
│   │   ├── 06_关联交易.py
│   │   ├── 07_财务校验.py      # 久其数据对比
│   │   ├── 08_子公司对比.py
│   │   └── 09_生成报告.py
│   └── components/
│       ├── risk_badge.py
│       └── data_table.py
├── data/
│   ├── warehouse.duckdb       # DuckDB（DWD/DWS 单表 + stat_year + DIM，决策九）
│   # 无 app.db：DM/ADS 已合并入 warehouse.duckdb
│   └── ods/                   # ODS 原始层 Parquet（发票：批次/表类型/序号 + 文件名规范见「ODS 文件名与目录规范」）
│       ├── 批次={YYYYMMDD}/表类型={Sheet}/序号={0001}/{YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet
│       └── jiuqi/             # 久其报表原始数据（一期预留，路径另述）
├── output/                    # 报告输出
└── assets/
    └── logo.png
```

---

## 二、数据分层架构

### 整体分层说明

采用标准数仓七层架构（ODS / DWD / DWS / DIM / DM / ADS + 久其预留层），每层用表名前缀严格区分：

```
金税 Excel（各下属企业导出）        久其报表（.jio / Excel，一期预留）
          ↓  loader.py                        ↓  jiuqi_loader.py（一期仅预留接口）
    ODS 层（Parquet 文件）         ODS_JIUQI 层（Parquet 文件，一期预留）
    原始数据完整保留；发票 ODS 按「批次/表类型/序号」目录 + 统一文件名规范落盘（见「ODS 文件名与目录规范」）

          ↓  cleaner.py（ETL）
    DWD 层（主表 + 明细表 + 映射表；单表 + stat_year，决策九；净额宽表内嵌主表）
    ├── dwd_inv_header    发票主表（一张发票一行，含 net_* 等净额字段）
    ├── dwd_inv_detail    发票明细表（一条商品行一行）
    └── dwd_inv_map       映射/溯源表（多来源、多批次；**无 group_id**）
          ↓  aggregator.py              DIM 层（维度层，全量替换刷新）
    DWS 层（单表 + stat_year，按主题汇总）    ├── dim_org_sys（系统分类：省属/市属）
               ├── dim_org_node（企业节点，含行业）
    ├── dws_trade_sum     ├── dim_org_hier（层级）
    ├── dws_inv_trend         ├── dim_tax_code（税收分类编码）
    ├── dws_sup_conc          └── dim_ind_rule（行业分析规则）
    ├── dws_goods_cat
    └── dws_quality

          ↓  analyzer/
    DM  层（各专项分析结果，按分析批次管理）
    ├── dm_audit_flag（审计疑点）
    ├── dm_circ_inv（对开发票）
    └── dm_shell_co（通道公司）

          ↓
    ADS 层（直接对接 UI 和报告）
    ├── ads_scorecard（子公司评分卡）
    └── ads_group（集团信息）
```

**数据库引擎：** 以 **DuckDB 嵌入式单文件（warehouse.duckdb）** 为分析主库（决策一）；若下文仍出现「待确认引擎」字样，视为历史残留，以本节与「编写前一致性裁决」为准。

```
当前设计方案（推荐）：
  DuckDB（warehouse.duckdb） ← 全部层（DWD/DWS/DIM/DM/ADS）
  Parquet 文件               ← ODS 层原始归档（零成本存储）
  
  统一 DuckDB 的理由：桌面单用户工具，无并发压力；DuckDB 完整支持
  UPDATE/事务；一个文件一套连接，无需跨库协调
```

---

### ODS 层：原始数据层（Parquet 文件存储，不入 DuckDB）

**设计原则：** 忠实还原 Excel 原始数据，不做任何业务加工。3 亿行原始数据以 Parquet 文件形式保存，按 **批次 + 表类型（Sheet）+ 序号** 三级目录存储（Hive 分区），DuckDB 通过视图直接查询，无需导入。压缩比约 10:1，3 亿行约占 15–20 GB 磁盘空间。

**导入实现要点（A/B/C，后续实现与优化必须遵守）：**

- **A｜逐 Sheet 读取（不要一次性读完整工作簿）**
  - 使用 `pd.ExcelFile(path)` 后按 `sheet_names` 逐个 `read_excel(parse)`，避免 `sheet_name=None` 把整个工作簿一次性读入内存。
  - 对大文件优先只读必要列（至少包含 `序号` 与关键映射字段列），避免无意义的列膨胀。
- **B｜向量化校验与拒收（避免逐行 Python dict/for 循环）**
  - 行级拒收必须保留可定位信息（`sheet/序号/field/reason`），但拒收明细仅保留样本与区间摘要（`reject_row_samples`/`reject_row_ranges`），避免对 10 万+ 行生成海量 Python dict。
  - 合计/汇总行建议按「序号非数字 + 正则匹配」静默跳过，不进入拒收。
- **C｜ODS 仅保存“原始字符串/NULL”，强类型解析下沉到 DWD**
  - ODS 层不将金额/日期等字段强制转为 `Decimal/DATE`；仅做**缺失值归一化**与最小可用的行级有效性判定（例如：识别键是否全空、序号是否可定位）。
  - **缺失值归一化必须在 ODS 完成**：pandas `dtype=str` 常把空单元格读成文本 `"nan"`；以及 `--/N/A/null/none` 等占位符，ODS 必须统一写成真正的 `NULL`（Parquet 中为 null）。
  - 金额/日期的可解析性校验、格式规范化、精度控制与业务口径清洗，统一在 DWD 层实现，并形成可追溯的拒收/质量日志。
  - **DWD 拒收日志形状必须与 ODS 一致**（便于 UI 统一展示与回溯）：
    - `reject_row_ranges: [{seq_no_start, seq_no_end, reason}]`
    - `reject_row_samples: [{seq_no, sheet, field, reason, exception_type}]`

**ODS 文件名与目录规范（全文统一口径，必须一致）**

- **根目录**：`data/ods/`（或部署等价路径）
- **三级分区目录（Hive 分区键名固定）**：`批次={YYYYMMDD}/表类型={Sheet}/序号={0001}/`
  - `批次`：业务导入批次 ID（通常为 `YYYYMMDD`；**可与实际写入日不同**，例如批次 `20260326` 在次日 `20260327143022` 才写入）
  - `表类型`：Sheet 显示名经 `normalize_sheet_name()` + `sanitize_sheet_name()` 后的**安全化字符串**，与目录名、文件名中段一致
  - `序号`：四位零填充；在同一 `批次+表类型` 下，按 **成功写出 Parquet 的次数** 递增（`0001→0002→…`），由主进程统一分配，**不是** Excel 文件个数
- **文件名**：`{YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet`
  - `{YYYYMMDDHHMMSS}`：**实际导入时间**（14 位），与目录 `批次` **解耦**（允许跨日）
  - `{表类型}`：与目录 `表类型=` 段一致（同一安全化结果）
  - `{UUID}`：随机 UUID（建议 `uuid.uuid4().hex`），仅保证文件名唯一，不承载业务语义
- **完整示例**（批次与写入时间不同日）：
  - `data/ods/批次=20260326/表类型=信息汇总表/序号=0001/20260327143022_信息汇总表_a1b2c3d4e5f6478ab9cd0123ef456789.parquet`

```python
import os
import uuid
from pathlib import Path

# loader.py：导入时直接写 Parquet，不写数据库（Polars write_parquet；示例为骨架）
def save_to_ods_parquet(
    df_pl: "pl.DataFrame",
    *,
    batch_yyyymmdd: str,
    path_sheet: str,
    seq: int,
    import_ts_14: str,
) -> Path:
    """
    将原始 DataFrame 保存为 ODS Parquet 文件。
    路径：data/ods/批次={batch}/表类型={path_sheet}/序号={seq:04d}/
    文件：{import_ts_14}_{path_sheet}_{uuid}.parquet
    """
    uid = uuid.uuid4().hex
    fname = f"{import_ts_14}_{path_sheet}_{uid}.parquet"
    output_dir = Path(f"data/ods/批次={batch_yyyymmdd}/表类型={path_sheet}/序号={seq:04d}")
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / fname
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    df_pl.write_parquet(tmp, compression="zstd")
    os.replace(tmp, out_path)
    return out_path
```

```python
# duckdb_conn.py：用视图覆盖所有 ODS Parquet（动态发现新文件）
def register_ods_views(conn):
    """
    注册 ODS 统一视图（单 glob 扫描即可）。
    hive_partitioning=true 自动从目录名解析 批次 / 表类型 / 序号。
    """
    conn.execute("""
        CREATE OR REPLACE VIEW ods_invoice_raw AS
        SELECT *,
               CAST("批次" AS VARCHAR)   AS ods_batch_id,
               CAST("表类型" AS VARCHAR) AS table_type,
               CAST("序号" AS VARCHAR)   AS ods_seq,
               filename AS source_parquet_file_scan
        FROM parquet_scan('data/ods/**/*.parquet', hive_partitioning=true, filename=true)
    """)
```

**ODS 层导入批次记录表（存 DuckDB `warehouse.duckdb`，与 `ods_load_log` 实现一致）：**
```sql
-- 记录每次导入的元数据（以下为示意 DDL，以 `schema_duckdb.py` 为准）
CREATE TABLE IF NOT EXISTS ods_load_log (
    import_batch_id TEXT NOT NULL,        -- 业务导入批次（与 UI 参数 import_batch_id 一一对应）
    import_session_id TEXT NOT NULL,      -- 导入会话：同一批次允许多次导入会话；日志粒度按“会话”记
    load_time        TEXT NOT NULL,
    file_count       INTEGER,
    total_rows       INTEGER,
    success_count    INTEGER,
    fail_count       INTEGER,
    warn_count       INTEGER,
    parquet_paths    TEXT,            -- 本批次生成的 Parquet 完整路径列表（JSON），须符合「ODS 文件名与目录规范」
    detail_json      TEXT             -- 每个文件的详细日志（JSON）
    ,PRIMARY KEY (import_batch_id, import_session_id)
);
```

---

### DWD 层：明细清洗层（单表 + `stat_year`，全局去重 + 映射表设计，存 DuckDB）

**设计原则：** 三表结构。**`dwd_inv_header` / `dwd_inv_detail` / `dwd_inv_map` 均不含 `group_id`**（`group_id` 仅出现在 **DM** 层疑点/分析结果）。映射表承载溯源与多来源对齐（多行 `header_uuid`），**不**承担「集团分区键」；集团/范围视角通过 **维度表 JOIN** 或 **DM 层 `group_id`** 表达。净额字段内嵌主表，无单独净额表。

#### DWD 层整体架构示意

```
集团 A · 子公司甲              集团 B · 供应商乙
  进项发票导出                    销项发票导出
       │                               │
       └─────────┬─────────────────────┘
                 │ 同一张发票 fpdm+fphm 相同
                 ▼
  ┌─────────────────────────────────────────────────────────┐
  │  第一层：全局物理层（主表 + 明细表，均无 group_id）        │
  │                                                         │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │  dwd_inv_header（stat_year）全局发票主表（单表，决策九）│  │
  │  │  ┌───────────┐ ┌─────────────┐ ┌───────────────┐  │  │
  │  │  │ 原始字段   │ │  平账+红蓝  │ │  净额字段(宽) │  │  │
  │  │  │fpdm/fphm  │ │is_balanced  │ │ net_jshj ←核  │  │  │
  │  │  │xfsbh/gfsbh│ │balance_diff │ │red_offset_    │  │  │
  │  │  │slv/slv_num│ │related_blue_│ │ jshj          │  │  │
  │  │  │sfzsfp/fpzt│ │uuid(bz解析) │ │is_fully_      │  │  │
  │  │  │je/se/jshj │ │             │ │ reversed      │  │  │
  │  │  └───────────┘ └─────────────┘ └───────────────┘  │  │
  │  │  先到先得：相同 header_uuid 只保留第一条            │  │
  │  └───────────────────────────────────────────────────┘  │
  │                         │ header_uuid（逻辑外键）        │
  │                         ▼                               │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │  dwd_inv_detail（stat_year）全局发票明细表（单表）   │  │
  │  │  与主表成对，物理发票属性，同样无 group_id          │  │
  │  │  logic_line_no = 0（汇总参考行）通过 WHERE > 0 排除│  │
  │  └───────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────┘
                 │ header_uuid（逻辑外键）
                 ▼
  ┌─────────────────────────────────────────────────────────┐
  │  第二层：溯源映射层（无 group_id）                       │
  │                                                         │
  │  dwd_inv_map（stat_year）实体发票映射/溯源表             │
  │  [来源A · 进项视角] ↔ header_uuid ↔ [来源B · 销项视角]   │
  │                                                         │
  │  同一张发票对应多行（多来源/多批次导入痕迹）               │
  │  「按集团」不在此表用 group_id 表达；见 DM 与维度         │
  └─────────────────────────────────────────────────────────┘

关键设计决策汇总（AI 编码时严格遵守）：
  [表顺序]   主表 → 明细表（均全局）→ 映射表（溯源，无 group_id）
  [去重]     相同 header_uuid 先到先得，第二次导入只写映射表
             若金额差异 > 0.01 元，映射表 clean_status 标记"金额与主表存在差异"
  [净额]     净额字段内嵌主表（宽表），无单独净额表
             DWS 聚合直接 SUM(net_jshj)，不需要 JOIN 任何净额表
  [孤立红票] 未关联到蓝票的红票，net_jshj 保留负值参与聚合（宽口径）
  [税率字段] slv 保留原始字符串（"13%"/"免税"/"***"/空等各种情况）
             slv_num 仅在 slv 可转换为数字时存入，其他情况默认存 0
  [group_id] DWD 全部无 group_id；集团维度在 **DM（group_id）** 或 **JOIN dim_* / 税号条件**
```

#### 表命名体系（全局统一）

命名规则：`{层前缀}_{主题域}_{对象类型}`；**决策九下 DWD/DWS 发票类表不再使用 `_{YYYY}` 后缀**，年度用列 `stat_year` 表达。去除 full / data / info / entity 等修饰性噪音词。

| 层 | 新表名 | 主题域 | 对象类型 | 年度后缀 |
|---|---|---|---|---|
| DWD | `dwd_inv_header`（含 `stat_year`） | inv（发票） | header | **否（决策九）** |
| DWD | `dwd_inv_detail`（含 `stat_year`） | inv | detail | **否** |
| DWD | `dwd_inv_map`（含 `stat_year`；**无 `group_id`**） | inv | map（溯源映射） | **否** |
| DWS | `dws_trade_sum`（含 `stat_year`） | trade（交易） | sum（汇总） | **否** |
| DWS | `dws_inv_trend`（含 `stat_year`） | inv | trend（月度趋势） | **否** |
| DWS | `dws_sup_conc`（含 `stat_year`） | sup（供应商） | conc（集中度） | **否** |
| DWS | `dws_goods_cat`（含 `stat_year`） | goods（商品） | cat（品类） | **否** |
| DWS | `dws_quality`（含 `stat_year`） | dq（数据质量） | — | **否** |
| DIM | `dim_org_sys` | org | sys（系统分类） | 否 |
| DIM | `dim_org_node` | org | node（节点基础） | 否 |
| DIM | `dim_org_hier` | org | hier（双树层级）| 否 |
| DIM | `dim_org_hier_log` | org | hier_log（变更日志）| 否 |
| DIM | `dim_tax_code` | tax | code（编码） | 否 |
| DIM | `dim_ind_rule` | ind（行业） | rule（规则） | 否 |
| DM | `dm_audit_flag` | audit | flag（疑点标记） | 否 |
| DM | `dm_circ_inv` | circ（循环/对开） | inv | 否 |
| DM | `dm_shell_co` | shell（通道） | co（公司） | 否 |
| ADS | `ads_scorecard` | — | scorecard（评分卡） | 否 |
| ADS | `ads_group` | — | group（集团） | 否 |
| ADS | `ads_org_member` | org | member（成员配置） | 否 |

#### 为什么用 DuckDB 而不是 MySQL 处理平账

DuckDB 支持完整 DML（INSERT/UPDATE/DELETE/事务），不适合的是"高频并发小事务"。平账校验是"导入后跑一次批量 UPDATE"，完全适合 DuckDB：

```python
# aggregator.py：平账校验批量更新（一次导入跑一次，非高频并发）
conn.execute("""
    UPDATE dwd_inv_header
    SET
        detail_total_amount = sub.detail_sum,
        balance_diff        = jshj - sub.detail_sum,
        is_balanced         = CASE
            WHEN ABS(jshj - sub.detail_sum) <= balance_tolerance THEN '平账'
            WHEN ABS(jshj - sub.detail_sum) <= 1.0               THEN '差异可接受'
            ELSE '不平账'
        END,
        balance_check_time  = NOW()
    FROM (
        SELECT header_uuid, SUM(jshj) AS detail_sum
        FROM dwd_inv_detail
        WHERE logic_line_no > 0          -- 排除 hwlwmc 含「详见销货清单」等汇总参考行
        GROUP BY header_uuid
    ) sub
    WHERE dwd_inv_header.header_uuid = sub.header_uuid
""")
```

#### 全局去重架构说明

```
同一张物理发票，可能被多家企业从金税系统导出：
  集团 A 的子公司甲（进项）  ──┐
  集团 B 的供应商乙（销项）  ──┤──→ 全局主表存一份（先到先得）
  集团 A 的其他企业（进项）  ──┘     映射表记录每个视角（多行）

优势：
  1. 存储节省：N 个集团共同拥有的发票只存 1 份
  2. 审计价值：同一张发票可同时看到买卖双方视角，用于关联交易识别
  3. 数据一致：平账校验只做一次，不存在同一张发票两份不同平账结果
```

#### 表一：`dwd_inv_header`（全局发票主表，含净额字段）

**无 `group_id`，按 `stat_year` + `header_uuid` 唯一（单表，决策九），先到先得去重。净额字段直接内嵌于主表（宽表设计），无需单独净额表。**

净额是物理发票本身的属性（这张发票扣除红冲后实际有效金额是多少），与任何集团/企业的视角无关，因此合并入全局主表是正确的。主表已有 `is_balanced`、`balance_diff` 等派生回填字段，净额字段与其风格一致，DWS 聚合时直接 SELECT 无需 JOIN。

#### DWD 层建表（单表版，决策九）

DWD 层采用单表 + stat_year 列，不按年度分表。完整 DDL 见 `db/schema_duckdb.py`。

核心结构：
- `dwd_inv_header`：全局发票主表（含 stat_year，先到先得去重，净额宽表内嵌）
- `dwd_inv_detail`：全局发票明细表（含 stat_year，logic_line_no=0 为汇总参考行）
- `dwd_inv_map`：实体发票映射/溯源表（含 `stat_year`，**无 `group_id`**）

典型查询示例：
```sql
-- 单年查询（WHERE stat_year 自动走列存储过滤）
SELECT h.header_uuid, h.net_jshj, m.entity_name
FROM dwd_inv_header h
JOIN dwd_inv_map m ON h.stat_year = m.stat_year AND h.header_uuid = m.header_uuid
WHERE h.stat_year = 2024;
  -- 若需「按集团」视角，在应用层 JOIN dim_org_* 或使用 DM 层结果（含 group_id）

-- 跨年查询（直接在单表上加范围条件）
SELECT stat_year, SUM(net_jshj)
FROM dwd_inv_header
WHERE stat_year BETWEEN 2021 AND 2024
GROUP BY stat_year;
```

---

### DM 层：数据集市层（Data Mart，存 DuckDB）

**设计原则：** 各专项分析的结果存储，存入 DuckDB（warehouse.duckdb），与 DWD/DWS 同库。每次重新运行分析时按 group_id + analysis_batch 覆盖。审计人员的确认状态（is_confirmed/confirm_note）通过 DuckDB UPDATE 逐行更新。

```sql
-- 审计疑点明细表
CREATE TABLE IF NOT EXISTS dm_audit_flag (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    flag_id          TEXT NOT NULL,        -- FP-2024-001 格式
    rule_id          TEXT NOT NULL,
    risk_level       TEXT NOT NULL,
    flag_type        TEXT NOT NULL,
    company_name     TEXT,
    seller_name      TEXT,
    seller_tax_no    TEXT,
    amount           REAL,
    invoice_list     TEXT,                 -- JSON 数组
    description      TEXT,
    suggestion       TEXT,
    is_confirmed     INTEGER DEFAULT 0,    -- 审计人员确认状态（支持用户交互）
    confirm_note     TEXT,
    created_at       TEXT NOT NULL,
    analysis_batch   TEXT NOT NULL,
    UNIQUE (group_id, flag_id, analysis_batch)
);

-- 关联交易——对开发票
CREATE TABLE IF NOT EXISTS dm_circ_inv (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    party_a_tax      TEXT NOT NULL,
    party_a_name     TEXT,
    party_b_tax      TEXT NOT NULL,
    party_b_name     TEXT,
    amount_a_to_b    REAL,
    amount_b_to_a    REAL,
    circular_ratio   REAL,
    risk_level       TEXT NOT NULL,
    analysis_batch   TEXT NOT NULL,
    UNIQUE (group_id, party_a_tax, party_b_tax, analysis_batch)
);

-- 关联交易——疑似通道公司
CREATE TABLE IF NOT EXISTS dm_shell_co (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    group_member_tax TEXT NOT NULL,
    group_member_name TEXT,
    intermediary_tax TEXT NOT NULL,
    intermediary_name TEXT,
    final_target_tax TEXT,
    final_target_name TEXT,
    amount_in        REAL,
    amount_out       REAL,
    passthrough_ratio REAL,
    risk_level       TEXT NOT NULL,
    analysis_batch   TEXT NOT NULL
);

-- 供应商集中度分析结果
CREATE TABLE IF NOT EXISTS dm_supplier_concentration (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    company_name     TEXT NOT NULL,
    cr1              REAL,
    cr3              REAL,
    cr5              REAL,
    cr10             REAL,
    cr1_risk         TEXT,
    cr3_risk         TEXT,
    cr10_risk        TEXT,
    top_suppliers    TEXT,                 -- JSON
    analysis_batch   TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    UNIQUE (group_id, company_name, analysis_batch)
);
```

### ADS 层：应用数据层（Application Data Store，存 DuckDB）

**设计原则：** 专为 UI 和报告定制，直接 SELECT 即可，无需再做计算。存 DuckDB（warehouse.duckdb）。

```sql
-- 子公司综合评分卡
CREATE TABLE IF NOT EXISTS ads_scorecard (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    company_name     TEXT NOT NULL,
    total_amount     REAL,
    total_count      INTEGER,
    supplier_count   INTEGER,
    flag_total       INTEGER DEFAULT 0,
    flag_high        INTEGER DEFAULT 0,
    flag_medium      INTEGER DEFAULT 0,
    flag_low         INTEGER DEFAULT 0,
    risk_score       INTEGER DEFAULT 100,
    risk_level       TEXT,
    cr1              REAL,
    cancel_ratio     REAL,
    analysis_batch   TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (group_id, company_name, analysis_batch)
);

-- 集团成员税号配置（用户在 UI 中维护，是关联交易分析的前提）
CREATE TABLE IF NOT EXISTS ads_org_member (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL,
    tax_no           TEXT NOT NULL,
    company_name     TEXT NOT NULL,
    is_active        INTEGER DEFAULT 1,
    added_at         TEXT NOT NULL,
    UNIQUE (group_id, tax_no)
);

-- 集团信息表（30 户集团的基本信息）
CREATE TABLE IF NOT EXISTS ads_group (
    group_id         TEXT PRIMARY KEY,
    group_name       TEXT NOT NULL,
    province         TEXT,
    industry         TEXT,                -- 用于行业基准阈值匹配
    data_years       TEXT,                -- 已导入的年份列表（JSON）
    total_companies  INTEGER DEFAULT 0,   -- 下属企业数量
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
```

---

### DIM 层：维度层（存 DuckDB，支持导入/维护/导出）

**设计原则：** 维度数据是分析的"坐标轴"。企业系统分类（省属/市属等）静态维护；节点基础信息全量替换；层级关系按年度快照 UPSERT，同时写变更日志。人工只需录入父节点和排序号，路径/层级深度/是否叶子等均由 ETL 自动计算回填。

**UI 操作流：** `选企业系统（省属/市属）→ 选年度 → 选树类型（管理树/产权树）→ 浏览上下级关系`

#### 企业维度三表结构

```
dim_org_sys         企业系统分类（省属/XX市属/XX区属，静态）
    │ sys_id（1:N）
dim_org_node        企业节点基础信息（每家企业一行，不含年度）
    │ entity_id（1:N，按年度）
dim_org_hier        双树年度层级快照（人工录入父节点+排序，ETL自动计算路径）
    │ （变更时写入）
dim_org_hier_log    层级变更历史日志
```

#### dim_org_sys：企业系统分类表

```sql
-- 静态配置，不含年度。新增市属/区属企业只需加一条记录
CREATE TABLE IF NOT EXISTS dim_org_sys (
    sys_id       VARCHAR NOT NULL PRIMARY KEY,
    -- 系统标识码，如 PROV_SD（山东省属）、CITY_JN（济南市属）

    sys_name     VARCHAR NOT NULL,   -- 显示名称，如"山东省属企业"
    admin_level  VARCHAR NOT NULL,   -- 行政层级：省 / 市 / 区县
    gov_owner    VARCHAR,            -- 出资人机构，如"山东省国资委"
    sort_no      INTEGER,            -- UI 选择列表的显示顺序
    is_active    BOOLEAN DEFAULT TRUE
);
```

#### dim_org_node：企业节点基础表

**粒度：每家企业一行，不含层级关系，不含年度。**

```sql
CREATE TABLE IF NOT EXISTS dim_org_node (
    entity_id        VARCHAR NOT NULL PRIMARY KEY,
    -- 统一社会信用代码（18位）
    -- 各系统虚拟根节点格式：ROOT_{sys_id}，如 ROOT_PROV_SD

    sys_id           VARCHAR NOT NULL,   -- 所属企业系统，关联 dim_org_sys
    entity_fullname  VARCHAR NOT NULL,   -- 企业全称
    entity_shortname VARCHAR,            -- 企业简称（UI 树节点展示、文件命名）
    entity_type      VARCHAR,
    -- 企业法人性质/组织形态（与树层级无关）
    -- 【待讨论】枚举值定义暂缓，见"阶段二待议事项"

    main_business    VARCHAR,
    -- 主责主业（业务范围描述，用于行业分析和风险分类）

    industry_id      VARCHAR,            -- 行业门类 ID（单字母，如 C=制造业）
    industry_name    VARCHAR,            -- 行业门类名称
    is_stat_inc      BOOLEAN DEFAULT TRUE,
    -- 是否纳入统计范围（DWS 层聚合的核心过滤字段）

    reg_capital      DECIMAL(18,2),      -- 注册资本（万元）
    established_date DATE,               -- 成立日期
    is_active        BOOLEAN DEFAULT TRUE, -- 是否在营（false=注销/吊销）
    updated_at       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_node_sys      ON dim_org_node (sys_id);
CREATE INDEX IF NOT EXISTS idx_node_industry ON dim_org_node (sys_id, industry_id);
```

#### dim_org_hier：双树年度层级快照表（核心表）

**粒度：每家企业每个年度一行，同时维护产权树和管理树两套父子关系。**

**离线独立使用说明：**
每个安装实例的 `dim_org_hier` 是完全独立的。二级企业独立安装时，只需录入自己作为根节点（`mg_parent_id = 自身 entity_id`，自引用）以及其下属企业的父节点关系，不需要也不应该录入上级集团的数据。不同实例之间数据隔离，互不影响。

**字段分两类：人工录入 5 个，ETL 自动计算/填充 15 个。**

Excel 导入模板只含人工录入字段。路径、层级深度、是否叶子等全部由 `dim_loader.py` 基于父节点递归计算；名称冗余字段由 ETL 从 `dim_org_node` 自动同步，禁止人工填写。

```
人工录入（5个）：
  管理树：mg_parent_id（上级管理单位，根节点填自己的 entity_id）、mg_sort_no
  产权树：eq_parent_id（上级产权单位，根节点填自己的 entity_id）、eq_sort_no、eq_shareholding_ratio

ETL 自动计算（11个）：
  管理树：mg_level、mg_path、mg_path_ids、mg_root_group_id、mg_is_leaf
  产权树：eq_level、eq_path、eq_path_ids、eq_root_group_id、eq_is_leaf
  差异标记：is_hier_diff

ETL 从 dim_org_node 自动同步冗余名称（4个）：
  entity_shortname、entity_fullname
  mg_parent_shortname、mg_parent_fullname、eq_parent_shortname、eq_parent_fullname
```

**具体示例（浪潮集团旗下，浪潮云托管给浪潮信息管理）：**

```
dim_org_hier 中浪潮云这一行（2024年）：
  entity_id        = '9137016000...'  （浪潮云）
  stat_year        = 2024

  mg_parent_id     = '9137014000...'  ← 【人工录入】管理上级：浪潮信息
  mg_sort_no       = 1               ← 【人工录入】在浪潮信息下排第1
  mg_level         = 3               ← 【自动计算】集团→信息→云，第3层
  mg_path          = '浪潮集团/浪潮信息/浪潮云'  ← 【自动计算】有简称用简称，无简称用全称
  mg_path_ids      = '9137000.../9137014.../9137016...'  ← 【自动计算】
  mg_root_group_id = '9137000163...' ← 【自动计算】顶层集团
  mg_is_leaf       = TRUE            ← 【自动计算】无管理下级

  eq_parent_id     = '9137000163...' ← 【人工录入】产权上级：浪潮集团（直属）
  eq_sort_no       = 3               ← 【人工录入】在集团下产权排第3
  eq_level         = 2               ← 【自动计算】集团→云，第2层
  eq_path          = '浪潮集团/浪潮云'  ← 【自动计算】
  eq_shareholding_ratio = 1.0000     ← 【人工录入】集团100%持股

  is_hier_diff     = TRUE            ← 【自动计算】mg_parent≠eq_parent，管产分离
  hier_diff_note   = '托管给浪潮信息管理，产权仍归集团'  ← 人工填写
```

```sql
CREATE TABLE IF NOT EXISTS dim_org_hier (
    hier_id          VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(entity_id || stat_year)

    entity_id        VARCHAR NOT NULL,   -- 关联 dim_org_node.entity_id
    entity_shortname VARCHAR,
    -- 【冗余·自动填充】本节点简称，从 dim_org_node 导入时同步写入

    entity_fullname  VARCHAR,
    -- 【冗余·自动填充】本节点全称，从 dim_org_node 导入时同步写入
    -- 理由：UI 编辑节点时需要显示全称以确认企业；避免每次编辑都 JOIN
    -- 冗余策略：节点信息变更时，dim_loader.py 同步更新此字段

    sys_id           VARCHAR NOT NULL,   -- 冗余，加速按系统过滤
    stat_year        SMALLINT NOT NULL,  -- 统计年度，每年生成一次快照

    -- ── 根节点说明 ──────────────────────────────────────────
    -- 根节点识别规则：mg_parent_id = entity_id（自引用）即为管理树根节点
    -- 根节点的父节点填自己的 entity_id，不填 NULL
    -- 理由：NULL 有歧义（未填写上级的企业也是 NULL），自引用语义明确
    -- ETL 计算路径时遇到自引用即停止，不会死循环
    -- 审计厅安装：虚拟根节点 ROOT_PROV_SD 的 mg_parent_id = 'ROOT_PROV_SD'
    -- 集团独立安装：集团自身的 mg_parent_id = 集团自身的 entity_id
    -- 子公司独立安装：子公司自身的 mg_parent_id = 子公司自身的 entity_id

    -- ── 管理树（人工录入：2个字段）──────────────────────────
    mg_parent_id          VARCHAR,
    -- 【录入】上级管理单位 entity_id
    -- 根节点填自己的 entity_id（自引用），其他填直接管理上级

    mg_parent_shortname   VARCHAR,
    -- 【冗余·自动填充】管理上级简称，ETL 写入时从 dim_org_node 同步

    mg_parent_fullname    VARCHAR,
    -- 【冗余·自动填充】管理上级全称，ETL 写入时从 dim_org_node 同步
    -- 用于正式报告中"上级管理单位"字段的完整表述

    mg_sort_no            INTEGER,
    -- 【录入】管理排序号（同一管理上级下的显示顺序，从 1 起）

    -- ── 管理树（ETL 自动计算：5个字段）─────────────────────
    mg_level         TINYINT,
    -- 【自动】管理层级深度（0=根，1=一级，2~6=下级，最深不超过 6）

    mg_path          VARCHAR,
    -- 【自动】管理树全路径，/ 分隔，有简称用简称，无简称用全称
    -- 示例：省国资委/浪潮集团/浪潮信息/浪潮云

    mg_path_ids      VARCHAR,
    -- 【自动】管理树全路径（entity_id），/ 分隔
    -- 子孙过滤：WHERE mg_path_ids LIKE '%/91370xxx/%'

    mg_root_group_id VARCHAR,
    -- 【自动】管理树顶层一级集团 entity_id（加速集团维度聚合）

    mg_is_leaf       BOOLEAN DEFAULT TRUE,
    -- 【自动】管理树是否叶子节点（无管理下级）

    -- ── 产权树（人工录入：3个字段）──────────────────────────
    eq_parent_id          VARCHAR,
    -- 【录入】上级产权单位 entity_id
    -- 根节点填自己的 entity_id（自引用），其他填直接产权上级

    eq_parent_shortname   VARCHAR,
    -- 【冗余·自动填充】产权上级简称，ETL 写入时从 dim_org_node 同步

    eq_parent_fullname    VARCHAR,
    -- 【冗余·自动填充】产权上级全称，ETL 写入时从 dim_org_node 同步

    eq_sort_no            INTEGER,
    -- 【录入】产权排序号（同一产权上级下的显示顺序，从 1 起）

    eq_shareholding_ratio DECIMAL(7,4),
    -- 【录入】上级直接持股比例（0.0001~1.0000），NULL = 100% 全资

    -- ── 产权树（ETL 自动计算：5个字段）─────────────────────
    eq_level         TINYINT,
    -- 【自动】产权层级深度（0=根，1=一级，2~6=下级）

    eq_path          VARCHAR,
    -- 【自动】产权树全路径（简称）

    eq_path_ids      VARCHAR,
    -- 【自动】产权树全路径（entity_id），用于子孙过滤

    eq_root_group_id VARCHAR,
    -- 【自动】产权树顶层一级集团 entity_id

    eq_is_leaf       BOOLEAN DEFAULT TRUE,
    -- 【自动】产权树是否叶子节点（无产权下级）

    -- ── 差异标记（ETL 自动计算）─────────────────────────────
    is_hier_diff     BOOLEAN DEFAULT FALSE,
    -- 【自动】mg_parent_id ≠ eq_parent_id 时为 TRUE（管产分离）
    -- 审计重点：管辖权与股权归属不一致的企业（托管/委托管理等场景）

    hier_diff_note   VARCHAR,
    -- 【人工】差异说明，如"托管给XX集团管理，产权仍属XX集团"

    updated_at       TIMESTAMP,
    updated_by       VARCHAR DEFAULT 'SYSTEM',

    UNIQUE (entity_id, stat_year)
);

CREATE INDEX IF NOT EXISTS idx_hier_sys_year      ON dim_org_hier (sys_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_entity_year   ON dim_org_hier (entity_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_mg_parent     ON dim_org_hier (mg_parent_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_eq_parent     ON dim_org_hier (eq_parent_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_mg_root       ON dim_org_hier (mg_root_group_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_eq_root       ON dim_org_hier (eq_root_group_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_diff          ON dim_org_hier (is_hier_diff, stat_year);
```

#### dim_org_hier_log：层级变更历史日志

记录每次层级调整前后状态，用于审计溯源。

```sql
CREATE TABLE IF NOT EXISTS dim_org_hier_log (
    log_id           BIGINT NOT NULL PRIMARY KEY,
    entity_id        VARCHAR NOT NULL,
    stat_year        SMALLINT NOT NULL,
    change_type      VARCHAR,
    -- 变更类型：新增 / 注销 / 产权变更 / 管理变更 / 信息修改
    old_eq_parent_id VARCHAR,  new_eq_parent_id VARCHAR,
    old_mg_parent_id VARCHAR,  new_mg_parent_id VARCHAR,
    change_note      VARCHAR,
    changed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by       VARCHAR DEFAULT 'SYSTEM'
);
```

**维度表导入/维护/导出规范（`dim_loader.py` 实现）：**

```python
# Excel 导入模板的列（人工填写列，自动计算列不出现在模板中）
IMPORT_COLUMNS = [
    'entity_id',       'entity_fullname', 'entity_shortname',
    'sys_id',          'entity_type',     'main_business',
    'industry_id',     'is_stat_inc',     'reg_capital',
    'established_date','is_active',
    # 管理树（人工填写）
    'mg_parent_id',    'mg_sort_no',
    # 产权树（人工填写）
    'eq_parent_id',    'eq_sort_no',      'eq_shareholding_ratio',
    # 差异说明（人工填写）
    'hier_diff_note',
]
# 注：mg_level/mg_path/eq_level/eq_path 等自动计算字段不在模板中

def import_org_hierarchy(excel_path: str, stat_year: int, sys_id: str, conn):
    """
    步骤一：读取 Excel，校验必填字段（entity_id 18位格式、sys_id 合法）
    步骤二：校验根节点规则
            根节点的 mg_parent_id = 自身 entity_id（自引用）
            mg_parent_id 为空（NULL/空字符串）的行视为数据缺失，报错提示填写
    步骤三：自动计算路径和层级
            递归向上拼接，遇到自引用（parent = self）即停止，不会死循环
            路径规则：有 entity_shortname 用简称，无简称用 entity_fullname
    步骤四：自动标记 is_hier_diff（eq_parent_id ≠ mg_parent_id 时为 TRUE）
    步骤五：自动计算 is_leaf（检查是否有其他行以本节点为 parent_id）
    步骤六：从 dim_org_node 同步冗余字段：
            entity_shortname / entity_fullname /
            mg_parent_shortname / mg_parent_fullname /
            eq_parent_shortname / eq_parent_fullname
    步骤七：对比上一年度数据，差异写入 dim_org_hier_log
    步骤八：UPSERT 写入 dim_org_hier（相同 entity_id+stat_year 则覆盖）
    """

def export_org_hierarchy(stat_year: int, sys_id: str, conn) -> bytes:
    """
    导出为 Excel（格式与导入模板一致，可直接修改后重新导入）
    注：entity_shortname / entity_fullname 等冗余字段在导出文件中显示，
    但重新导入时以 dim_org_node 中的权威数据为准，不从导入文件中读取
    """
```

**核心查询示例：**

```sql
-- UI 第一步：选择企业系统
SELECT sys_id, sys_name FROM dim_org_sys WHERE is_active = TRUE ORDER BY sort_no;

-- UI 第二步：该系统有数据的年度
SELECT DISTINCT stat_year FROM dim_org_hier
WHERE sys_id = 'PROV_SD' ORDER BY stat_year DESC;

-- 管理树：某集团下所有企业按管理排序
SELECT n.entity_shortname, h.mg_level, h.mg_path, h.mg_sort_no
FROM dim_org_hier h JOIN dim_org_node n ON h.entity_id = n.entity_id
WHERE h.sys_id = 'PROV_SD' AND h.stat_year = 2024
  AND h.mg_root_group_id = '91370001630477270'
ORDER BY h.mg_path_ids, h.mg_sort_no;

-- 产权树：同集团按产权排序（含持股比例）
SELECT n.entity_shortname, h.eq_level, h.eq_path,
       h.eq_sort_no, h.eq_shareholding_ratio
FROM dim_org_hier h JOIN dim_org_node n ON h.entity_id = n.entity_id
WHERE h.sys_id = 'PROV_SD' AND h.stat_year = 2024
  AND h.eq_root_group_id = '91370001630477270'
ORDER BY h.eq_path_ids, h.eq_sort_no;

-- 管产分离企业（审计重点）
SELECT n.entity_shortname, h.eq_path AS 产权路径,
       h.mg_path AS 管理路径, h.hier_diff_note
FROM dim_org_hier h JOIN dim_org_node n ON h.entity_id = n.entity_id
WHERE h.is_hier_diff = TRUE AND h.sys_id = 'PROV_SD' AND h.stat_year = 2024;
```


#### dim_tax_code：商品和服务税收分类编码表

来源：用户上传的**商品和服务税收分类编码表.xls**（4205 行，国家标准）。

该编码表为 11 级层级结构（篇/类/章/节/条/款/项/目/子目/细目），用 19 位合并编码（`tax_code`）唯一标识每个节点。发票中的商品名称通过模糊匹配关联到本表，实现标准化的品类分析。

```sql
CREATE TABLE IF NOT EXISTS dim_tax_code (
    tax_code         VARCHAR NOT NULL PRIMARY KEY,  -- 19 位合并编码
    goods_name       VARCHAR,                        -- 货物和劳务名称（详细）
    goods_short_name VARCHAR,                        -- 商品和服务分类简称（归类用）
    description      VARCHAR,                        -- 说明
    -- 层级字段（从合并编码解析）
    level_pian       VARCHAR,   -- 篇（第1位）
    level_lei        VARCHAR,   -- 类
    level_zhang      VARCHAR,   -- 章
    level_jie        VARCHAR,   -- 节
    level_1          VARCHAR,   -- 条
    level_2          VARCHAR,   -- 款
    level_3          VARCHAR,   -- 项
    level_4          VARCHAR,   -- 目
    level_5          VARCHAR,   -- 子目
    level_6          VARCHAR,   -- 细目
    code_depth       INTEGER,   -- 编码深度（非零层级数，用于判断是否叶子节点）
    is_leaf          BOOLEAN,   -- 是否叶子节点（最细粒度编码）
    parent_code      VARCHAR,   -- 父级编码（方便上卷分析）
    updated_at       TIMESTAMP
);

-- 模糊匹配辅助索引
CREATE INDEX IF NOT EXISTS idx_dim_tax_short ON dim_tax_code (goods_short_name);
CREATE INDEX IF NOT EXISTS idx_dim_tax_parent ON dim_tax_code (parent_code);
```

**发票 goods_name 关联税收编码的策略（按优先级顺序）：**

```python
# cleaner.py 中的编码匹配逻辑
def match_tax_code(goods_name: str, tax_code_from_invoice: str, dim_codes: dict) -> str:
    """
    1. 优先用发票自带的税收分类编码（金税四期导出时包含此字段）
    2. 若无编码，用商品名称精确匹配 goods_name 字段
    3. 若精确匹配失败，用简称模糊匹配 goods_short_name
    4. 若仍失败，记录 '未匹配'，在质量标记中扣 5 分
    """
```

#### dim_ind_rule：行业分析规则配置表

来源：用户在 UI 中配置，不同行业的供应商集中度阈值、异常金额阈值不同。

```sql
CREATE TABLE IF NOT EXISTS dim_ind_rule (
    industry_id      VARCHAR NOT NULL PRIMARY KEY,  -- 行业门类 ID
    industry_name    VARCHAR,
    -- 覆盖 settings.py 中的全局阈值
    cr1_warn         DECIMAL(4,2) DEFAULT 0.30,
    cr1_high         DECIMAL(4,2) DEFAULT 0.50,
    cr3_warn         DECIMAL(4,2) DEFAULT 0.50,
    cr3_high         DECIMAL(4,2) DEFAULT 0.70,
    large_amount_threshold DECIMAL(18,2) DEFAULT 1000000,  -- 大额发票定义（元）
    weekend_amount_threshold DECIMAL(18,2) DEFAULT 100000,
    rule_note        VARCHAR,    -- 该行业特殊分析说明
    updated_at       TIMESTAMP
);
```

---

### 久其报表数据集成（一期架构预留，二期实现）

**定位：** 久其财务数据与发票数据的交叉校验是高价值审计场景，但 `.jio` 是久其软件的私有二进制格式，目前无公开解析库。一期在架构上保留完整位置（数据库表结构、接口定义、映射关系），不实现数据导入；二期根据确认的接入路径实现。

#### 架构预留：久其与发票数据的映射关系

```
发票数据（DWD层）              久其财务数据（预留层）         校验分析（DM层）
─────────────────────────────────────────────────────────────────────
进项发票 net_jshj  ←──────────  应付账款借方发生额              → 差异标记
进项税额 net_se    ←──────────  进项税额已认证/已抵扣金额       → 抵扣异常
销项发票 net_jshj  ←──────────  主营业务收入 / 其他业务收入     → 收入差异
费用类发票         ←──────────  管理费用 / 销售费用明细科目     → 费用超支
```

#### 预留表结构（建表但不写入数据）

> **命名说明**：本节久其占位表默认**不含 `group_id`**。若二期需要表达“财务数据归属/审计范围”，以 `db/schema_duckdb.py` 为准，可用 `scope_id` / `entity_id` 等替代字段名，避免与 DWD/DWS（不含 `group_id`）口径冲突。

```sql
-- 存 DuckDB（warehouse.duckdb），一期建表不写入
CREATE TABLE IF NOT EXISTS jiuqi_financial_stub (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id    TEXT,
    stat_year    INTEGER NOT NULL,
    stat_month   INTEGER,
    report_type  TEXT    COMMENT '报表类型：利润表/应付账款/费用明细等',
    account_code TEXT    COMMENT '科目编码',
    account_name TEXT    COMMENT '科目名称',
    amount       REAL,
    source_file  TEXT,
    load_time    TEXT,
    data_status  TEXT DEFAULT '预留未导入'
);
```

#### 二期接入路径（三选一，待确认）

| 路径 | 可行性 | 说明 |
|---|---|---|
| A：久其导出 Excel | 高，推荐优先 | 财务人员操作，无技术门槛，`.jio` 转 Excel 是标准功能 |
| B：请久其厂商提供 API | 中，需商务协调 | 需要联系久其获取接口文档，复杂度较高 |
| C：逆向解析 .jio 文件 | 低，不推荐 | 私有二进制格式，逆向工程不确定性极大 |

**二期推荐路径：先做路径 A（Excel 导入），验证校验逻辑有价值后，再评估是否做路径 B 的直连。**

---

| 触发动作 | 执行层次 | 存储引擎 | 说明 |
|---|---|---|---|
| 首次使用 / 维度更新 | DIM | DuckDB | 导入企业维度表、税收编码表、行业规则；全量替换，秒级完成 |
| 用户点击"导入发票" | ODS | Parquet | Excel → Parquet，目录 `批次/表类型/序号`，文件名 `{YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet`（全文见「ODS 文件名与目录规范」） |
| 导入完成后自动触发 | DWD | DuckDB | 清洗 + 质量评分，写入单表 `dwd_inv_*`（`stat_year` 区分年度，决策九） |
| DWD 写入后自动触发 | DWS | DuckDB | 增量刷新指定 `stat_year` 的汇总表（DWS **无 `group_id`**） |
| 用户点击"导入久其数据" | ODS / DuckDB | DuckDB | 久其 Excel → 预留表或 Parquet（**不**使用 SQLite 业务库） |
| 用户点击"运行分析" | DM | DuckDB | 读 DWD/DWS/DIM，写 DM |
| DM 写入后自动触发 | ADS | DuckDB | 评分卡 + 报告摘要写 ADS |

**关键约束：**
- **默认业务页**：优先消费 **DWS / DIM / DM / ADS**（面向审计人员的稳定口径）。
- **技术/排障入口**：在 UI 导航中增加“技术/排障入口”，默认仅对开发/管理员可见；业务用户默认不直接暴露 ODS/DWD 大查询能力。
- **允许**：开发/排障/下钻场景 **直接查询 ODS（Parquet 视图）与 DWD**；须遵守 **`stat_year` 等性能护栏**，避免无过滤全表扫描。
- 所有 DWD/DWS 查询必须携带 **`stat_year`**；**`group_id` 仅用于 DM**，不在 DWD/DWS 建列。
- 跨集团汇总优先走 **DWS**；需穿透明细时仍须带 **`stat_year` 过滤**。

---

## 三、数据输入规范

### 2.1 文件命名规则

下属企业导出的文件必须按以下规则命名，程序自动从文件名解析元数据：

```
格式：{公司简称}_{进项或销项}_{起始月YYYYMM}_{截止月YYYYMM}.xlsx
示例：华北分公司_进项_202401_202412.xlsx
      华南子公司_销项_202401_202412.xlsx
```

程序从文件名自动提取：
- `company_name`：公司简称（下划线前第一段）
- `invoice_dir`：发票方向（"进项" 或 "销项"）
- `period_start`：起始月（转为 datetime）
- `period_end`：截止月（转为 datetime）

若文件名不符合规范，仍尝试读取数据，但以上字段填充为 None，并在加载日志中给出警告。

### 2.2 金税系统标准字段与容错映射

金税三期和四期导出的列名略有差异，程序需自动识别以下标准字段：

| 标准字段名 | 可能的原始列名（任意匹配即可）|
|---|---|
| `invoice_code` | 发票代码、票据代码 |
| `invoice_no` | 发票号码、票号 |
| `kprq` | **ODS 开票日期标准列**（存原值字符串）；Excel 表头常见：开票日期、发票日期、开具日期、日期 |
| `buyer_name` | 购方名称、购买方名称、购买方、客户名称 |
| `buyer_tax_no` | 购方税号、购买方税号、购方纳税人识别号 |
| `seller_name` | 销方名称、销售方名称、销售方、供应商名称 |
| `seller_tax_no` | 销方税号、销售方税号、销方纳税人识别号 |
| `amount` | 金额、不含税金额、税前金额 |
| `tax_amount` | 税额、税款 |
| `total_amount` | 价税合计、含税金额、合计金额 |
| `tax_rate` | 税率 |
| `invoice_type` | 发票类型、票据类型 |
| `invoice_status` | 发票状态、票据状态 |
| `goods_name` | 商品名称、货物或应税劳务名称、品目名称 |

**分层口径（须与 `config/field_mapping.yaml`、实际 ETL 一致）：**

- **ODS Parquet**：开票日期列名统一为 **`kprq`**（字符串/原样；不做强类型 DATE 落盘）。
- **DWD**（如 `dwd_inv_header` / `dwd_inv_detail`）：**`kprq`** 保留原串；**`invoice_date`** 为 **`DATE`**，由 ODS→DWD 清洗阶段从 **`kprq`** 解析写入；**`stat_year` / `stat_month`** 由 `invoice_date` 派生。

---

## 四、模块详细说明

### 模块一：数据读取与归集（loader.py）

**入口函数：**
```python
def load_all_invoices(folder_path: str) -> tuple[pd.DataFrame, list[dict]]
```

**处理流程：**
1. 遍历指定文件夹中所有 `.xlsx` 和 `.xls` 文件
2. 对每个文件执行：
   - 从文件名解析元数据（company_name / invoice_dir / period_start / period_end）
   - 读取 Excel（兼容多 Sheet，取第一个有效 Sheet）
   - 执行字段映射（见 2.2）
   - 追加元数据列（source_file / company_name / invoice_dir / period_start / period_end）
3. 将所有文件合并为一个 DataFrame
4. 以 `invoice_code + invoice_no` 为唯一键去重，保留第一条，记录去重数量
5. 返回合并后的 DataFrame 和加载日志

**加载日志结构（list of dict，每个文件一条）：**
```python
{
    "file_name": "华北分公司_进项_202401_202412.xlsx",
    "status": "成功" | "失败" | "警告",
    "rows_loaded": 1523,
    "rows_deduped": 3,
    "unrecognized_columns": ["备注", "经办人"],
    "error_message": None | "文件损坏，无法读取"
}
```

**错误处理：**
- 文件无法读取（格式损坏 / 密码保护）：跳过，日志记录原因，不中断整体流程
- 文件名不符合命名规范：仍读取数据，元数据字段置 None，日志给出警告
- 必要字段缺失（invoice_code / invoice_no / amount 三选二缺失）：该文件标记失败，跳过

---

### 模块二：数据清洗与标准化（cleaner.py）

**入口函数：**
```python
def clean_invoices(df: pd.DataFrame) -> pd.DataFrame
```

**清洗规则（按字段）：**

**税号字段（buyer_tax_no / seller_tax_no）：**
- 去除首尾空格
- 统一转大写
- 长度校验：中国统一社会信用代码为 18 位，不足或超出的在 `tax_no_valid` 字段中标记 False

**金额字段（amount / tax_amount / total_amount）：**
- 去除人民币符号（¥、￥）
- 去除千位分隔符（,）
- 转为 float64
- 负数发票（红冲）保留负号，不做绝对值处理

**开票日期（ODS：`kprq` → DWD：`invoice_date`）：**
- **ODS**：列名 **`kprq`**，保留 Excel 读出原值（字符串优先）；与全文「ODS 仅原始字符串」策略一致。
- **DWD 清洗**：将 **`kprq`** 解析为 **`invoice_date`（DATE）**；兼容格式示例：`2024-01-15`、`2024/01/15`、`20240115`、`2024年01月15日`（以 DuckDB/实现为准）。
- **缺失或无法解析**：拒收或记清洗日志（与当前 `cleaner.py` 拒收形状对齐）；DWD 不写无效 `invoice_date`。

**发票状态字段（invoice_status）：**
统一映射为三个标准值：
- `"正常"` ← 正常、有效、认证、已认证
- `"作废"` ← 作废、已作废
- `"红冲"` ← 红冲、红字、冲红、负数发票
- 无法识别的填充 `"未知"`

**税率字段（tax_rate）：**
- 统一转为 float（`"13%"` → `0.13`，`"免税"` → `0.0`，`"零税率"` → `0.0`）

**品目名称（goods_name）：**
- 去除首尾空格
- 保留原始值，同时新增 `goods_category` 字段，按以下关键词做粗粒度归类：

| goods_category | 关键词（包含即归入）|
|---|---|
| 建筑服务 | 建筑、安装、施工、装修、改造 |
| 信息技术 | 信息、软件、系统、数据、网络、IT |
| 咨询服务 | 咨询、顾问、策划、培训 |
| 货物采购 | 设备、材料、耗材、物资、配件 |
| 餐饮住宿 | 餐饮、住宿、酒店、会议 |
| 运输服务 | 运输、物流、快递、货运 |
| 租赁服务 | 租赁、租金、场地 |
| 金融服务 | 金融、保险、担保、利息 |
| 其他服务 | （以上均不匹配时）|

---

### 模块三：基础看板分析（analyzer/overview.py）

**提供以下分析函数，每个函数返回 dict（含数据 + 图表对象）：**

**3.1 核心数字摘要**
```python
def get_summary_stats(df) -> dict:
    # 返回：
    # total_invoices：总发票张数（正常 + 红冲 + 作废分开统计）
    # total_amount：总金额（仅正常发票，不含税）
    # total_tax：总税额
    # total_suppliers：涉及供应商数量（按 seller_tax_no 去重）
    # total_buyers：涉及客户数量（按 buyer_tax_no 去重）
    # total_companies：涉及子公司数量
    # cancelled_ratio：作废率（作废张数 / 总张数）
    # red_ratio：红冲率（红冲张数 / 总张数）
```

**3.2 月度开票趋势**
- 按月统计进项 / 销项金额，输出折线图（Plotly）
- 标注同比变化（如数据跨年）
- 自动标注异常波动月份（当月金额超过均值 ± 2 倍标准差）

**3.3 税率分布**
- 按税率档次（13% / 9% / 6% / 3% / 免税 / 其他）统计金额占比
- 输出饼图 + 明细表格

**3.4 发票类型分布**
- 专票 vs 普票 vs 电子票 占比
- 各子公司发票类型对比（堆叠柱状图）

**3.5 品类支出分布**
- 按 goods_category 统计采购金额 Top 10
- 输出水平条形图

---

### 模块四：供应商集中度分析（analyzer/supplier.py）

**4.1 CR 值计算**
```python
def calc_concentration_ratio(df, top_n_list=[1, 3, 5, 10]) -> dict:
    # 按 seller_tax_no 汇总采购金额（仅进项、正常状态）
    # 计算 CR1 / CR3 / CR5 / CR10
    # 风险判断：
    #   CR1 >= 0.3 → 预警；>= 0.5 → 高风险
    #   CR3 >= 0.5 → 预警；>= 0.7 → 高风险
    #   CR10 >= 0.8 → 高风险
```

**4.2 Top 供应商明细表**
- 按采购金额降序排列前 20 名
- 列：排名 / 供应商名称 / 税号 / 采购金额 / 占比 / 开票张数 / 涉及子公司数量 / 是否新增供应商

**4.3 新增供应商检测**
```python
def detect_new_suppliers(df, base_period, current_period) -> pd.DataFrame:
    # 当期新增（在 base_period 中未出现的 seller_tax_no）
    # 重点标记：新增供应商中采购金额进入 Top 10 的
```

**4.4 跨子公司共同供应商**
- 找出同时向多家子公司开票的供应商
- 分析是否存在集团统一采购未执行到位的情况

**4.5 辅助规则**

| 规则 | 判断条件 | 风险等级 |
|---|---|---|
| 供应商品类跨度异常 | 同一供应商同期开具 3 种以上不同 goods_category 的发票 | 中 |
| 年末突击采购 | 单一供应商 11-12 月采购金额占全年 > 50% | 中 |
| 价格一致性 | 同一品类同期不同供应商单价差异 > 20% | 中 |

**阈值配置：**
所有阈值从 `config/settings.py` 读取，支持在 UI 界面实时修改。
提供"行业基准模板"下拉选择（电力 / 建筑 / 制造业 / 通用），选择后自动填入推荐阈值。

---

### 模块五：审计疑点自动标记（analyzer/anomaly.py）

**统一疑点数据结构：**
```python
{
    "flag_id": "FP-2024-001",          # 疑点编号（自动生成）
    "risk_level": "高风险" | "中风险" | "低风险",
    "flag_type": "重复开票",            # 疑点类型
    "company_name": "华北分公司",       # 涉及子公司
    "seller_name": "XX供应商",          # 涉及供应商
    "amount": 235000.0,                # 涉及金额
    "invoice_list": ["12345678", ...], # 相关发票号码
    "description": "该供应商在...",     # 异常描述（中文，可直接放入报告）
    "suggestion": "建议调取合同原件...", # 延伸审计建议
    "rule_id": "RULE-01"               # 触发规则编号
}
```

**实现以下 10 条规则（每条规则独立函数，统一返回 list[dict]）：**

**规则01：重复开票检测**
- 触发条件：同一 buyer_tax_no + seller_tax_no + amount，30 天内出现 2 次及以上（仅正常状态）
- 延伸：同购销方同月多张发票，单张均低于 N 万但合计超过 N 万（化整为零，N 从配置读取，默认 50 万）
- 风险等级：高风险

**规则02：异常开票日期**
分五种子类型，每种单独标记：
- 节假日开票（使用 `chinese_calendar` 库判断中国法定节假日）
- 大额周末开票（金额 > 10 万且为周六 / 周日）
- 年末突击开票（11-12 月开票金额占全年 > 50%，按供应商维度统计）
- 跨期开票（开票日期早于合同签订日期，若有合同日期字段）
- 未来日期（开票日期晚于数据导出日期）

**规则03：红冲发票异常**
- 红冲后再开：原票红冲后 30 天内同购销方再次开具相同金额发票 → 高风险
- 跨年红冲：红冲发票与原始发票不在同一自然年 → 中风险
- 红冲比例异常：单一供应商红冲金额 / 开票金额 > 20% → 中风险
- 无对应原票：红冲发票找不到对应原始发票编号 → 高风险

**规则04：发票状态异常**
- 全局作废率 > 5% → 预警；> 10% → 高风险
- 作废发票集中在特定供应商（某供应商作废率 > 30%）→ 单独标记

**规则05：税率与品类不匹配**
预置对照表：

| 品目关键词 | 正常税率 |
|---|---|
| 建筑服务、安装 | 9% |
| 餐饮、住宿 | 6% |
| 货物销售、设备 | 13% |
| 金融、保险 | 6% |
| 咨询、顾问 | 6% |

同一供应商同一品类在不同月份使用不同税率 → 中风险

**规则06：金额异常值检测（3σ 法则）**
- 按供应商分组，单张发票金额超过该供应商历史均值 ± 3 个标准差 → 中风险
- 需至少有 5 张历史发票才参与统计，否则跳过

**规则07：开票频率突变**
- 某供应商某月开票张数 > 该供应商月均 3 倍 → 中风险

**规则08：价格一致性核查**
- 同一 goods_category、同一季度，不同供应商单价（amount / 数量，若有数量字段）离散度 > 20% → 列出高价采购供应商，标记低风险

**规则09：关联交易——对开发票**
- 购销双方税号互为买卖方（A 向 B 开票，B 同时向 A 开票）
- 双向金额比值（min/max）>= 0.8 → 高风险；0.5-0.8 → 中风险

**规则10：关联交易——集团内部未申报**
- 购销双方均在集团成员税号列表中（用户在 UI 中配置）
- 找出内部互开但未在集团内部交易台账中登记的发票 → 中风险

**规则配置（UI 中提供）：**
- 每条规则可单独开关（Toggle）
- 每条规则的阈值可修改（数字输入框）
- 修改后实时重新计算，无需重新导入数据

---

### 模块六：关联交易识别（analyzer/related_party.py）

使用 NetworkX 构建有向图，节点为税号，边为开票关系，边权重为金额。

**6.1 构建税号关系图**
```python
def build_tax_network(df) -> nx.DiGraph:
    # 遍历所有发票，以 buyer_tax_no → seller_tax_no 为有向边
    # 边属性：amount（累加金额）、count（发票张数）
```

**6.2 对开发票检测（场景一）**
```python
def detect_circular_invoice(G, threshold=0.8) -> pd.DataFrame:
    # 找出所有双向边对（A→B 且 B→A）
    # 计算 ratio = min(amount_AB, amount_BA) / max(amount_AB, amount_BA)
    # ratio >= threshold → 高风险
```

**6.3 集团内部交易检测（场景二）**
```python
def detect_internal_transactions(df, group_tax_list) -> pd.DataFrame:
    # group_tax_list 从 UI 中配置（可上传集团成员税号列表 Excel）
    # 找出购销双方均在列表中的发票
    # 汇总：按购销对汇总金额、张数
```

**6.4 穿透两层检测壳公司（场景三）**
```python
def detect_shell_intermediary(G, group_tax_list, min_amount=500000, passthrough_ratio=0.6) -> pd.DataFrame:
    # 对集团成员的每个直接供应商（非集团成员）
    # 计算该供应商的"穿透比例"：其对外付款金额 / 其收款金额
    # 穿透比例 >= 0.6 且收款金额 >= min_amount → 标记为疑似通道公司
```

**6.5 可视化关联图谱**
- 使用 Plotly 绘制交互式网络图
- 节点大小 = 交易金额
- 边颜色 = 风险等级（红/黄/灰）
- 支持点击节点查看详情
- 集团成员节点用紫色标注，疑似关联方用红色标注

---

### 模块七：子公司横向对比（ui/pages/06_子公司对比.py）

**7.1 各子公司核心指标对比表**

| 列名 | 说明 |
|---|---|
| 子公司名称 | company_name |
| 发票总金额 | 正常进项金额合计 |
| 发票总张数 | |
| 涉及供应商数 | |
| 疑点总数 | 该公司被标记的疑点条数 |
| 高风险疑点数 | |
| 风险得分 | 见下方计算规则 |
| 综合评级 | 根据风险得分给出：正常 / 关注 / 重点关注 |

**风险得分计算：**
```
基础分 = 100
- 每条高风险疑点扣 8 分
- 每条中风险疑点扣 3 分
- 每条低风险疑点扣 1 分
- 作废率 > 10% 额外扣 5 分
- CR1 > 50% 额外扣 5 分
最低 0 分
```

**综合评级：**
- 80-100 分：✅ 正常
- 60-79 分：⚠️ 关注
- 0-59 分：🔴 重点关注

**7.2 子公司对比图表**
- 各子公司发票金额对比（水平条形图）
- 各子公司风险得分雷达图
- 各子公司疑点类型分布（堆叠柱状图，按高/中/低风险分色）

---

### 模块八：报告生成（reporter.py）

**生成一份完整的 Word 报告（.docx），结构如下：**

#### 封面页
- 报告标题：《XX集团发票数据审计分析报告》
- 分析周期（自动从数据中提取）
- 数据来源说明（X 家子公司，共 X 张发票）
- 生成日期（自动填充当天日期）
- 保密等级：内部资料

#### 第一章：数据概览
核心数字摘要表（8 项指标，见模块三 3.1）

#### 第二章：发票结构分析
- 月度开票趋势（插入 Plotly 导出的图片）
- 税率分布
- 发票类型分布
- 品类支出分布

#### 第三章：供应商分析
- CR 值汇总及风险判断
- Top 20 供应商明细表
- 新增供应商列表

#### 第四章：审计疑点清单（核心章节）
每条疑点按统一格式呈现：
```
【疑点编号】FP-2024-001
【风险等级】高风险
【疑点类型】重复开票
【涉及主体】华北分公司 ← XX供应商（税号：91110000XXXX）
【涉及金额】23.5 万元
【涉及发票】（发票号码列表）
【异常描述】……
【建议核查】……
```

章节末尾附疑点汇总表（序号 / 风险等级 / 疑点类型 / 涉及企业 / 涉及金额 / 建议优先级）

#### 第五章：关联交易分析
- 对开发票清单
- 集团内部交易汇总
- 疑似通道公司列表（场景三）

#### 第六章：各子公司横向对比
子公司综合评级表（见模块七 7.1）

#### 附录
- 附录 A：数据文件加载日志
- 附录 B：疑点判断规则说明（每条规则的逻辑和阈值）
- 附录 C：名词解释

**报告生成函数：**
```python
def generate_report(
    df: pd.DataFrame,
    flags: list[dict],
    output_path: str,
    report_title: str = "发票数据审计分析报告"
) -> str:
    # 返回生成的文件路径
```

---

## 五、UI 界面说明

使用 Streamlit 多页面结构（`pages/` 目录），左侧导航栏按流程顺序排列：

### 页面 01：数据导入
- 文件夹路径输入框（或拖拽上传多个文件）
- 点击"开始导入"按钮
- 实时显示加载进度条（每个文件处理完显示一行）
- 加载完成后显示日志表格（状态 / 文件名 / 行数 / 警告信息）
- 右上角显示"已成功导入 X 家子公司，共 X 张发票"
- 数据存入 `st.session_state`，供后续页面使用

### 页面 02：数据概览
- 顶部 4 个核心指标卡片（总金额 / 总张数 / 供应商数 / 疑点数）
- 月度趋势折线图
- 税率分布饼图
- 品类分布条形图

### 页面 03：供应商分析
- 顶部 CR 值卡片（CR1 / CR3 / CR10，配色根据风险等级自动变化）
- 行业基准模板下拉（选择后自动更新阈值）
- Top 20 供应商表格（支持排序 / 过滤）
- 供应商集中度帕累托图（双轴：金额柱 + 累计占比线）

### 页面 04：审计疑点
- 左侧规则配置面板（每条规则的开关 + 阈值输入）
- "重新运行分析"按钮
- 右侧疑点列表（按风险等级分 Tab：全部 / 高风险 / 中风险 / 低风险）
- 每条疑点展开后显示完整描述和建议核查动作
- 支持按子公司 / 供应商 / 疑点类型多维过滤

### 页面 05：关联交易
- 关联交易网络图（Plotly 交互式）
- 对开发票明细表
- 集团内部交易汇总
- 集团成员税号配置区（支持上传 Excel 或手动输入）

### 页面 06：子公司对比
- 综合评级排名表（支持点击某一子公司跳转查看该公司的疑点详情）
- 各子公司风险得分对比图
- 疑点类型分布堆叠柱状图

### 页面 07：生成报告
- 报告标题输入框（默认值可修改）
- 报告章节选择（勾选/取消某些章节）
- 输出格式选择（Word / PDF / 两者都要）
- 点击"生成报告"按钮，显示进度，完成后提供下载链接

---

## 六、全局配置（config/settings.py）

以下所有配置均在此文件集中管理，UI 中修改后同步写入此文件：

```python
# ── 实例范围配置（安装初始化时写入，决定本实例的数据可见范围）─────
SCOPE = {
    "scope_root_id":  "ROOT_PROV_SD",  # 本实例组织树的起点 entity_id
    # 这不是权限控制，而是"这个安装实例的树从哪里开始"
    # 审计厅安装：ROOT_PROV_SD（全省虚拟根节点）
    # 集团A安装：集团A的 entity_id（集团A就是根节点，不录入上级数据）
    # 子公司B安装：子公司B的 entity_id（B就是根节点，完全独立）
    # 各实例数据库互相隔离，互不影响

    "scope_level":    "PROV",          # PROV / GROUP / ENTITY（仅用于 UI 标题显示）
    "scope_sys_id":   "PROV_SD",       # 所属企业系统
    "instance_name":  "山东省属企业发票审计平台",  # UI 标题显示名
}

# ── 授权配置（从 .lic 文件加载后写入，不可手工修改）──────────────
LICENSE = {
    "tier":           "trial",         # trial / standard / professional
    "customer":       "试用用户",
    "expires_at":     "2025-12-31",
    "max_entities":   3,               # -1 = 不限
    "max_invoices":   50000,           # -1 = 不限
    "max_years":      1,               # -1 = 不限
    "export_report":  False,           # 是否允许导出正式报告
    "cross_group":    False,           # 是否支持跨集团横向对比
    # 注意：此块由 config/license.py 的 load_license() 函数填充，禁止手工修改
}

# ── 审计规则阈值（UI 中可调整）──────────────────────────────────
SETTINGS = {
    # 供应商集中度
    "cr1_warn": 0.30,  "cr1_high": 0.50,
    "cr3_warn": 0.50,  "cr3_high": 0.70,
    "cr10_high": 0.80,

    # 重复开票
    "duplicate_days_window": 30,
    "split_invoice_threshold": 500000,

    # 红冲 / 作废
    "red_invoice_ratio_warn": 0.20,
    "cancel_ratio_warn": 0.05,  "cancel_ratio_high": 0.10,

    # 金额异常值（3σ）
    "amount_zscore_threshold": 3.0,
    "amount_outlier_min_history": 5,

    # 频率 / 价格
    "freq_spike_multiplier": 3.0,
    "price_dispersion_warn": 0.20,

    # 关联交易
    "circular_ratio_high": 0.80,  "circular_ratio_warn": 0.50,
    "shell_passthrough_ratio": 0.60,
    "shell_min_amount": 500000,

    # 日期异常
    "yearend_ratio_warn": 0.50,
    "weekend_large_amount": 100000,

    # 规则开关
    "rule_switches": {
        "RULE-01": True,  "RULE-02": True,  "RULE-03": True,
        "RULE-04": True,  "RULE-05": True,  "RULE-06": True,
        "RULE-07": True,  "RULE-08": True,  "RULE-09": True,
        "RULE-10": True,
    }
}
```

---

## 六点五、授权模块（config/license.py）

InvoiceLens 采用 **`.lic` 文件 + 功能分层** 的离线授权模式：你用 RSA 私钥生成 `.lic` 文件发给客户，工具启动时用内置公钥验证签名，无需联网。

### 授权等级

| 等级 | 目标用户 | 主要限制 |
|---|---|---|
| `trial` 试用版 | 任何人，30天 | 3户企业，5万张发票，1个年度，不可导出报告 |
| `standard` 标准版 | 集团审计部 | 500户企业，500万张发票，3个年度，支持导出 |
| `professional` 专业版 | 审计厅/省国资委 | 无限制，支持省级全局视角，跨集团对比 |

### 核心实现

```python
# config/license.py
import json, base64, rsa
from datetime import datetime
from pathlib import Path

# 工具内置公钥（你持有对应私钥，永不分发）
PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
（此处填入你生成的 RSA 公钥内容）
-----END PUBLIC KEY-----"""

TIER_DEFAULTS = {
    "trial":        {"max_entities": 3,    "max_invoices": 50000,    "max_years": 1,  "export_report": False, "cross_group": False, "scope_level": "GROUP"},
    "standard":     {"max_entities": 500,  "max_invoices": 5000000,  "max_years": 3,  "export_report": True,  "cross_group": False, "scope_level": "GROUP"},
    "professional": {"max_entities": -1,   "max_invoices": -1,       "max_years": -1, "export_report": True,  "cross_group": True,  "scope_level": "PROV"},
}

def load_license(lic_path: str = "license.lic") -> dict:
    """
    启动时调用，返回授权信息 dict。
    若 .lic 文件不存在，自动生效 30 天试用版。
    若签名验证失败，报错并退出。
    """
    if not Path(lic_path).exists():
        # 无 .lic 文件：自动生效试用版
        return {**TIER_DEFAULTS["trial"],
                "tier": "trial", "customer": "试用用户",
                "expires_at": (datetime.now().isoformat()[:10])}

    lic = json.load(open(lic_path, encoding="utf-8"))
    payload_bytes = base64.b64decode(lic["payload"])
    signature     = base64.b64decode(lic["signature"])

    pub_key = rsa.PublicKey.load_pkcs1_openssl_pem(PUBLIC_KEY_PEM)
    rsa.verify(payload_bytes, signature, pub_key)  # 验证失败抛 rsa.VerificationError

    payload = json.loads(payload_bytes)

    # 检查到期
    if datetime.now().isoformat()[:10] > payload["expires_at"]:
        raise ValueError(f"授权已于 {payload['expires_at']} 到期，请联系 InvoiceLens 续期")

    return payload

def check_limit(license: dict, key: str, current_value: int) -> bool:
    """
    检查是否超出授权限制。
    -1 表示不限制。
    超出时返回 False，调用方决定是否弹窗提示。
    """
    limit = license.get(key, -1)
    if limit == -1:
        return True
    return current_value <= limit
```

### .lic 文件生成脚本（你在本地运行，不打包进工具）

```python
# 仅在你的本地环境运行，生成授权文件后发给客户
def generate_license_file(
    customer: str,
    tier: str,               # trial / standard / professional
    expiry_days: int,
    output_path: str = "license.lic"
):
    payload = {
        "customer":    customer,
        "tier":        tier,
        "issued_at":   datetime.now().isoformat()[:10],
        "expires_at":  (datetime.now() + timedelta(days=expiry_days)).isoformat()[:10],
        **TIER_DEFAULTS[tier],
    }
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode()
    priv_key = rsa.PrivateKey.load_pkcs1(open("private.pem", "rb").read())
    signature = rsa.sign(payload_bytes, priv_key, "SHA-256")

    lic = {"payload": base64.b64encode(payload_bytes).decode(),
           "signature": base64.b64encode(signature).decode()}
    json.dump(lic, open(output_path, "w"), indent=2)
    print(f"已生成 {output_path}，授权给：{customer}，等级：{tier}，到期：{payload['expires_at']}")
```

### 功能门控调用方式

```python
# 在任意分析模块中检查授权
from config.license import check_limit
from config.settings import LICENSE

# 导入时检查企业数量上限
if not check_limit(LICENSE, "max_entities", current_entity_count):
    st.error(f"当前版本最多支持 {LICENSE['max_entities']} 家企业，"
             f"如需扩容请联系 InvoiceLens 升级授权。")
    st.stop()

# 生成报告时检查权限
if not LICENSE.get("export_report", False):
    st.warning("试用版不支持导出正式报告，请升级至标准版或专业版。")
    st.stop()
```

---



### entity_fullname 冗余策略（贯穿全数据层级）

`entity_fullname`（企业全称）是审计场景中出现频率最高的描述性字段，从 DWD 到 ADS 的每一层都需要它。冗余策略统一如下，所有 ETL 模块严格遵守：

**来源：** `dim_org_node.entity_fullname` 是权威数据源，唯一可修改此字段的地方。

**冗余范围和更新时机：**

| 层级 | 冗余位置 | 字段名 | 更新时机 |
|---|---|---|---|
| DIM | `dim_org_hier` | `entity_fullname`、`mg_parent_fullname`、`eq_parent_fullname` | 每次 `dim_loader.py` 导入或更新维度时同步 |
| DWD | `dwd_inv_map` | `entity_name`（发票视角的企业全称） | 每次写入映射表时从 `dim_org_node` 查询填入 |
| DWS | `dws_trade_sum` | `entity_name`、`counterparty_name` | 聚合时从 DWD 或 DIM 层带入，不单独回查 |
| DM | `dm_audit_flag` | `company_name`、`seller_name` | 分析模块写入时直接带入，不事后回填 |
| ADS | `ads_scorecard` | `entity_name` | DM 刷新后同步 |

**冗余一致性维护规则：**
- `dim_org_node` 中企业全称发生变更时，`dim_loader.py` 的更新流程必须同时刷新 `dim_org_hier` 中的所有冗余名称字段
- DWD 及以上层级的历史数据**不做反向更新**——发票记录的 `entity_name` 应保留写入时的名称，体现历史时态准确性（例如企业更名后，更名前的发票仍记录旧名称）
- 唯一例外：`dwd_inv_map` 中 `entity_name` 若写入时为空（entity_id 未能匹配 DIM 层），允许在后续维度数据补全后做一次回填

### DuckDB 使用规范
- 连接管理：使用单例模式（`db/duckdb_conn.py`），全局共享一个 `duckdb.Connection` 对象
- 性能参数：启动时设置 `SET threads TO 8`、`SET memory_limit = '8GB'`、`SET temp_directory = 'data/tmp'`（内存不足时自动溢写磁盘，不崩溃）
- 所有分析查询必须携带 **`stat_year = ?`**（必要时 `stat_month`）；**DWD/DWS/`dwd_inv_map` 均无 `group_id`**；「按集团」在 **DM** 用 `group_id`，或在明细查询中 **`JOIN dim_org_*` / 税号条件**
- DWD 物理去重以 **`(stat_year, invoice_key)`**（或等价唯一约束）为准，以 `schema_duckdb.py` 为准；写入策略用 `INSERT` + 去重/冲突处理，而非虚构的 `INSERT OR IGNORE` 除非与表定义一致
- DWS 刷新使用 **仅带 `stat_year`（及必要业务键）过滤的 DELETE+INSERT 或等价原子策略**，避免无过滤全表写入
- 关联交易自连接（3 亿行）耗时 60–300 秒，必须在后台线程执行，UI 显示进度条，避免 Streamlit 超时

### SQLite【遗留】（本阶段不实现）

> 初稿曾设想 SQLite 承载部分应用表；**当前决议为 DuckDB 单库**，DM/ADS 亦在 `warehouse.duckdb`。**以下条目不予实现**，仅避免后人误读旧图：

- ~~连接管理：`sqlite_conn.py`~~
- ~~DM 按 `group_id + analysis_batch` 在 SQLite 中覆盖~~ → **实际在 DuckDB 的 DM 表上**用 `group_id + analysis_batch` 表达同样语义
- ~~`VACUUM`~~ → 不适用

### 性能
- 单次分析发票量可能达到 10 万张以上，所有 Pandas 操作必须向量化，禁止对 DataFrame 使用 Python 级别的 `for` 循环逐行处理
- 关联交易的图计算（NetworkX）在大规模数据下耗时较长，考虑在后台线程中执行，UI 显示进度条
- Plotly 图表超过 5 万数据点时启用数据采样或聚合，防止浏览器卡顿

### 数据安全
- 所有数据处理均在本地完成，不发起任何网络请求（除 Streamlit 本身的本地 localhost 外）
- 不写入任何日志文件到用户系统路径之外的位置
- 报告生成默认输出到工具所在目录的 `output/` 子目录

### 兼容性
- Windows 10 / 11 x64（主要用户环境）
- 打包为单文件 .exe 时需在 PyInstaller spec 中正确包含 `chinese_calendar` 数据文件
- Streamlit 使用 `subprocess` 启动时设置 `--server.headless true` 和 `--server.port 8501`

### 代码规范
- 所有函数加中文注释，关键判断逻辑注明原因
- 每个模块包含独立的 `if __name__ == "__main__"` 测试入口
- 异常处理：业务逻辑异常（如数据格式问题）用中文给出友好提示，不暴露 Python 错误堆栈给用户

### 中文支持
- Matplotlib 图表（若用到）设置 `plt.rcParams['font.sans-serif'] = ['SimHei']` 防止中文乱码
- Plotly 图表中文无需额外配置
- Word 报告使用仿宋 / 宋体，中文环境均支持

---

## 八、分阶段交付建议

### Vibe Coding 投喂策略（开始编码前必读）

本提示词全文约 9 万字，不要一次性全部投喂给 AI。采用"洋葱圈"三层渐进式投喂：

第一层（核心层，每次对话必贴，约 2000 字）
  = 第一章（项目总体描述）+ 第十章（关键设计决策备忘 12 条硬约束）
  决定"做什么、不做什么"，是 AI 的认知锚点

第二层（任务层，阶段开始时投喂，约 1500 字）
  = 第八章中当前阶段的规范
  决定"本次任务的输入输出和验收标准"

第三层（纠错层，AI 偏离时动态引用）
  = 具体的决策条目或 DDL 片段
  例如："请注意决策三：孤立红票 net_jshj 必须保留负值，不能置零"

执行纪律：
- 上一阶段的 pytest 回归测试全部通过并 git commit 后，再开新对话
- 每次 AI 修改代码后必须重跑测试，确认没有悄悄破坏已有约束
- AI 违反"关键设计决策备忘"中某条时，立即引用原文纠正，不让错误累积

各阶段任务层需要重点提示的决策：
- 阶段一（建表）：决策一（DuckDB）、决策九（单表）、决策十（ODS目录）
- 阶段二（DIM）：决策四（三表结构）、决策六（entity_fullname冗余）
- 阶段三（DWD）：决策二（entity_id匹配）、决策三（净额宽口径）、决策十一（并行）
- 阶段四（DWS）：决策九（单表聚合）、决策六（名称冗余）
- 阶段五（DM）：决策十二（图计算降级）
- 阶段六（收尾）：决策八（多级使用模式）、授权模块

关于约束的设计哲学（重要）：
本提示词中的具体约束不是"过度工程化"，而是业务要求的精确表达。
DECIMAL(18,2) 是审计场景的业务要求，精度差 1 分是实质性问题；
logic_line_no > 0 是防止汇总行导致金额重复计算的核心逻辑；
Hive 分区命名格式是 DuckDB hive_partitioning=true 自动识别的前提。
在已经想清楚的约束上，精确描述比留白更安全。AI 的涌现能力留给边界情况处理。

---

按"每个阶段结束后有可独立验证的交付物"划分，共六个阶段。每阶段开始前，将本提示词连同阶段专项说明一起喂给 AI，明确当前阶段边界。

---

### 阶段一：项目初始化 + 数据库建表

**目标：** 搭建项目骨架，建立完整的数据库表结构。

**交付文件：**
```
D:\PythonCode\InvoiceLens\
├── requirements.txt          # 依赖清单（duckdb/pandas/streamlit 等）
├── init_db.py                # 一键建表入口
├── verify_db.py              # 结构验证脚本
└── db\
    ├── duckdb_conn.py        # DuckDB 连接单例管理
    └── schema_duckdb.py      # 全量建表 DDL + 动态年度表管理
```

**建表策略（单表版，决策九）：**

```python
# schema_duckdb.py 核心设计
# DWD / DWS 层均为单表 + stat_year 列，无年度分表，无动态建表函数
# PRESET_YEARS / ensure_year_tables / rebuild_union_views 已废弃删除

def init_all_tables(conn) -> dict:
    """
    执行全量建表 DDL。
    新年度数据直接写入单表，stat_year 列自动区分年度。
    无需任何动态建表操作。
    """
```

**建表范围：**

| 层 | 表数量 | 说明 |
|---|---|---|
| DIM | 6 张 | dim_org_sys / dim_org_node / dim_org_hier / dim_org_hier_log / dim_tax_code / dim_ind_rule |
| DWD | 3 张（含 stat_year 列） | dwd_inv_header / dwd_inv_detail / dwd_inv_map（单表，决策九） |
| DWS | 5 张（含 stat_year 列） | dws_trade_sum / dws_inv_trend / dws_sup_conc / dws_goods_cat / dws_quality（单表，决策九） |
| DM | 3 张 | dm_audit_flag / dm_circ_inv / dm_shell_co |
| ADS | 4 张 | ads_scorecard / ads_group / ads_org_member / ads_import_log |
| 合计 | 21 张，无年度视图 | 新年度数据直接写入单表，WHERE stat_year 过滤，DuckDB 列存储自动剪枝 |

**预置数据（init_db.py 自动写入）：**
- `dim_org_sys`：PROV_SD（山东省属企业）
- `dim_org_node`：ROOT_PROV_SD（省国资委虚拟根节点，`is_stat_inc=FALSE`）

**验证方式：**
```
python init_db.py    # 建表，输出建表统计
python verify_db.py  # 验证：逐表检查 + 预置数据 + 动态建表幂等性测试
```
看到"全部验证通过"即完成。

---

### 阶段二：DIM 层维度数据导入

**目标：** 导入组织维度（双树层级）和税收分类编码，为后续发票数据提供企业识别和品类映射支撑。

**交付文件：**
```
├── modules\
│   └── dim_loader.py              # 维度数据导入/导出/验证
├── templates\
│   └── org_dim_template.xlsx      # 组织维度导入模板（程序生成，供用户下载填写）
├── config\
│   ├── settings.py                # SCOPE + LICENSE + 规则阈值
│   └── field_mapping.py           # 金税导出字段映射表
└── ui\pages\
    └── 02_维度管理.py              # 组织树展示 + 维护 + 导出
```

---

#### Excel 导入模板规范（单 sheet，命名"组织维度"）

**模板结构：**
- 第 1 行：列名（英文，程序解析用）
- 第 2 行：中文说明（字体灰色，提示用，导入时程序跳过）
- 第 3 行起：数据行

**18 列定义（按填写顺序排列）：**

```
A 组：基础标识（4列）
  entity_id            统一社会信用代码   【必填】18位。根节点填 ROOT_{sys_id}
  entity_fullname      企业全称           【必填】权威全称，与工商登记一致
  entity_shortname     企业简称           【选填】UI树节点和路径展示用；无简称时路径自动用全称
  entity_type          企业组织形态       【待议】枚举值定义暂缓确认，当前允许自由填写

B 组：企业属性（6列）
  sys_id               企业系统           【必填】与 dim_org_sys 中的 sys_id 一致，如 PROV_SD
  stat_year            统计年度           【必填】4位年份；同一文件只允许一个年度
  main_business        主责主业           【选填】业务范围简述
  industry_id          行业门类代码       【选填】单字母，国民经济行业门类代码
  industry_name        行业门类名称       【选填】与 industry_id 对应
  is_stat_inc          是否纳入统计       【必填】填"是"或"否"；根节点填"否"

C 组：管理树（2列，人工填写，路径/层级程序自动计算）
  mg_parent_id         上级管理单位代码   【必填】填上级的 entity_id；根节点填自己的 entity_id
  mg_sort_no           管理排序号         【必填】同一管理上级下的显示顺序，从1起，同级不重复

D 组：产权树（3列，人工填写，路径/层级程序自动计算）
  eq_parent_id         上级产权单位代码   【必填】填上级的 entity_id；根节点填自己的 entity_id
  eq_sort_no           产权排序号         【必填】同一产权上级下的显示顺序，从1起
  eq_shareholding_ratio 直接持股比例      【选填】0.0001~1.0000；留空表示100%全资

E 组：补充（3列）
  reg_capital          注册资本（万元）   【选填】数字，单位万元
  is_active            是否在营           【必填】填"是"或"否"；注销填"否"
  hier_diff_note       管产差异说明       【条件必填】mg_parent_id≠eq_parent_id时建议填写原因
```

**模板填写示例（3行数据）：**

```
entity_id          | entity_fullname        | entity_shortname | entity_type | sys_id  | stat_year | mg_parent_id      | mg_sort_no | eq_parent_id      | eq_sort_no | ...
ROOT_PROV_SD       | 山东省国有资产监督管理委员会 | 省国资委     | 根节点      | PROV_SD | 2024      | ROOT_PROV_SD      | 0          | ROOT_PROV_SD      | 0          | ...
913700001630477270 | 浪潮集团有限公司        | 浪潮集团         | 一级集团    | PROV_SD | 2024      | ROOT_PROV_SD      | 1          | ROOT_PROV_SD      | 1          | ...
913700140000xxxxx  | 浪潮信息技术股份有限公司 | 浪潮信息         | 二级及以下  | PROV_SD | 2024      | 913700001630477270 | 1         | 913700001630477270 | 1         | ...
```

---

#### dim_loader.py 完整规范

```python
# ── 主函数：Excel 导入组织维度 ────────────────────────────────
def import_org_hierarchy(excel_path: str, conn) -> dict:
    """
    读取组织维度 Excel 模板，写入 dim_org_node + dim_org_hier。
    stat_year 和 sys_id 从表格数据中读取（不从函数参数传入）。

    返回：{
        "success": int,        # 成功写入行数
        "updated": int,        # 更新行数（已存在则覆盖）
        "errors": list[str],   # 校验错误列表
        "warnings": list[str], # 警告（如管产分离未填说明）
        "hier_diff_count": int # 检测到的管产分离企业数
    }

    ── 步骤一：读取 Excel ───────────────────────────────────────
    - 跳过第2行（中文说明行），从第3行起读数据
    - 空行自动跳过
    - stat_year 列同一文件只允许一个值，否则报错终止

    ── 步骤二：字段校验（有错误则终止，不写入任何数据）────────
    必填字段非空检查：
      entity_id / entity_fullname / entity_type / sys_id /
      stat_year / is_stat_inc / mg_parent_id / mg_sort_no /
      eq_parent_id / eq_sort_no / is_active

    格式校验：
      entity_id：18位字符，或以 ROOT_ 开头的虚拟根节点
      sys_id：在 dim_org_sys 表中存在
      stat_year：4位整数
      entity_type：当前不做枚举约束，允许自由填写（待议二确认后补充）
      is_stat_inc / is_active：填"是"或"否"
      eq_shareholding_ratio：0.0001~1.0000 或留空
      mg_sort_no / eq_sort_no：正整数

    根节点规则校验：
      根节点识别改为：mg_parent_id = entity_id（自引用），不依赖 entity_type 字段
      自引用行的 is_stat_inc 必须为"否"

    父节点存在性校验：
      mg_parent_id 必须在本文件的 entity_id 列中存在（允许自引用）
      eq_parent_id 同上

    ── 步骤三：自动计算（全部由程序完成，禁止人工干预）──────────
    is_stat_inc / is_active：将"是"→TRUE，"否"→FALSE

    管理树计算（mg_）：
      mg_level：根节点=0，递归向上累加
      mg_path：简称拼接（无简称时用全称），/ 分隔，从根到本节点
      mg_path_ids：entity_id 拼接，/ 分隔
      mg_root_group_id：向上找 mg_level=1 的祖先节点 entity_id
                        若本节点 mg_level=0（根节点自身），mg_root_group_id=NULL
      mg_is_leaf：检查是否有其他行的 mg_parent_id = 本节点 entity_id

    产权树计算（eq_）：同管理树计算逻辑

    差异标记：
      is_hier_diff = (mg_parent_id != eq_parent_id)
      is_hier_diff=TRUE 时若 hier_diff_note 为空，追加 warning

    名称冗余同步：
      entity_shortname / entity_fullname：直接从数据行获取
      mg_parent_shortname / mg_parent_fullname：
        从同文件中查找 mg_parent_id 对应行的 shortname/fullname
      eq_parent_shortname / eq_parent_fullname：同上

    hier_id = MD5(entity_id || str(stat_year))

    ── 步骤四：与上年度对比，写变更日志 ─────────────────────────
    查询 dim_org_hier 中 stat_year-1 的记录
    对比 mg_parent_id / eq_parent_id，有变化则写 dim_org_hier_log：
      change_type = "管理变更" 或 "产权变更"
      old_*/new_* 字段记录变更前后的 parent_id

    ── 步骤五：写入数据库 ─────────────────────────────────────
    先写 dim_org_node（INSERT OR REPLACE）
    再写 dim_org_hier（INSERT OR REPLACE）
    两表在同一事务中提交，任一失败则全部回滚
    """


# ── 导出函数 ──────────────────────────────────────────────────
def export_org_hierarchy(stat_year: int, sys_id: str, conn) -> bytes:
    """
    将 dim_org_hier + dim_org_node 导出为 Excel 文件（字节流）。
    格式与导入模板完全一致（含第2行中文说明）。
    列顺序与模板18列保持一致。
    冗余计算字段（mg_path / mg_level 等）不出现在导出文件中。
    返回：Excel 文件的字节流（供 Streamlit download_button 使用）
    """


# ── 模板生成函数 ───────────────────────────────────────────────
def generate_template(conn) -> bytes:
    """
    生成空白导入模板（含表头和中文说明行，无数据行）。
    sys_id 下拉框从 dim_org_sys 动态读取。
    entity_type / is_stat_inc / is_active 列设置单元格下拉校验。
    返回：Excel 文件字节流
    """


# ── 税收编码导入函数 ───────────────────────────────────────────
def import_tax_code(xls_path: str, conn) -> dict:
    """
    导入商品和服务税收分类编码表（4205行，.xls 格式，xlrd 引擎读取）。
    从 19 位合并编码解析各层级字段：
      level_pian(第1位) / level_lei(2~3) / level_zhang(4~5) / ...
    计算 code_depth（非零层级数）/ is_leaf / parent_code
    全量替换：先 DELETE FROM dim_tax_code，再批量 INSERT
    返回导入统计
    """
```

---

#### UI 页面 02_维度管理 功能规范

```
页面布局（从上到下）：

① 顶部操作栏
   [下载导入模板] [上传 Excel 导入] [年度选择下拉] [树类型：管理树/产权树]

② 导入结果提示（导入后显示）
   成功：✓ 导入完成，共写入 XX 条，更新 XX 条
   警告：⚠ 发现 XX 家管产分离企业，建议填写 hier_diff_note
   错误：✗ 第 N 行：entity_id 格式错误（高亮显示错误行号和原因）

③ 组织树展示（缩进形式，非图形树）
   每行格式：[层级缩进] 企业简称（全称）  [管理层级N级] [排序:N]
   管产分离标记：红色 ● 标识
   点击展开/收起子节点

④ 底部操作
   [导出当前年度数据] [导入税收编码表]
```

---

#### 验证方式

```
1. 用第三方系统导出的原始文件验证全流程（待议一确认后补充具体步骤）
2. python -m modules.dim_loader import --file org_export.xlsx
3. 检查：
   - mg_path 正确拼接（有简称用简称，无简称用全称）
   - 管产分离企业 is_hier_diff=TRUE
   - dim_org_hier_log 有变更记录（对比上年度）
4. 导出 Excel 再导入，数据一致（幂等验证）
5. UI 中树结构展示正确，管产分离企业标红可见
```

#### 阶段二待议事项（开始编码前需补充确认）

**待议一：第三方系统导出格式（影响 dim_loader.py 字段映射逻辑）**

组织维度数据已在第三方系统中维护，且该系统可分别导出产权树和管理树。
`dim_loader.py` 应以该系统的导出格式为准，而非要求用户手工填写模板。

需要确认：
- 第三方系统导出的文件格式（Excel / CSV / 其他）
- 导出文件的字段名和结构
- 产权树和管理树是同一文件还是分两个文件导出
- 字段名是否需要映射（第三方名称 → InvoiceLens 内部字段名）

确认前，当前模板规范（18列 xlsx）作为备用方案保留，不作为主路径开发。

**待议二：`entity_type` 字段的语义（影响 dim_org_node 枚举约束）**

用"根节点/一级集团/二级及以下企业"描述存在歧义——同一企业在产权树和管理树中的层级可能不同，用单一字段无法准确描述。

待讨论：该字段应描述企业的**法人组织形态**（集团/子公司/分公司）还是其他属性？

**确认前的临时规则（编码时遵守）：**
- `dim_org_node.entity_type` 字段保留，不做枚举约束，允许自由填写
- 根节点识别方式：`mg_parent_id = entity_id`（自引用），不依赖 `entity_type`
- 自引用行的 `is_stat_inc` 必须为 FALSE（程序自动校验）
- 移除所有对 `entity_type` 枚举值的硬编码检查

---


### 阶段三：ODS + DWD 发票数据导入管道

**目标：** 实现金税 Excel → ODS Parquet → DWD 三表的完整导入管道，是整个工具最核心、最容易踩坑的阶段。

**交付文件：**
```
├── modules\
│   ├── loader.py             # Excel → ODS Parquet
│   └── cleaner.py            # ODS → DWD（主表+明细+映射+净额）
└── ui\pages\
    └── 01_数据导入.py         # 文件选择、进度显示、质量概览
```

**loader.py 核心逻辑：**

```python
def load_invoice_excel(excel_path: str, invoice_dir: str,
                       import_batch_id: str, conn) -> dict:
    """
    步骤一：识别金税版本（三期/四期），选择对应字段映射（`field_mapping.yaml`；开票日期 ODS 标准列名为 **kprq**）
    步骤二：全角→半角（括号、横杠、空格），统一清洗
    步骤三：ODS 落盘 **kprq**（原值）；DWD 阶段由 cleaner 将 **kprq** 解析为 **invoice_date（DATE）**，并派生 **stat_year / stat_month**
    步骤四：保存 ODS Parquet（路径：data/ods/批次={YYYYMMDD}/表类型={Sheet}/ods_file_seq={n}/，文件名 {YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet；目录键名以仓库 `excel_to_ods` 为准）
    步骤五：触发 cleaner.py 执行 ODS→DWD
    返回：导入统计（成功/失败/警告数量）
    """
```

**cleaner.py 核心逻辑：**

```python
# ① 主表（dwd_inv_header，单表 + stat_year + stat_month）
# - ODS 读 **kprq**；写入 DWD：**kprq**（原串）+ **invoice_date**（DATE）+ stat_year/stat_month
# - header_uuid = MD5(全角转半角后的 fpdm || fphm || sdfphm)
# - 先到先得去重：相同 header_uuid 只保留第一条
# - 若已存在且 jshj 差异 > 0.01 元：映射表 clean_status 标记"金额与主表存在差异"

# ② 明细表（dwd_inv_detail，单表 + stat_year）
# - logic_line_no 规则：数电票按 sdfphm 分组，纸票按 fpdm+fphm 分组
# - hwlwmc 含「详见销货清单」等且同票明细≥2条的汇总参考行赋值 0，正常行从 1 起编
# - 下游聚合必须 WHERE logic_line_no > 0

# ③ 映射表（dwd_inv_map，单表 + stat_year；无 group_id）
# - entity_id 匹配：进项取 gfsbh，销项取 xfsbh，与 dim_org_node 反查
# - 同一企业同一视角同一发票只存一次（UNIQUE 约束）
# - entity_name 从 dim_org_node 同步（用于展示/报告/审计可解释性；DWD/DWS 不含 group_id）

# ④ 平账回填（批量 UPDATE，导入完成后执行）
# - detail_total_amount = SUM(jshj) WHERE logic_line_no > 0
# - is_balanced 按 balance_tolerance（默认 0.10 元）判断

# ⑤ 净额回填（三步批量 UPDATE）
# - 步骤一：从 bz 解析 related_blue_invoice_uuid
# - 步骤二：蓝票净额 = jshj - 关联红票合计（绝对值）
# - 步骤三：孤立红票 net_jshj 保留负值（宽口径），标记 is_orphan_red
# - 步骤四：作废发票净额置零
```

**验证方式：**
- 用真实金税 Excel 文件验证全流程
- 主表/明细表数据正确，UUID 无重复
- 平账状态与手工核算一致
- 同一张发票被进项/销项两侧导入后，映射表有两行，主表只有一行

端到端验证（阶段三完成后立即执行，不等阶段四）：

数据管道的 bug 具有延迟暴露特性，DWD 层的数据问题往往在 DWS 聚合时才显现。
阶段三结束时必须跑小批量端到端测试：

```python
# tests/test_e2e_phase3.py
def test_net_amount_deducted_correctly():
    # 10 张发票含 1 张红票，DWS 聚合的 net_jshj 应等于手工计算值
    # 红票金额应从蓝票中扣除，不是简单相加

def test_summary_row_excluded_from_dws():
    # 含"详见销货清单"的发票导入后
    # DWS 聚合金额不得包含 logic_line_no=0 的汇总参考行
```

---

### 阶段四：DWS 汇总层 + 基础看板

**目标：** 将 DWD 数据聚合到 DWS 层，实现数据概览和供应商分析两个 UI 页面。

**交付文件：**
```
├── modules\
│   └── aggregator.py         # DWD → DWS 增量刷新
└── ui\pages\
    ├── 03_数据概览.py
    └── 04_供应商分析.py
```

**aggregator.py 核心设计：**

```python
def refresh_dws(stat_year: int, conn):
    """
    增量刷新指定年度的全部 DWS 表（单表 + stat_year，决策九；DWS **无 group_id**）。
    数据源：dwd_inv_header / dwd_inv_detail（WHERE stat_year=…）；`group_id` 仅在后续 **DM** 分析中体现。
    核心聚合字段：net_jshj（净额，已含红冲影响，DWS 直接 SUM 无需 JOIN 净额表）

    刷新触发时机：每次 DWD 净额回填完成后自动触发
    刷新策略：DELETE WHERE stat_year=? 后重新 INSERT（或等价原子策略）
    """
    # 刷新五张 DWS 表（无年度后缀，表中 stat_year 区分年度）：
    # dws_trade_sum     实体交易汇总（主体×对手方）
    # dws_inv_trend     月度趋势
    # dws_sup_conc      供应商集中度（含 amount_rank / cumulative_ratio）
    # dws_goods_cat     商品品类汇总
    # dws_quality       数据质量汇总
```

**UI 要求：**
- 03_数据概览：核心指标卡（总金额/总张数/供应商数/疑点数）、月度趋势折线图、税率分布饼图
- 04_供应商分析：CR1/CR3/CR10 指标卡、帕累托曲线图、Top20 供应商表格、新增供应商标红、行业基准切换

**验证方式：**
- DWS 数据与 Excel 手工汇总结果比对一致
- 切换年度/集团后图表数据正确刷新

---

### 阶段五：DM 审计疑点分析引擎

**目标：** 实现 10 条审计规则和关联交易识别，是工具核心价值的集中体现。

**交付文件：**
```
├── modules\analyzer\
│   ├── anomaly.py            # 10 条审计疑点规则
│   └── related_party.py      # 关联交易识别（图计算）
└── ui\pages\
    ├── 05_审计疑点.py
    └── 06_关联交易.py
```

**建议实现顺序：**

先实现规则 01-05（硬规则，逻辑明确），验证通过后再实现 06-10（涉及统计方法）：

```
RULE-01：重复开票（同购销方+同金额，30天内≥2次；化整为零检测）      → 高风险
RULE-02：异常日期（节假日/大额周末/年末突击/跨期/未来日期）          → 中风险
RULE-03：红冲异常（红冲后再开/跨年红冲/红冲比例>20%/无对应原票）     → 高/中风险
RULE-04：作废率异常（>5%预警/>10%高风险）                            → 中/高风险
RULE-05：税率与品类不匹配（与 dim_tax_code 比对）                    → 中风险
─────── 以上先验证通过 ───────
RULE-06：金额异常值（3σ法则，需≥5张历史发票）                       → 中风险
RULE-07：开票频率突变（某月>月均3倍）                                → 中风险
RULE-08：价格一致性（同品类同季度价格离散度>20%）                    → 低风险
RULE-09：对开发票（双向金额比值≥0.8高风险/0.5-0.8中风险）           → 高/中风险
RULE-10：集团内部未申报交易（双方均在 ads_org_member 中）            → 高风险
```

**related_party.py 关键约束：**

```python
# 图计算降级策略（决策十二，严格遵守）
#
# 问题：全库税号建图，数亿行数据可能产生数千万节点
#       NetworkX 纯内存计算会 OOM，桌面端不可用
#
# 降级三层策略：
#
# 第一层（优先）：DuckDB SQL 自连接，解决两跳以内的关联，无内存压力
#   对开发票 = dws_trade_sum 自连接，找 A->B 且 B->A 的组合
#   集团内交易 = xfsbh/gfsbh 与 ads_org_member 做 IN 过滤
#
# 第二层（必要时）：SQL 强过滤后建小图，控制 NetworkX 节点数 < 10万
#   过滤条件：net_jshj > 10万 AND 交易对数 < 5万组
#   超过阈值则跳过图计算，UI 提示"数据量过大，仅展示 SQL 结果"
#
# 第三层：NetworkX 在 threading.Thread 后台线程执行，不阻塞 Streamlit
#   禁止在 Streamlit 回调里直接用 multiprocessing 调用 NetworkX（会死锁）
#
GRAPH_ROW_LIMIT = 100_000   # 超过此行数走 SQL 降级，在 settings.py 中配置

# entity_name 冗余：dm_audit_flag.entity_name 写入时直接从 dwd_inv_map 带入
# 遵循 entity_fullname 冗余策略，不事后 JOIN
```

**验证方式：**
- 构造测试数据集，埋入已知异常，验证 10 条规则全部命中
- 对开发票识别准确，通道公司穿透逻辑正确
- UI 疑点列表支持人工确认和备注

---

### 阶段六：ADS + 报告生成 + 打包交付

**目标：** 完成子公司评分卡、报告生成、UI 收尾、PyInstaller 打包。

**交付文件：**
```
├── modules\
│   └── reporter.py           # Word 报告生成（六章结构）
└── ui\pages\
    ├── 07_子公司对比.py
    └── 08_生成报告.py
```

**ADS 层评分卡逻辑：**

```python
# ads_scorecard 风险得分计算（基础分 100 分）
score = 100
score -= flag_high   * 8   # 高风险疑点每条 -8 分
score -= flag_medium * 3   # 中风险疑点每条 -3 分
score -= flag_low    * 1   # 低风险疑点每条 -1 分
if cancel_ratio > 0.10: score -= 5   # 作废率超 10% 额外扣 5 分
if cr1 > 0.50:          score -= 5   # CR1 超 50% 额外扣 5 分
score = max(0, score)

# 风险等级
risk_level = "正常" if score >= 80 else "关注" if score >= 60 else "重点关注"
```

**报告结构（Word 格式，六章）：**

```
封面（集团名称 + 分析年度 + 生成日期）
第一章  数据概览（汇总指标 + 数据质量评估）
第二章  发票结构分析（月度趋势 + 税率分布 + 品类分布）
第三章  供应商分析（CR 值 + Top20 + 新增供应商）
第四章  审计疑点清单（分风险级别，每条附建议核查动作）
第五章  关联交易分析（对开发票 + 通道公司）
第六章  子公司横向对比（风险评分排名 + 综合评级）
```

**PyInstaller 打包注意事项：**

```
# 必须正确处理的依赖
--add-data "config;config"
--add-data "assets;assets"
--hidden-import duckdb
--hidden-import chinese_calendar   # 节假日数据需随 .exe 打包

# 建议在阶段四结束时做一次试打包
# 不要等到最后才发现路径问题
```

**验证方式：**
- 完整流程在干净 Windows 机器上跑通：导入→分析→生成报告
- 生成的 Word 报告内容与 UI 展示一致
- .exe 双击可运行，无需安装 Python 或任何依赖

---



## 九、测试规范与回归测试

### 测试数据构造

在没有真实金税数据的情况下，构造以下测试数据集：

1. 构造 3 家子公司，每家 500 张发票（随机生成）
2. 故意在数据中埋入以下异常，验证各规则能否命中：
   - 2 张重复发票（同购销方 + 同金额 + 7 天内）
   - 3 张节假日发票（使用 2024 年春节日期）
   - 1 对对开发票（子公司 A 和供应商 X，金额接近）
   - 1 家作废率 15% 的供应商
   - 1 家 CR1 超过 60% 的子公司

### pytest 回归测试规范

每完成一个阶段，立即让 AI 生成对应的回归测试。后续所有代码修改必须先跑通测试再提交。

AI 修改代码时最常见的隐性破坏：
- 把 DECIMAL(18,2) 改成 FLOAT（丢失金额精度）
- 删掉 WHERE logic_line_no > 0（汇总参考行混入计算）
- 把 INSERT OR IGNORE 改成 INSERT（破坏去重逻辑）
- 把平账容忍度 0.10 改成 0（导致大量误报）

各阶段必须覆盖的测试用例（示意）：

```
阶段一：test_dwd_inv_header_columns / test_header_uuid_unique_constraint / test_decimal_precision
阶段三：test_fullwidth_to_halfwidth / test_logic_line_no_summary_row / test_net_jshj_orphan_red / test_balance_tolerance
阶段五：test_rule01_duplicate / test_rule09_circular / test_graph_sql_fallback
```

---

## 十、关键设计决策备忘（已确认，AI 编码时严格遵守）

以下所有决策均已在设计讨论中确认，AI 生成代码时不得推翻或另作他选。

**决策一：存储引擎统一 DuckDB**
- 全部层级（DWD / DWS / DIM / DM / ADS）统一使用 DuckDB，数据库文件为 `data/database/warehouse.duckdb`
- 无 SQLite **业务**分库（**【遗留】** 初稿中的 SQLite 模块不实现）；无 MySQL；选型对比见「为什么不用纯 SQLite」
- 理由：桌面单用户工具，无并发压力；DuckDB 完整支持 UPDATE/事务；一个文件一套连接，架构最简

**决策二：entity_id 匹配方式**
- 进项发票：用 `gfsbh`（购方识别号）与 `dim_org_node.entity_id` 反查
- 销项发票：用 `xfsbh`（销方识别号）与 `dim_org_node.entity_id` 反查
- 匹配失败：`entity_id` 置 NULL，`clean_status` 标记"企业识别号匹配失败"，不中断导入

**决策三：净额计算口径（宽口径）**
- 未能关联到蓝票的孤立红票，`net_jshj` 保留负值参与 SUM 聚合
- 同时标记 `is_orphan_red=TRUE`，在 `dws_quality` 中单独统计数量
- 不采用严口径（排除孤立红票），避免遗漏资金异常线索

**决策四：DIM 层组织维度三表结构**
- `dim_org_sys`：企业系统分类（省属/市属，静态）
- `dim_org_node`：企业节点基础信息（不含年度，不含层级）
- `dim_org_hier`：双树年度层级快照（产权树 + 管理树，人工录入5个字段，自动计算15个字段）
- 根节点规则：`mg_parent_id = entity_id`（自引用），不填 NULL，不填国资委

**决策五：久其报表集成（架构预留，二期实现）**
- 久其 `.jio` 为私有二进制格式，一期不实现解析
- 一期在数据库中预置占位表 `jiuqi_financial_stub`，保留接口定义
- 二期优先路径：财务人员从久其导出 Excel，`jiuqi_loader.py` 解析导入
- 映射关系预留：进项发票净额 ↔ 应付账款、税额 ↔ 抵扣数据、费用发票 ↔ 费用科目

**决策六：entity_fullname 冗余策略贯穿全链路**
- `dim_org_node.entity_fullname` 是权威数据源，唯一修改入口
- DIM 层：`dim_org_hier` 冗余 entity_fullname / mg_parent_fullname / eq_parent_fullname
- DWD 层：`dwd_inv_map` 冗余 `entity_name` 等展示字段（**无 `group_id` 列**；`group_id` 仅 DM）
  - 用途：为 UI/报告/疑点证据链提供“可读名称”，减少查询时对 DIM 的临时 JOIN，降低延迟并保证历史名称快照一致
  - 来源/时点：字段由 `dim_org_node` 在写入 `dwd_inv_map` 时带入（体现企业更名后的历史时点准确性）
- DWS/DM/ADS 层：所有涉及企业名称的字段在写入时从上游直接带入，不事后 JOIN 回填
- 历史数据不做反向更新（发票记录保留写入时的名称，体现历史时态准确性）

**决策七：年度表建表策略（两者结合）**
- 单表设计，`init_db.py` 一次性建好所有 21 张表
- 新年度数据直接 INSERT 进单表，stat_year 列区分年度
- 无动态建表，无联合视图，无 PRESET_YEARS / ensure_year_tables / rebuild_union_views

**决策八：多级使用模式（共用一套代码）**
- `SCOPE.scope_root_id` 配置本实例组织树的起点 entity_id
- 审计厅：ROOT_PROV_SD；集团：集团自身 entity_id；子公司：子公司自身 entity_id
- 各安装实例数据库完全独立，互不影响，不存在数据可见性权限问题
- `scope_root_id` 不是权限控制，是"这个实例的树从哪里开始渲染"

**决策九：DWD 层采用单表 + stat_year 列，不按年度分表**
- DuckDB 列存储对 `WHERE stat_year=N` 的过滤效率与分表几乎相同
- 单表方案省去 `ensure_year_tables` / `rebuild_union_views` 机制，代码量减少约 40%
- `dwd_inv_header`（无年度后缀）加 `stat_year SMALLINT NOT NULL` 列，建复合索引
- `schema_duckdb.py` 中的动态建表函数（PRESET_YEARS / ddl_dwd_for_year / ddl_dws_for_year 等）已全部删除，当前为单表版
- DWS 层同理，也改为单表 + stat_year 列

**决策十：ODS Parquet 文件体系（与全文「ODS 文件名与目录规范」一致）**
- 同一 Excel 内多个 Sheet 可对应多个 `表类型` 分区；每个成功写出的 Parquet 占用下一个 `序号`（同批次同表类型下递增）
- 目录（三级 Hive 分区，固定键名）：`data/ods/批次={YYYYMMDD}/表类型={Sheet}/序号={0001}/`
- 文件名：`{YYYYMMDDHHMMSS}_{表类型}_{UUID}.parquet`
  - `YYYYMMDDHHMMSS` 为**实际导入时间**（14 位），与目录 `批次` **解耦**
  - `UUID` 建议 `uuid4().hex`，仅防重名
- DuckDB 视图：`parquet_scan('data/ods/**/*.parquet', hive_partitioning=true)`，自动透出 `批次`、`表类型`、`序号` 分区列
- 进项/销项等语义**不作为** ODS 分区键；若需保留，写入行内普通列或元数据日志

**决策十一：ODS 导入采用两阶段并行策略**
- 阶段一（ODS：Excel→Parquet）：**进程池解析 + 主进程原子写出**（与决策十路径一致），worker 数默认不超过 4
  - 子进程/进程池：Excel 读取、字段映射、校验与拒收计算
  - 主进程：`序号` 分配、Parquet 实际写出、导入日志落库；不允许多 worker 抢写同一 `批次+表类型` 序号
  - 原子写入：先写 `.tmp` 再 `rename`，防止崩溃留下损坏文件
- 阶段二（DWD：Parquet→DuckDB）：串行批量写入，DuckDB 单写入者限制不可并行
  - DuckDB 内部已多线程执行 SQL，批量 INSERT 本身已经很快
- 数据质量影响：无，Parquet 文件路径唯一，DuckDB 唯一约束兜底
- 实际收益：500 家企业全量导入，预计从约 125 分钟缩短至约 35~45 分钟
- Streamlit 中禁止在 UI 回调里直接用 multiprocessing，改用 threading.Thread

**决策十二：关联交易图计算三层降级策略**
- 第一层（优先）：DuckDB SQL 自连接处理两跳以内关联，无内存压力
  - 对开发票：dws_trade_sum 自连接，找 A→B 且 B→A 的组合
  - 集团内交易：xfsbh / gfsbh 与 ads_org_member 做 IN 过滤
- 第二层（必要时）：SQL 强过滤（净额>10万，交易对数<5万组）后建小图
  - NetworkX 节点数控制在 10 万（GRAPH_ROW_LIMIT）以内
  - 超过阈值则跳过图计算，UI 提示"数据量过大，仅展示 SQL 结果"
- 第三层：NetworkX 在 threading.Thread 后台线程执行，不阻塞 Streamlit 主线程
- 严格禁止：在 Streamlit 回调里直接用 multiprocessing 调用 NetworkX（会死锁）

---



## 产品简介：InvoiceLens · 票鉴

> 透过发票数据，洞见审计风险

---

### 是什么

**InvoiceLens（票鉴）** 是一款面向国有企业集团审计部门的发票大数据审计分析工具。

它解决的核心问题是：集团下属企业各自管各自的账，审计人员拿不到统一的发票数据，也没有工具帮他们从一堆 Excel 文件里发现异常。InvoiceLens 把这件事变成：下属企业从金税系统导出发票数据，工具自动归集、清洗、分析，10条审计规则全自动标记疑点，最终生成一份可以直接提交领导的审计分析报告。

全程本地运行，数据不出内网，打包为单个 .exe 文件，双击即用。

---

### 解决什么问题

```
现状                              InvoiceLens 之后
─────────────────────────────────────────────────────
各子公司发票数据分散存放     →    统一归集，全集团发票一张表
手工核查重复开票、异常日期   →    10条规则自动标记，疑点清单自动生成
不知道供应商是否过度集中     →    CR1/CR3/CR10 自动计算，帕累托图直接看
发票真假、红冲是否合规       →    红蓝对冲自动计算净额，孤立红票自动标记
关联交易靠经验排查           →    购销双向比对，对开发票、通道公司自动识别
报告要手工写                 →    一键生成 Word/PDF 审计分析报告
```

---

### 适用场景

| 使用方 | 典型场景 |
|---|---|
| **省属企业集团审计部** | 汇聚 300～500 家下属企业 3 年发票数据，全面穿透分析 |
| **省级审计厅** | 跨集团横向对比，识别全省异常交易线索 |
| **市属企业集团** | 独立部署，本集团发票数据自查自纠 |
| **二级子公司审计** | 聚焦本企业及下属，自主开展专项审计 |

三种场景共用同一套工具，安装时配置根节点，自动适配可见范围。

---

### 核心能力

**数据归集**
各下属企业从金税系统（金税三期/四期）导出标准 Excel，工具自动识别字段、清洗格式、全局去重——同一张物理发票被多家企业导出时只存一份，买卖双方视角同时可见。

**智能分析**
10条内置审计规则覆盖最常见的风险场景：重复开票、节假日异常、红冲套现、税率不符、供应商集中、对开发票、通道公司穿透……每条规则附有中文描述和延伸审计建议，直接可用。

**关联交易识别**
基于图计算技术，自动在全库发票中找出"既是供应商又是客户"的企业、双向金额相近的对开发票、资金流向第三方的通道公司——这类风险靠人工排查要几天，工具几秒完成。

**组织树管理**
内置省属/市属企业两套管理体系，每家企业同时维护产权树和管理树，自动标记管产分离企业。支持从 Excel 导入、在线维护、导出备份，每年一次年度更新。

**报告生成**
分析结果一键导出为 Word 格式审计分析报告，包含封面、数据概览、供应商分析、疑点清单（每条附建议核查动作）、关联交易、子公司横向评分卡共六章，审计人员无需二次加工直接提交。

---

### 技术特点

- **本地部署，数据零泄露**：所有计算在本机完成，无需联网，无云端数据传输
- **单文件分发**：打包为 .exe，无需安装 Python 或数据库，双击运行
- **大数据支撑**：底层采用 DuckDB 列存储引擎，30户省属企业集团、3亿行发票数据，秒级响应
- **授权灵活**：试用版免费体验核心功能，标准版/专业版按需升级，离线 .lic 文件激活，无需联网验证

---

### 版本与定价（参考）

| 版本 | 适用场景 | 主要限制 |
|---|---|---|
| 试用版（免费30天） | 功能评估 | 3家企业，5万张发票，不可导出报告 |
| 标准版 | 集团审计部 | 500家企业，500万张，支持导出 |
| 专业版 | 审计厅/省国资委 | 无限制，支持跨集团全局分析 |

---

*InvoiceLens 由具有10年审计信息化从业经验的独立开发者构建，深度融合国有企业审计实务场景。*
*联系与试用：[在此填写联系方式]*

---

*提示词版本：v9.6.5 | 核心变更：① **ODS 开票日期标准列统一为 `kprq`**，DWD 保留解析列 **`invoice_date`（DATE）**；② 字段映射表 §2.2 与 cleaner 口径对齐；③ 索引示例补充 **`(stat_year, stat_month)`** | 历史：v9.6.4 久其/`ods_load_log`/dwd_inv_map/UI 排障等 | 适用场景：省属国有企业集团发票大数据审计工具*

---

### 分阶段编写前须确认清单（拍板后再开工可避免返工）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **`group_id` 与 `dwd_inv_map`** | **已裁决**：DWD/DWS/`dwd_inv_map` **均无 `group_id`**；`group_id` **仅 DM**（及分析批次相关输出）。 |
| 2 | **查询 ODS / DWD** | **已裁决**：允许直接查 **ODS（视图）与 DWD**（排障/下钻）；默认业务页仍以 DWS/DM/ADS 为主，并带 `stat_year` 护栏。 |
| 3 | **SQLite** | **已裁决**：**【遗留】** 不实现 SQLite 业务库；与「为何选 DuckDB」相关的 SQLite **对比表**保留。 |
| 4 | **久其 ODS 路径** | 发票 ODS 已规范；`jiuqi/` 分区规则若一期不做，可显式标「预留」。 |
| 5 | **与仓库 DDL 对齐** | 分阶段编写时以 `db/schema_duckdb.py`（及相关 `schema_*.py`）的实际表名/列名/约束为准；提示词给的是生成规则，不与 DDL 不一致时以 DDL 为准。 |
| 6 | **`entity_type` 枚举** | 文中仍有「待议」；分阶段时可先自由文本，后续再收紧。 |
