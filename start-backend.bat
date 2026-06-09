@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===== AI Novel Reader - Backend =====
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

echo.
echo Starting server...
echo Backend running at: http://0.0.0.0:5173
echo Admin panel: http://localhost:5173/admin
echo.
echo Open https://ascendjk.github.io/ai-novel-reader-v2/ and enter your backend address.
echo Press Ctrl+C to stop the server.
echo.
node server/index.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server failed to start. Check if port 5173 is already in use.
    echo.
    pause
)
