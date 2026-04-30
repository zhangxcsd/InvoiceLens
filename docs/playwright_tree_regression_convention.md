# Playwright 树形回归约定

## 适用范围

- 用于 `frontend/tests/tree-regression.spec.ts` 及同类截图回归用例。
- 目标：降低用例脆弱性，避免因文案/布局微调导致误报。

## 核心约定

- **优先使用稳定锚点**
  - 页面结构定位优先 `data-testid`，避免 `section + hasText` 这类易受文案影响的选择器。
  - 当前税收分类页锚点：`tax-tree-panel`、`tax-list-panel`。

- **避免依赖侧栏点击链路**
  - 回归测试优先使用 `/?nav=xxx` 直接进入目标页面，减少菜单文案和展开状态变化带来的不稳定。

- **截图断言只校验目标区域**
  - `toHaveScreenshot` 针对核心容器，而非整个页面。
  - 允许适度阈值（如 `maxDiffPixelRatio: 0.05`）以吸收系统渲染差异。

- **动态数据不写死断言**
  - 层级、总数、筛选结果等随数据变化的值，优先用“相对断言”（例如等于当前 `max`），不要写死固定数字。

- **文案必须与产品当前版本一致**
  - 例如 `仅看敏感类目`、`展开全部` 等，统一从 `zh-CN.ts` 语义出发，避免旧文案残留。

## 常见失败与处理

- **浏览器缺失**
  - 现象：`Executable doesn't exist ...`
  - 处理：在 `frontend/` 执行 `npx playwright install chromium`。

- **截图基线不存在或需更新**
  - 现象：`A snapshot doesn't exist ... writing actual`
  - 处理：执行 `npm run test:tree-regression:update`，再执行 `npm run test:tree-regression` 复验。

- **定位器超时**
  - 优先检查：
    - 是否仍依赖旧文案/旧按钮；
    - 是否可替换为 `data-testid`；
    - 是否可直接 `nav` 跳转目标页。

## 推荐执行顺序

```bash
cd frontend
npx playwright install chromium
npm run test:tree-regression:update   # 首次或基线变更时
npm run test:tree-regression
```

