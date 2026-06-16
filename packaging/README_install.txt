InvoiceLens 离线审计分析（Windows 安装版）
============================================

启动
----
- 从开始菜单打开「InvoiceLens」，或运行安装目录下的 InvoiceLens.exe。
- 浏览器访问：http://127.0.0.1:8765/
- 默认登录：空账号一键登录，或 admin / admin

数据目录
--------
- 程序工作目录为安装路径（与 InvoiceLens.exe 同级）。
- 首次运行会在该目录下自动创建 data/（DuckDB、用户、会话、授权等）。
- 请勿删除或覆盖 data/ 除非您已备份。

日志
----
- 应用日志：data/logs/invoicelens.log

授权
----
- 生产授权文件：data/config/license.lic（RSA 验签）
- 开发覆盖（仅内网调试）：data/config/license_override.json
- 内置公钥：config/license_public.pem（随 exe 打包，勿单独修改）

端口
----
- 默认本地 API 端口：8765
- 可通过环境变量 INVOICELENS_LOCAL_API_PORT 修改

卸载
----
- 控制面板 → 程序和功能 → InvoiceLens → 卸载
- 卸载不会自动删除 data/；如需彻底移除请手动删除安装目录
