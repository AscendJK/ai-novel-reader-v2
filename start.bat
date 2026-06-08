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

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
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
    echo [ERROR] Server failed to start. Check if ports 8443 or 5173 are already in use.
    echo.
    pause
)
