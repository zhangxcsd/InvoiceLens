# InvoiceLens 离线打包指南

本文说明如何将 **Python 后端 + React 前端 dist + config/assets** 打成可在无网络环境运行的 Windows 可执行包。

## 前置条件

1. **Python 版本**（见下文「Python 版本对齐」），已安装依赖：

   ```bat
   pip install -r requirements.txt
   pip install pyinstaller
   ```

2. **Node.js**，构建前端（须离线资源，禁止 CDN）：

   ```bat
   cd frontend
   npm ci
   npm run build
   ```

   确认存在 `frontend/dist/index.html`。

3. **Plotly / 静态资源**：报告 HTML 导出使用 `include_plotlyjs="inline"`；`assets/` 目录会随 spec 一并打入包内。

## 构建步骤

在项目根目录：

```bat
pyinstaller invoicelens.spec --noconfirm
```

产物：`dist/InvoiceLens.exe`（单文件，**无控制台窗口**；日志写入 `data/logs/invoicelens.log`）。

## 运行

1. 双击 `dist/InvoiceLens.exe`，或：

   ```bat
   set INVOICELENS_SERVE_UI=1
   python scripts/run_packaged_app.py
   ```

2. 浏览器访问 **http://127.0.0.1:8765/**（API 与 UI 同源，无需 Vite）。

3. 默认登录：
   - 空账号一键登录，或
   - `admin` / `admin`
   - 勾选「记住我」时会话 token 存于 `localStorage`（否则仅 `sessionStorage`）

4. 数据与配置仍写入 **`data/`**（与开发模式相同，相对当前工作目录）。

## 打包内容说明

| 路径 | 用途 |
|------|------|
| `config/` | DDL、映射、默认 LICENSE/SETTINGS、`license_public.pem` |
| `assets/` | 离线静态资源、种子数据 |
| `frontend/dist/` | Vite 生产构建 |
| `data/` | **不**打入 exe；首次运行自动创建（DuckDB、users.json、sessions.json、license 等） |

环境变量：

- `INVOICELENS_SERVE_UI=1`：当存在 `frontend/dist` 时托管静态 UI
- `INVOICELENS_LOCAL_API_PORT`：默认 8765
- `INVOICELENS_SESSION_TTL_HOURS`：会话 token 有效期（默认 168 小时）

## 授权与门控

优先级：**`data/config/license_override.json`（开发覆盖）> 验签通过的 `data/config/license.lic` > `config/settings.py` 默认试用**。

### 开发态

在「授权管理」粘贴 JSON 或手动编辑 `data/config/license_override.json`，无需签名。

### 生产态（.lic）

1. 生成密钥对（一次性）：

   ```bat
   python scripts/gen_license_keys.py
   ```

   - 公钥：`config/license_public.pem`（随包分发）
   - 私钥：`scripts/.license_private.pem`（**勿提交仓库**，仅用于签发）

2. 签发客户授权：

   ```bat
   python scripts/sign_license.py --out data/config/license.lic
   python scripts/sign_license.py --payload "{\"tier\":\"pro\",\"customer\":\"ACME\",\"max_entities\":50,\"export_report\":true,\"cross_group\":true,\"expires_at\":\"2099-12-31\"}"
   ```

3. 将 `license.lic` 部署到目标机 `data/config/license.lic`；程序启动时用内置公钥 RSA-PSS 验签。

### 配额硬门控

| 字段 | 行为 |
|------|------|
| `max_entities` | 主体对比列表/图表按上限截断 |
| `max_invoices` | 库内发票已达上限时拒绝 `start-import` / DWD 加工 |
| `max_years` | 新增统计年度超限时拒绝 DWD 加工与主体库 pipeline |

## 会话

- 服务端：`data/config/sessions.json` 落盘，进程重启后 token 仍有效（TTL 可配置）。
- 前端：Bearer token；「记住我」→ `localStorage`，否则 `sessionStorage`。

## 审计

本地 JSON 文件 `data/config/audit_log.json`，最多保留 2000 条。

## 冒烟测试

本地完整打包冒烟（Windows 推荐，与交付目标一致）：

```bat
cd frontend
npm ci
npm run build
cd ..
pip install -r requirements.txt pyinstaller
pyinstaller invoicelens.spec --noconfirm
python scripts/test_packaging_smoke.py --require-binary
```

仅校验前端 dist 与 `build_meta.json`（未打 PyInstaller 包时）：

```bat
python scripts/test_packaging_smoke.py
```

授权、会话与门控：

```bat
python scripts/test_license_gate_smoke.py
python scripts/test_rbac_smoke.py
python scripts/test_stage5_license_users_smoke.py
```

`test_packaging_smoke.py` 在存在 `dist/InvoiceLens(.exe)` 时会额外验证：

- `/health`、`/api/auth/login`、`/api/auth/me`
- `/api/settings/license`（含 `gates`）
- `/api/compare/meta` 在试用授权下返回 **403**（`license_cross_group_denied`）
- 静态 UI 首页可访问

单文件 exe 首次启动较慢（解压依赖），冒烟脚本健康检查默认等待最长 120 秒；子进程日志重定向到 `DEVNULL` 避免 Windows 管道阻塞（应用日志见 `data/logs/invoicelens.log`）。

### CI

GitHub Actions 工作流（`.github/workflows/`）在相关路径变更时触发，主要包括：

| 工作流 | 验证内容 |
|--------|----------|
| `packaging-smoke.yml` | 前端 dist、PyInstaller 二进制、health/login/license/compare 门控 |
| `rbac-smoke.yml` | API 会话 RBAC + Playwright 导航 |
| `compare-ads-smoke.yml` | 对比 ADS + 授权门控 |
| `e2e-delivery-chain-smoke.yml` | 端到端交付链 |
| `dws-filter-smoke.yml` | DWS 筛选 API |
| `tree-regression-smoke.yml` | 树组件 Playwright 截图回归 |
| `nightly-smoke.yml` | 每日 UTC 16:00 聚合 Python 冒烟 + Playwright 导航/规则页（无 PyInstaller 重建） |
| 其他 `*-smoke.yml` | 各子系统脚本冒烟 |

Windows job 不重复 Stage 5 脚本（runner 耗时考虑）；Linux job 仍覆盖授权导入冒烟。

## Python 版本对齐

| 场景 | 版本 | 说明 |
|------|------|------|
| GitHub Actions 冒烟 / 打包 CI | **3.12** | `.github/workflows/*-smoke.yml` 统一 `python-version: '3.12'` |
| 本地日常开发 | **3.13+** 推荐 | 本地 API 不依赖已移除的 `cgi` 模块；README 开发节说明 |
| PyInstaller 交付包 | 与构建机一致 | 建议在 **3.12 或 3.13** 上与 CI 相同大版本做 release 构建，避免 wheel 差异 |

开发机为 3.14 等较新版本时，发布前请在 3.12/3.13 环境复跑 `test_packaging_smoke.py --require-binary`。

## Windows 安装程序

除直接分发 `dist/InvoiceLens.exe` 外，仓库提供 **Inno Setup** 脚本生成带开始菜单与卸载项的安装包。

### 前置条件

1. 已完成上文「构建步骤」，存在 `dist/InvoiceLens.exe`。
2. 安装 [Inno Setup 6+](https://jrsoftware.org/isinfo.php)，并将 `ISCC.exe` 所在目录加入 `PATH`（默认 `C:\Program Files (x86)\Inno Setup 6`）。

### 一键构建安装包

在项目根目录：

```bat
scripts\build_installer.bat
```

- 若 `dist\InvoiceLens.exe` 不存在，脚本会先执行 `pyinstaller invoicelens.spec --noconfirm`。
- 已有 exe 时跳过 PyInstaller：`scripts\build_installer.bat --skip-pyinstaller`
- 产物：`dist\InvoiceLens-Setup.exe`

手动编译（未加入 PATH 时）：

```bat
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\InvoiceLens.iss
```

### 安装布局

| 路径 | 说明 |
|------|------|
| `{autopf}\InvoiceLens\InvoiceLens.exe` | 主程序（单文件 PyInstaller 包，内含 config/assets/frontend/dist） |
| `{autopf}\InvoiceLens\README.txt` | 来自 `packaging/README_install.txt`（端口 8765、日志、授权位置） |
| `{autopf}\InvoiceLens\data\` | **不**打入安装包；首次运行在工作目录（`{app}`）旁自动创建 |

快捷方式工作目录设为 `{app}`，与开发模式一致（相对 cwd 的 `data/`）。

### 相关文件

- `packaging/InvoiceLens.iss` — Inno Setup 脚本
- `packaging/README_install.txt` — 安装目录内 README
- `scripts/build_installer.bat` — 构建辅助脚本

**暂不行**：代码签名（需企业证书）；自动更新通道。交付前仍建议 `python scripts/test_packaging_smoke.py --require-binary`。

## 授权签发 SOP（生产补充）

在「授权与门控」基础上，现场签发 checklist：

1. **密钥**：仅在一台离线或受控机器保留 `scripts/.license_private.pem`；仓库与安装包只带 `config/license_public.pem`。
2. **字段**：确认 `tier`、`customer`、`max_entities` / `max_invoices` / `max_years`、`export_report`、`cross_group`、`expires_at` 与合同一致。
3. **签发**：
   ```bat
   python scripts/sign_license.py --out D:\deliver\ACME\license.lic --payload "{"tier":"pro","customer":"ACME",...}"
   ```
4. **验签**：目标机部署 `license.lic` 至 `data/config/license.lic`，重启应用；调用 `GET /api/settings/license` 核对 `gates`；跑 `python scripts/test_license_gate_smoke.py`。
5. **轮换**：换公钥需 **同步发新 exe**（内置公钥）；旧 `.lic` 将全部失效。换私钥不影响已发 lic，但需安全销毁旧私钥。
6. **开发覆盖**：`license_override.json` 仅用于内网调试，**勿**随客户交付。

## 运维 Runbook 索引

- RBAC、任务链、`enterprise_year_rel` 互斥、finance/quality **sync-flags**、Stage 5 部署清单：`docs/ops_delivery_runbook.md`
- 企业年度关系 SQL 回填：`docs/dim_enterprise_year_rel_runbook.md`

