@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===== AI Novel Reader =====
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    pause
    exit /b 1
)

REM Extract major version number (e.g., v18.20.4 -> 18)
for /f "tokens=1 delims=." %%a in ('node -v') do set "NODE_VER_FULL=%%a"
set "NODE_VER=%NODE_VER_FULL:v=%"

REM Check version range: only 18-22 supported
if !NODE_VER! lss 18 (
    echo [ERROR] Node.js !NODE_VER! is too old. Please use 18-22 LTS.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)
if !NODE_VER! gtr 22 (
    echo [ERROR] Node.js !NODE_VER! is not supported. Please use 18-22 LTS.
    echo Node.js 23+ has breaking changes that are not compatible.
    pause
    exit /b 1
)

echo Node.js version: !NODE_VER! [OK]

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
