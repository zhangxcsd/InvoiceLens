@echo off
REM chcp 65001 + UTF-8 env + ASCII-only "start" titles (fixes cmd garble / broken commands)
chcp 65001 >nul 2>&1
setlocal EnableExtensions
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONLEGACYWINDOWSSTDIO=utf-8"

set "INVOICELENS_LOCAL_API_HOST=127.0.0.1"
set "INVOICELENS_LOCAL_API_PORT=8765"

if /i "%~1"=="" goto :all
if /i "%~1"=="all" goto :all
if /i "%~1"=="api" goto :api
if /i "%~1"=="web" goto :web
if /i "%~1"=="ui" goto :ui
if /i "%~1"=="restart-web" goto :restart_web
if /i "%~1"=="smoke-local-api" goto :smoke_local_api
if /i "%~1"=="smoke-tree-ui" goto :smoke_tree_ui
if /i "%~1"=="smoke-tree-report" goto :smoke_tree_report
if /i "%~1"=="encoding-smoke" goto :encoding_smoke
if /i "%~1"=="check-api-port" goto :check_api_port
if /i "%~1"=="kill-api-port" goto :kill_api_port
if /i "%~1"=="smoke" goto :smoke_all
if /i "%~1"=="help" goto :usage_ok
if /i "%~1"=="-h" goto :usage_ok
if /i "%~1"=="--help" goto :usage_ok

echo Unknown command: %~1
goto :usage_bad

:usage_ok
call :usage_body
exit /b 0

:usage_bad
call :usage_body
exit /b 1

:usage_body
echo.
echo InvoiceLens dev entry (merged: start_dev / start_local_api / start_ui / restart_frontend_dev)
echo.
echo   dev.bat              Default: ONE window — Local API :8765 + Vite :5173 ^(npm run dev:with-api^)
echo   dev.bat all          Same as default
echo   dev.bat api          Local API only (keep window open for ODS import)
echo   dev.bat web          Vite only ^(不推荐：易导致 /api 无 8765 监听^)
echo   dev.bat ui           python main.py
echo   dev.bat restart-web  Kill 5173-5175 listeners, start Vite in new window
echo   dev.bat smoke-local-api  Run local API lock/socket smoke regression
echo   dev.bat smoke-tree-ui  Run tree UI regression (Playwright)
echo   dev.bat smoke-tree-report  Open latest tree UI Playwright report
echo   dev.bat encoding-smoke  Run UTF-8 / terminal / API encoding smoke
echo   dev.bat check-api-port  Exit 0 if 8765 is free; 1 if in use / duplicate listeners
echo   dev.bat kill-api-port   taskkill all LISTENING PIDs on 8765 ^(then run dev.bat api^)
echo   dev.bat smoke          Run smoke-local-api + smoke-tree-ui
echo   dev.bat help         Show this help
echo.
echo First time: pip install -r requirements.txt   and   cd frontend ^&^& npm install
echo.
goto :eof

:all
REM 默认单窗口同时起 Local API + Vite，从流程上避免「只起了前端、8765 无监听」导致 /api ECONNREFUSED / 代理 502。
if not exist "%~dp0frontend\package.json" (
  echo [ERROR] frontend\package.json not found. Keep dev.bat in repo root.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd not found. Install Node.js.
  pause
  exit /b 1
)
if not exist "%~dp0frontend\node_modules" (
  echo [InvoiceLens] frontend\node_modules 缺失，正在 npm install ^(首次需联网^)...
  cd /d "%~dp0frontend"
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  cd /d "%~dp0"
) else if not exist "%~dp0frontend\node_modules\.bin\concurrently.cmd" (
  echo [InvoiceLens] 前端依赖不完整（缺少 concurrently），正在 npm install ...
  cd /d "%~dp0frontend"
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  cd /d "%~dp0"
)

echo [InvoiceLens] Pre-clean listeners on 8765 / 5173-5175 ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8765 .*LISTENING"') do (
  echo   taskkill /PID %%P /F   port 8765
  taskkill /PID %%P /F >nul 2>nul
)
for %%L in (5173 5174 5175) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%%L .*LISTENING"') do (
    echo   taskkill /PID %%P /F   port %%L
    taskkill /PID %%P /F >nul 2>nul
  )
)
timeout /t 1 /nobreak >nul

echo.
echo ============================================================
echo   InvoiceLens 开发环境（单窗口）
echo   Local API http://127.0.0.1:8765  +  Vite http://127.0.0.1:5173
echo   请保持本窗口运行；结束开发请在本窗口按 Ctrl+C
echo ============================================================
echo.

cd /d "%~dp0frontend"
call npm.cmd run dev:with-api
set "IL_EXIT=%ERRORLEVEL%"
cd /d "%~dp0"
if not "%IL_EXIT%"=="0" (
  echo.
  echo [InvoiceLens] 已退出（错误码 %IL_EXIT%）。若为主动 Ctrl+C 可直接关闭窗口。
  pause
)
exit /b %IL_EXIT%

:api
echo.
echo [InvoiceLens] Local API starting... Keep this window open when you see listening.
echo [InvoiceLens] If deps missing: pip install -r requirements.txt  (from repo root^)
echo.
echo [InvoiceLens] Pre-clean listeners on 8765...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8765 .*LISTENING"') do (
  echo   taskkill /PID %%P /F   port 8765
  taskkill /PID %%P /F >nul 2>nul
)
timeout /t 1 /nobreak >nul
python -m src.local_api.sheet_mapping_server
if errorlevel 1 (
  echo.
  echo [InvoiceLens] Failed to start. Run this script from repo root and install Python deps.
  pause
)
exit /b %ERRORLEVEL%

:web
echo [InvoiceLens] Vite only...
cd /d "%~dp0frontend"
call npm run dev
exit /b %ERRORLEVEL%

:ui
python main.py
pause
exit /b %ERRORLEVEL%

:restart_web
set "PORT=5173"
set "PORTS_TO_CLEAN=5173 5174 5175"

echo.
echo [restart-web] Stopping listeners on ports: %PORTS_TO_CLEAN% ...
for %%L in (%PORTS_TO_CLEAN%) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%%L .*LISTENING"') do (
    echo   taskkill /PID %%P /F   port %%L
    taskkill /PID %%P /F >nul 2>nul
  )
)

echo.
echo [restart-web] Starting Vite in a new window...
if not exist "%~dp0frontend\package.json" (
  echo [ERROR] frontend\package.json not found. Run this .bat from repo root.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd not found. Install Node.js or add npm to PATH.
  pause
  exit /b 1
)

start "InvoiceLens-Vite" cmd /k "chcp 65001>nul && cd /d ""%~dp0frontend"" && title InvoiceLens Dev (%PORT%) && npm.cmd run dev -- --host 127.0.0.1 --port %PORT%"
echo.
echo Vite start requested. Open: http://127.0.0.1:%PORT%/
echo.
pause
exit /b 0

:check_api_port
python -m src.local_api.listen_port_probe
exit /b %ERRORLEVEL%

:kill_api_port
echo.
echo [InvoiceLens] Killing listeners on port %INVOICELENS_LOCAL_API_PORT% ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%INVOICELENS_LOCAL_API_PORT% .*LISTENING"') do (
  echo   taskkill /PID %%P /F   port %INVOICELENS_LOCAL_API_PORT%
  taskkill /PID %%P /F >nul 2>nul
)
timeout /t 1 /nobreak >nul
python -m src.local_api.listen_port_probe
if errorlevel 1 (
  echo [InvoiceLens] Port still not clean; check netstat manually.
  exit /b 1
)
echo [InvoiceLens] Port is free.
exit /b 0

:smoke_local_api
echo.
echo [InvoiceLens] Running local API dim-tax-code smoke regression...
python scripts\_smoke_local_api_dim_tax_lock.py
if errorlevel 1 (
  echo.
  echo [InvoiceLens] Smoke regression FAILED.
  pause
  exit /b 1
)
echo.
echo [InvoiceLens] Smoke regression PASSED.
exit /b 0

:smoke_tree_ui
echo.
echo [InvoiceLens] Running tree UI regression (Playwright)...
cd /d "%~dp0frontend"
call npm run test:tree-regression
if errorlevel 1 (
  echo.
  echo [InvoiceLens] Tree UI regression FAILED.
  pause
  exit /b 1
)
echo.
echo [InvoiceLens] Tree UI regression PASSED.
exit /b 0

:smoke_tree_report
echo.
echo [InvoiceLens] Opening tree UI regression report...
cd /d "%~dp0frontend"
call npm run test:tree-regression:report
exit /b %ERRORLEVEL%

:encoding_smoke
echo.
echo [InvoiceLens] Running encoding smoke...
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\encoding_smoke.ps1" -Fix
exit /b %ERRORLEVEL%

:smoke_all
call "%~f0" encoding-smoke
if errorlevel 1 exit /b 1
call "%~f0" smoke-local-api
if errorlevel 1 exit /b 1
call "%~f0" smoke-tree-ui
exit /b %ERRORLEVEL%
