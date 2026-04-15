---
name: invoicelens-ui-prototype-qa
description: Enforces prototype-level UI implementation discipline for InvoiceLens web/Tauri frontend: after every UI change, run build/typecheck and perform visual parity checks against invoicelens.html (tokens, spacing, colors, icons). Use when editing frontend files (Vite/React/TypeScript/Tailwind) or when the user asks to "复刻原型" or cares about icons, typography, borders, spacing.
---

# InvoiceLens UI Prototype QA

## When to apply
- Editing `frontend/**` (React/TypeScript/Tailwind).
- Any request about “复刻原型 / 原型级 / 1:1 / 设计系统 / 字体 / 颜色 / 边框 / 图标”.

## Definition of done (must satisfy BEFORE claiming completion)
1) **Build/typecheck passes**
- Run in `frontend/`:
  - `npm run build`
- Fix all TS/lint/build errors.

2) **Visual parity check**
- Compare against `invoicelens.html` for the edited screen(s):
  - Typography: font family, size, weight, line-height, placeholder color
  - Tokens: `accent/danger/warn/green`, `text/text-2/text-3`, `border/border-light`
  - Controls: input border color, focus ring, background, radius (7/10px)
  - Layout: padding/margins, card radius/shadow, section spacing
  - Icons: app icon present and consistent (login + sidebar + favicon)

3) **Global icon consistency**
- If an app icon is changed/added, ensure it’s wired in:
  - `frontend/public/app-icon.svg`
  - `frontend/index.html` favicon + title
  - Login header logo + sidebar logo use the same asset

## Implementation notes
- Prefer **design tokens** from Tailwind config, not ad-hoc hex values (except where the prototype uses a literal and it’s intentional).
- Any non-implemented feature must be a **visual shell only** (“soon/待开发”), no backend logic unless explicitly requested.

## UI copy / 文案（集中维护，避免散落硬编码）
- **Single source of truth（中文）**：`frontend/src/copy/zh-CN.ts` 导出 `zhCN`（或在使用处 `import { zhCN as t }`）。
- **何时改文案**：优先只改 `zh-CN.ts` 中对应字段；组件里用 `t.sidebar.xxx`、`t.importUpload.xxx`、`zhCN.uploadZone.xxx` 等引用，**不要在 JSX 里直接写长句中文**（除非是极短的临时占位且尚未入库）。文件上传页：标题/说明/表单/按钮见 `importUpload`，拖拽区文案见 `uploadZone`。
- **新增页面/菜单**：先在 `zh-CN.ts` 增加键（按区块分组：`login` / `sidebar` / `importUpload` / `uploadZone` / `breadcrumb` / `shell` / `common`），再在 `.tsx` 中引用。
- **演示登录与展示名**：`login.demoUsername` / `demoPassword` / `demoDisplayName` / `demoRole` 及 `login.demoTip` 均放在 `zh-CN.ts`（凭证可为空字符串，便于一键验证；与输入框 `trim` 后的账号、原始密码字符串逐项相等即通过）；**产品英文名**用 `shell.appNameEn`（Logo 文案、`img` 的 `alt` 等）；**页签标题**用 `shell.documentTitle`（`main.tsx` 启动时写入 `document.title`）。
- **与 `invoicelens.html` 的关系**：HTML 原型仅作视觉对照；**运行中的 React 界面不会自动同步**原型里的文字，以 `zh-CN.ts` + 组件为准。
- **后续扩展**：若需要英文或多语言，可在同目录增加 `en-US.ts` 等，并在入口按语言选择对象（当前阶段单语言可仅用 `zh-CN.ts`）。

