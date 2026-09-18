@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===== AI Novel Reader (Full Bundle) =====
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

if !NODE_VER! lss 18 (
    echo [ERROR] Node.js !NODE_VER! is too old. Please use 18-22 LTS.
    pause
    exit /b 1
)
if !NODE_VER! gtr 22 (
    echo [ERROR] Node.js !NODE_VER! is not supported. Please use 18-22 LTS.
    pause
    exit /b 1
)

echo Node.js version: !NODE_VER! [OK]

echo.
echo Cleaning up leftover processes from previous runs...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cleanup-processes.ps1"
echo.

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo Starting server (full mode, frontend included)...
echo Open in browser: http://localhost:5173/ai-novel-reader-v2/
echo Press Ctrl+C to stop the server.
echo.
node server/index.js --full
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server failed to start. Check if ports 8443 or 5173 are already in use.
    echo.
    pause
)
