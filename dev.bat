@echo off
REM chcp 65001 + UTF-8 BOM file + ASCII-only "start" titles (fixes GBK cmd garble / broken commands)
chcp 65001 >nul 2>&1
setlocal EnableExtensions
cd /d "%~dp0"

set "INVOICELENS_LOCAL_API_HOST=127.0.0.1"
set "INVOICELENS_LOCAL_API_PORT=8765"

if /i "%~1"=="" goto :all
if /i "%~1"=="all" goto :all
if /i "%~1"=="api" goto :api
if /i "%~1"=="web" goto :web
if /i "%~1"=="ui" goto :ui
if /i "%~1"=="restart-web" goto :restart_web
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
echo   dev.bat              Default: new window Local API + this window Vite
echo   dev.bat all          Same as default
echo   dev.bat api          Local API only (keep window open for ODS import)
echo   dev.bat web          Vite only (start api in another window first)
echo   dev.bat ui           python main.py
echo   dev.bat restart-web  Kill 5173-5175 listeners, start Vite in new window
echo   dev.bat help         Show this help
echo.
echo First time: pip install -r requirements.txt   and   cd frontend ^&^& npm install
echo.
goto :eof

:all
echo [InvoiceLens] Starting Local API in a new window (leave it open^).
REM start 的首个引号内必须是纯 ASCII 标题，否则在 GBK cmd 下易乱码并截断后续命令
start "InvoiceLens-LocalAPI" cmd /k "cd /d ""%~dp0"" && set INVOICELENS_LOCAL_API_HOST=127.0.0.1&& set INVOICELENS_LOCAL_API_PORT=8765&& python -m src.local_api.sheet_mapping_server"
timeout /t 2 /nobreak >nul
echo [InvoiceLens] Starting Vite in this window. Open the URL shown below in your browser.
cd /d "%~dp0frontend"
call npm run dev
exit /b %ERRORLEVEL%

:api
echo.
echo [InvoiceLens] Local API starting... Keep this window open when you see listening.
echo [InvoiceLens] If deps missing: pip install -r requirements.txt  (from repo root^)
echo.
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

start "InvoiceLens-Vite" cmd /k "cd /d ""%~dp0frontend"" && title InvoiceLens Dev (%PORT%) && npm.cmd run dev -- --host 127.0.0.1 --port %PORT%"
echo.
echo Vite start requested. Open: http://127.0.0.1:%PORT%/
echo.
pause
exit /b 0
