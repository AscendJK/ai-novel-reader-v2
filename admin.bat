@echo off
cd /d "%~dp0"

echo ===== AI Novel Reader - Admin =====
echo.

where node >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] Node.js not found. && pause && exit /b 1 )

if not exist "node_modules\" ( echo Installing deps... && call npm install )

set ADMIN_PORT=5173

REM Check if server is already running on port 5173
powershell -Command "$c=Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select -First 1; if(-not $c){ exit 1 } else { exit 0 }"
if %errorlevel% neq 0 (
    echo Starting server...
    powershell -Command "Start-Process -FilePath 'cmd' -ArgumentList '/c node server/index.js' -WindowStyle Hidden"
    timeout /t 2 /nobreak >nul
)

set TOKEN=
if exist "server\data\.admin_token" set /p TOKEN=<"server\data\.admin_token"
set URL=http://localhost:%ADMIN_PORT%/admin?token=%TOKEN%
echo Opening: %URL%
start "" "%URL%"
echo Token: %TOKEN%
pause
