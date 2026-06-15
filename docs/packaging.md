# InvoiceLens 离线打包指南

本文说明如何将 **Python 后端 + React 前端 dist + config/assets** 打成可在无网络环境运行的 Windows 可执行包。

## 前置条件

1. **Python 3.12+**（与日常开发一致），已安装依赖：

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
| `max_entities` | 子公司对比列表/图表按上限截断 |
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
| 其他 `*-smoke.yml` | 各子系统脚本冒烟 |

Windows job 不重复 Stage 5 脚本（runner 耗时考虑）；Linux job 仍覆盖授权导入冒烟。
