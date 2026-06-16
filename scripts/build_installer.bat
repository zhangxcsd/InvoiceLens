@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set SKIP_PYINSTALLER=0
if /I "%~1"=="--skip-pyinstaller" set SKIP_PYINSTALLER=1

if "%SKIP_PYINSTALLER%"=="0" (
  if not exist "dist\InvoiceLens.exe" (
    echo [build_installer] dist\InvoiceLens.exe not found — running PyInstaller...
    pyinstaller invoicelens.spec --noconfirm
    if errorlevel 1 (
      echo [build_installer] PyInstaller failed.
      exit /b 1
    )
  ) else (
    echo [build_installer] Using existing dist\InvoiceLens.exe
  )
) else (
  echo [build_installer] Skipping PyInstaller (--skip-pyinstaller)
  if not exist "dist\InvoiceLens.exe" (
    echo [build_installer] ERROR: dist\InvoiceLens.exe missing. Build it first or omit --skip-pyinstaller.
    exit /b 1
  )
)

where iscc >nul 2>&1
if errorlevel 1 (
  echo.
  echo [build_installer] Inno Setup Compiler ^(iscc^) not found in PATH.
  echo Install Inno Setup 6+ from https://jrsoftware.org/isinfo.php
  echo Then add the installation folder ^(e.g. C:\Program Files ^(x86^)\Inno Setup 6^) to PATH,
  echo or run manually:
  echo   "C:\Program Files ^(x86^)\Inno Setup 6\ISCC.exe" packaging\InvoiceLens.iss
  echo.
  exit /b 2
)

echo [build_installer] Running iscc packaging\InvoiceLens.iss ...
iscc packaging\InvoiceLens.iss
if errorlevel 1 (
  echo [build_installer] Inno Setup compile failed.
  exit /b 1
)

echo [build_installer] Done. Setup output: dist\InvoiceLens-Setup.exe
exit /b 0
