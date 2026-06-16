# 交付运维 Runbook（RBAC · 任务链 · sync-flags · Stage 5）

面向桌面离线部署与现场运维的一页式参考。打包与授权细节见 `docs/packaging.md`；`dim_enterprise_year_rel` SQL 回填见 `docs/dim_enterprise_year_rel_runbook.md`。

---

## 1. RBAC 运维

### 1.1 角色与权限

| 角色 | 权限标签 | 典型能力 |
|------|----------|----------|
| `admin` | `*` | 用户管理、授权导入、全部写操作与导出 |
| `analyst` | `read`, `write`, `export`, `audit_flags` | 导入/DWD/DIM/规则/疑点；**不可**管理用户或改授权 |
| `viewer` | `read` | 只读浏览；**不可**导出、改映射、跑加工写接口 |

定义位置：`src/local_api/users_api.py`（`ROLES`）。前端导航门控与 `frontend/src/users/rbacNav.ts` 对齐。

### 1.2 落盘文件

| 路径 | 用途 |
|------|------|
| `data/config/users.json` | 账号、角色、`password_hash` / `salt` |
| `data/config/sessions.json` | 会话 token（TTL：`INVOICELENS_SESSION_TTL_HOURS`，默认 168h） |
| `data/config/audit_log.json` | 登录/用户变更等审计（最多约 2000 条） |

内置 `admin` 不可删除。空用户名一键登录在开发/演示下等价于 admin（生产应禁用弱口令并改用正式账号）。

### 1.3 常见运维操作

1. **重置 admin 密码**：在「用户管理」由 admin 修改，或编辑 `users.json`（需按 `_hash_password` 规则生成 hash/salt）。
2. **只读账号**：创建 `role: viewer`，用于复核/展示。
3. **403 排查**：对照 `scripts/test_rbac_smoke.py` 与 `src/local_api/auth_session.py` 中的写路径列表；确认请求头带 `Authorization: Bearer <token>` 或 `X-Session-Token`。
4. **回归**：`python scripts/test_rbac_smoke.py`；Playwright 导航见 CI `rbac-smoke.yml`。

---

## 2. 任务链与 `enterprise_year_rel` 互斥

### 2.1 任务链

- **入口**：加工中心「分析关键路径 · 一键任务链」；API：`POST /api/dim/task-chain/start`，状态 `GET /api/dim/task-chain/status?run_id=...`，历史 `GET /api/dim/task-chain/runs`。
- **步骤**（串行）：主体库全流程 → 花名册 → 集团成员表 → 组织层级 → **年度购销标志** → DWS → 疑点扫描 → 评分卡（见 `src/local_api/dim_task_chain.py` 中 `CHAIN_STEP_DEFS`）。
- **状态文件**：`data/config/task_chain_runs.json`（最近约 20 次）。

**并发规则**：同一进程内仅允许一条活动任务链。若 `ads_etl_task_run_log` 中相关 `task_code` 仍为 `running`，或主体库 pipeline 仍在跑，新启动会返回 `ConflictError` 文案。

### 2.2 `dim.enterprise_year_rel.rebuild` 互斥

- 进程内锁：`_active_rel_rebuild`（错误码 `rel_rebuild_busy` / `ConflictError`）。
- 台账：`ads_etl_task_run_log` 任务码 `dim.enterprise_year_rel.rebuild`。
- **触发来源**（可能互相阻塞）：任务链步骤、花名册/手工维护后链式重算、`POST /api/dim/enterprise-year-rel/rebuild`、DWD 构建参数 `rebuild_enterprise_year_rel: true`。

**运维建议**：

1. 冲突时先查加工中心任务台账或 `GET /api/dim/task-runs`，等待 `running` 结束。
2. 进程异常退出后若长期「假 busy」：重启本地 API 或 exe（释放内存锁）；台账仍 `running` 时按 DIM 任务惯例处理异常行。
3. 维护窗口内避免并行：大批量 DWD + 任务链 + 手工 rel 重算。
4. 冒烟：`python scripts/test_enterprise_year_rel_mutex_smoke.py`（CI：`enterprise-year-rel-mutex-smoke.yml`）。

---

## 3. finance / quality sync-flags（写入 DM 疑点）

将页面分析结果同步为审计旗标（非 SQL 规则扫描），配置见 `config/audit_rules.yaml` 中对应 rule 注释。

| 域 | HTTP | 典型调用方 | RBAC |
|----|------|------------|------|
| 财务账票核对 | `POST /api/finance/reconcile/sync-flags` | 「财务 · 差异分析」 | 需 `write`（viewer 403） |
| 数据质量 · 语义 | `POST /api/quality/semantic/sync-flags` | 质量明细/语义页 | 需 `write` |
| 税码结构分析 | `POST /api/dim/tax-code/analysis/sync-flags` | 税码分析页 | 需 `write` |

**请求体（常见）**：`batch_id`、`stat_year`、`entity_id` 等筛选与页面一致；返回含 `inserted`、`skipped_confirmed`、`by_rule`。

**运维片段**：

```bat
python scripts/test_finance_reconcile_api_smoke.py
python scripts/test_semantic_quality_smoke.py
```

同步前确认 DWD/批次范围已稳定；已「确认」的旗标通常会被跳过（`skipped_confirmed`）。

---

## 4. Stage 5 一页部署（授权 + 用户 + 冒烟）

**目标**：在无源码的目标 Windows 机上验证「可登录、授权生效、RBAC、打包 health」。

### 4.1 交付物

- `dist/InvoiceLens.exe`（或开发目录 + `INVOICELENS_SERVE_UI=1`）
- 可选：`data/config/license.lic`（生产签名授权，见 packaging 授权节）
- 数据目录 `data/` 随运行生成

### 4.2 步骤（Checklist）

1. 构建前端 dist + PyInstaller（见 `docs/packaging.md`）。
2. 首次启动 exe，浏览器打开 `http://127.0.0.1:8765/`。
3. 使用 admin 登录；在「授权管理」确认 tier / gates（或部署 `license.lic`）。
4. 创建 analyst / viewer 测试账号，确认 viewer 无法访问用户管理与写接口。
5. 运行冒烟（构建机或 CI Linux job）：
   ```bat
   python scripts/test_stage5_license_users_smoke.py
   python scripts/test_license_gate_smoke.py
   python scripts/test_rbac_smoke.py
   python scripts/test_packaging_smoke.py --require-binary
   ```
6. 留痕：授权客户名、`license.lic` 到期日、admin 初始密码策略、冒烟通过记录。

### 4.3 CI 说明

- Linux workflow 覆盖 Stage 5 脚本；Windows packaging job 侧重二进制与 health（见 packaging.md CI 表）。
- 相关 workflow：`stage5-license-users-smoke.yml`、`packaging-smoke.yml`、`rbac-smoke.yml`。