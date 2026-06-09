@echo off
cd /d "%~dp0"

echo ===== AI Novel Reader - Admin =====
echo.

where node >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] Node.js not found. && pause && exit /b 1 )

if not exist "node_modules\" ( echo Installing deps... && call npm install )

REM Check if server is already running on port 5173
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1" | findstr "5173" >nul 2>&1
if %errorlevel% neq 0 (
    echo Starting server...
    powershell -Command "Start-Process -FilePath 'cmd' -ArgumentList '/c cd /d %~dp0 && node server/index.js > server\server.log 2>&1' -WindowStyle Hidden"
    timeout /t 3 /nobreak >nul
    echo Server started.
) else (
    echo Server already running on port 5173.
)

set TOKEN=
if exist "server\data\.admin_token" set /p TOKEN=<"server\data\.admin_token"
set URL=http://localhost:5173/admin?token=%TOKEN%
echo.
echo Opening: %URL%
echo Token: %TOKEN%
echo.
start "" "%URL%"
pause
