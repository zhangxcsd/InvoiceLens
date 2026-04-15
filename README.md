## InvoiceLens（票鉴）

本项目遵循“**代码与数据产物分离**”的目录约定：`db/` 只放数据库相关代码；`data/` 只放运行产物与落盘数据（可随运行生成/清理/备份）。

### 目录约定（必须遵守）

- **`db/`**：数据库相关代码
  - DuckDB 连接、初始化、迁移骨架、DDL 加载与执行
  - **不放任何数据库文件**（`.duckdb` 属于数据产物）
- **`config/`**：可配置项（外置，不硬编码）
  - **`config/ddl/*.sql`**：DuckDB 建表/视图 DDL（**必须保留 SQL 注释**，用于审计解释/导出）
  - `config/sheet_mapping.yaml`：Excel sheet → `data_type`（表类型）映射
- **`data/`**：数据产物（运行期生成）
  - **`data/database/warehouse.duckdb`**：DuckDB 单文件主库（DIM/DWD/DWS/DM/ADS + ODS 元数据表等）
  - **`data/ods/`**：ODS Parquet 落盘（按 `批次=.../表类型=.../...parquet` 组织）
  - `data/ods/manifests/`：ODS manifest（按 `batch_id + table_type` 聚合）
  - `data/input_excel/`：可选的输入缓存目录（开发/调试用）
- **`Source_Data/`**：外部原始输入（不要求命名规则，可能包含多级子目录）
- **`assets/`**：前端/报告静态资源（必须支持离线，不依赖外网 CDN）
- **`src/`**：业务代码（UI、ingestion、ETL、规则等）
- **`output/`**：导出物（报告、结果文件等）

### 关键原则（高频踩坑点）

- **ODS 不等于 DuckDB 内部表**：ODS 业务数据优先落 Parquet（`data/ods/`），DuckDB 通过 `read_parquet(...)` 的 VIEW/外部查询方式挂载。
- **Excel 读取必须“可跳过、可追踪、不中断”**：文件级阻断 vs 行级拒收要分开记录，程序不能因单文件/单行异常整体崩溃。
- **DDL/配置外置**：表类型映射、建表 SQL、规则 SQL 不写死在 `.py`。
- **离线优先**：禁止依赖外网 CDN；需要打包时要把 `assets/` 等静态资源一起带上。

### 开发启动（Windows）

根目录 **`dev.bat`** 合并了原 `start_dev.bat` / `start_local_api.bat` / `start_ui.bat` / `restart_frontend_dev.bat`（脚本内 **`chcp 65001`** + **UTF-8 BOM**，`start` 窗口标题为英文，避免 CMD 默认 GBK 下乱码或把命令截断成 `rt` 等误报）：

- **`dev.bat`** 或 **`dev.bat all`**：新窗口启动本地 API + 当前窗口启动 Vite（日常开发最常用）
- **`dev.bat api`**：仅本地 API（导入写 ODS 须保持此进程）
- **`dev.bat web`**：仅前端（需已另开 API）
- **`dev.bat restart-web`**：结束 5173~5175 监听并新开窗口启动 Vite
- **`dev.bat ui`**：运行 `python main.py`
- **`dev.bat help`**：查看说明

前端 **`npm run dev`** 时，未配置 `VITE_LOCAL_API_BASE` 的情况下会通过 **Vite 代理** 把浏览器里的同源路径 **`/api`** 转到 **`127.0.0.1:8765`**，减少「页面是 localhost、API 是 127.0.0.1」等跨域问题；请确保本地 API 已在 8765 监听。

本地 API 已不使用标准库 **`cgi`**（Python 3.13 起已移除），可在 **Python 3.13+** 下运行；若启动仍报错，请确认在项目根目录执行且已 `pip install -r requirements.txt`。

亦可直接：`python main.py`

