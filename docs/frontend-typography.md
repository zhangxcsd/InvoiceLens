# InvoiceLens 前端字体与排版规范

本文档为 **InvoiceLens `frontend/`** 的字体、字号、字色与表格排版的 **唯一约定来源**。实现 UI 时按本文档选用 Tailwind 类名，**避免**在各页面手写 `text-[12px]` 等魔法数字导致风格漂移。

**权威配置（代码即规范）**

- 字号刻度：`frontend/tailwind.config.ts` → `theme.extend.fontSize`（`il-*` 前缀）
- 语义颜色：`frontend/tailwind.config.ts` → `theme.extend.colors` 与 `frontend/src/index.css` 的 `:root` CSS 变量
- 全局正文字体与 `html` 基准字号：`frontend/src/index.css`（`body`）

---

## 1. 字体族

| 场景 | 约定 |
|------|------|
| 界面中文、正文、按钮、表单 | 使用默认 `font-sans`（勿在页面重复写 `font-family`）。栈已含 PingFang SC、微软雅黑、system-ui 等。 |
| 批次 ID、会话 ID、字段英文名、磁盘路径、JSON 片段 | `font-mono`，字号仍用下文 **语义字号 token**，勿单独用多种 `text-[11px]` / `text-[12px]` 混排。 |

---

## 2. 字号层级（必须使用 `il-*` token）

**规则：除本文档「第 6 节」允许的例外外，禁止在 JSX/CSS 中使用任意像素字号类（如 `text-[11px]`、`text-[13px]`）。**  
若现有设计需要新档位，先在 `tailwind.config.ts` 增加 `il-*` 项，再在页面引用。

| 语义 | Tailwind 类 | 典型用途 |
|------|---------------|----------|
| 登录区品牌名 | `text-il-login-brand` | 登录页产品标题 |
| 页面主标题 | `text-il-page-title`（常配 `font-semibold text-text`） | 各业务页 H1、对话框标题 |
| 页说明 / 次要段落 | `text-il-page-desc`（常配 `text-text-2`、`leading-relaxed`） | 标题下灰色说明文 |
| 顶栏 / 面包屑感小字 | `text-il-topbar`（配 `text-text-2` 或 `text-text-3`） | 与 `invoicelens.html` 顶栏一致的小字信息 |
| 卡片 / 区块标题 | `text-il-card-title`（常配 `font-semibold text-text`） | `Card` 默认标题、分区标题 |
| 表单标签 | `text-il-label`（常配 `font-medium text-text-2`） | 表单项上方标签 |
| 按钮内文 | `text-il-btn` | 主按钮、次按钮、文字按钮 |
| 输入框 / 下拉框内文字 | `text-il-input` | 紧凑控件内文（与原型一致偏小） |
| 辅助说明、KPI 小标签、脚注 | `text-il-meta`（常配 `text-text-3`） | 元数据标签、表格区次要说明 |
| 图表 X 轴 / 柱形类别标签 | `text-il-chart-axis`（常配 `text-text-3`） | 月份、税率档次等；见 §10 |
| 「即将 / 演示」角标 | `text-il-soon` | 与 `PrototypePageHeader` 角标一致 |
| 侧栏菜单 | `text-il-sidebar-parent` / `il-sidebar-child` / `il-sidebar-grand` | 仅侧栏层级菜单 |

**参考实现**：`frontend/src/components/PrototypePageHeader.tsx`（页面标题 + 说明 + 展开说明的字号组合）。

---

## 3. 字色（与字号解耦）

使用 Tailwind 语义色类，**不**为普通正文再引入一套新的 hex。

| 用途 | 类名 | 说明 |
|------|------|------|
| 主正文 | `text-text` | 标题、表格主数据、强调 ID 展示等 |
| 次级说明、标签 | `text-text-2` | 表单标签、次要句段 |
| 更弱提示、辅助信息 | `text-text-3` | 脚注、占位感说明 |
| 链接、主操作文字 | `text-accent`（可配 `hover:underline`） | 文字链、强调操作 |
| 成功态 | `text-green` | 优先与全局 token 一致 |
| 危险、错误 | `text-danger` | 删除、校验失败等 |

局部状态条（如黄底提示）可使用组件内背景色 + 配套深色字，但**段落层级**仍应优先落在 `text-text` / `text-text-2` / `text-text-3` 上。

---

## 4. 字重与行高

| 元素 | 约定 |
|------|------|
| 页面主标题、卡片标题、对话框标题 | `font-semibold` |
| 表单标签 | `font-medium` |
| 多行说明 | `text-il-page-desc` + `leading-relaxed` |
| 表格表头 | 可用 `font-semibold`；表体默认 `font-normal` |

---

## 5. 数据表格（ODS 预览、明细表等）

- **表体主文**：`text-il-page-desc`（12px）；表头标签：`text-il-label`（9px）。数据概览页可引用 `frontend/src/components/charts/chartStyles.ts` 中的 `dataTableClasses` 常量，避免类名散落。
- **列对齐**：文本列左对齐；金额、数量、税率等数字列 **右对齐**（`tabular-nums`），便于扫读。
- **字段代码行**（如列对应的英文字段名）：`font-mono` + `text-il-meta` + `text-text-3`。

---

## 10. 图表与数据概览页（DWS / ADS 等）

**实现来源**：`frontend/src/components/charts/`（`chartStyles.ts`、`ChartSvgFrame.tsx` 及具体图表组件）。

### 10.1 字号层级（图表专用）

| 语义 | Tailwind 类 | 典型用途 |
|------|-------------|----------|
| 折线 Y 轴刻度 | `text-il-label` + `text-text-3` + `tabular-nums` | 0、25、50、75、100 等 |
| 折线 X 轴 / 柱形类别 | `text-il-chart-axis` + `text-text-3` | 月份、税率档次等 |
| 图例、口径说明 | `text-il-meta` + `text-text-3` | 卡片下方 hint、系列图例 |
| 同页明细表 | 见 §5 | 与图表配套，表体 12px、表头 9px |

**禁止**：在 SVG 内使用 `<text>` 或 `text-[Npx]` 绘制坐标轴——`viewBox` 缩放会导致字号漂移。应使用 `ChartSvgFrame` 的 HTML overlay。

### 10.2 布局与尺寸

| 常量 | 值 | 说明 |
|------|-----|------|
| `CHART_BAR_MAX_PX` | 120 | 简易柱形图单柱最大高度 |
| `CHART_BAR_STRIP_CLASS` | `h-40` | 柱形图容器高度 |
| `CHART_TREND_LAYOUT` | 640×200 + pad | 折线图 viewBox，与 `ChartSvgFrame` 一致 |

柱形高度计算使用 `barHeightPx(value, max)`，勿在各页面复制魔法数字。

### 10.3 同页结构约定（数据概览）

推荐顺序：**筛选 Card → 折线/趋势 Card → 柱形/分布 Card → 明细表 Card**。筛选胶囊按钮使用 `filterPillClasses`。

### 10.4 Code Review 补充（图表）

- [ ] 坐标轴文字是否通过 `chartTypography` / `ChartSvgFrame`，而非 SVG `<text>`？
- [ ] 是否使用 `text-il-chart-axis` 而非 `text-[10px]`？
- [ ] 柱形图是否使用 `barHeightPx` 与 `CHART_BAR_MAX_PX`？
- [ ] 新增图表组件是否放在 `components/charts/` 并更新本文档？

---

## 6. 允许的例外与收敛策略

| 情况 | 处理方式 |
|------|----------|
| `Card` 的 `compact` 模式曾使用 `text-[14px]` | 新代码优先改为 `il-*`；若与原型必须一致，在后续重构中并入 token，不在新页面复制该模式。 |
| 历史页面存在大量 `text-[Npx]` | 修改该文件时 **顺带** 将触及区域改为 token；不强制一次性全仓库替换。 |

---

## 7. 文案与字体的关系

中文文案集中在 `frontend/src/copy/zh-CN.ts`，组件内用 `t.xxx` 引用。**字体类只决定样式，不替代文案集中管理。**

---

## 8. Code Review 快速清单

- [ ] 新增/修改的 UI 是否优先使用 `il-*` 字号？
- [ ] 是否避免出现新的 `text-[10px]`～`text-[16px]` 任意类（除非本节例外）？
- [ ] 字色是否使用 `text-text` / `text-text-2` / `text-text-3` / `accent` / `danger` / `green`？
- [ ] ID、路径、字段名是否使用 `font-mono`？
- [ ] 表格数字列是否右对齐？
- [ ] 图表页是否遵循 `docs/frontend-typography.md` §10 与 `components/charts/chartStyles.ts`？
- [ ] 改动页面是否已对照 `invoicelens.html` 或产品截图做视觉核对（见 `.cursor/rules/ui-prototype-selfcheck.mdc`）？

---

## 9. 修订流程

调整字号刻度或新增 `il-*` 时：

1. 修改 `frontend/tailwind.config.ts` 并更新本文档第 2 节表格。
2. 若与 HTML 原型 `invoicelens.html`  intentionally 对齐，在 PR 说明中注明对照关系。
3. 运行 `frontend/` 下 `npm run build` 确保通过。

---

**文档版本**：与仓库内 `tailwind.config.ts` 中 `il-*` 定义同步维护；若二者冲突，以 **`tailwind.config.ts` 为准** 并应修正本文档。
