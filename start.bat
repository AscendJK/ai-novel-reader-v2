@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===== AI Novel Reader =====
echo.

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    pause
    exit /b 1
)

for /f "tokens=2 delims=v." %%a in ('node -v') do set "NODE_VER=%%a"
if !NODE_VER! geq 24 (
    echo Node.js 24+ is not supported. Please use 18-22 LTS.
    pause
    exit /b 1
)

:menu
echo Select launch mode:
echo   [1] Dev mode
echo   [2] Prod mode
echo   [0] Exit
echo.
set "mode="
set /p "mode=Enter choice: "
if not defined mode set "mode=1"

if "%mode%"=="0" exit /b
if "%mode%"=="1" goto dev
if "%mode%"=="2" goto prod
goto menu

:dev
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

start "Server" /MIN node server/index.js
timeout /t 2 /nobreak >nul
start "Vite" /MIN npx vite --host 0.0.0.0
echo.
echo Dev running: http://localhost:5173
echo.
pause
exit /b

:prod
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)
echo Building for production...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

rem Install SSL certificate to trusted root store
if exist "server\data\cert.pem" (
    echo Installing SSL certificate...
    certutil -addstore -f "Root" server\data\cert.pem >nul 2>&1
    if %errorlevel% equ 0 (
        echo SSL certificate installed successfully.
    ) else (
        echo [WARNING] Failed to install SSL certificate. Run as administrator if needed.
    )
)

echo.
echo Starting server...
echo Prod running: https://localhost:8443 or http://localhost:5173
echo Press Ctrl+C to stop the server.
echo.
node server/index.js --full
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server failed to start. Check if ports 443 or 5173 are already in use.
    echo.
    pause
)