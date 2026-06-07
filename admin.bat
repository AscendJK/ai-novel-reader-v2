@echo off
cd /d "%~dp0"

echo ===== AI Novel Reader - Admin =====
echo.

where node >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] Node.js not found. && pause && exit /b 1 )

if not exist "node_modules\" ( echo Installing deps... && call npm install )

set ADMIN_PORT=5173

if exist "dist\index.html" (
    echo Mode: Production
    REM Kill any existing process on port 5173 (could be Vite dev server)
    for /f "tokens=5" %%a in ('powershell -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"') do (
        echo Stopping old instance on port 5173 PID %%a ...
        taskkill /PID %%a /F >nul 2>&1
    )
    echo Starting production server...
    powershell -Command "Start-Process -FilePath 'cmd' -ArgumentList '/c cd /d %~dp0 && node server/index.js --full > server\server.log 2>&1' -WindowStyle Hidden"
    timeout /t 3 /nobreak >nul
) else (
    echo Mode: Development
    set ADMIN_PORT=3001
    powershell -Command "$c=Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select -First 1; if(-not $c){ Start-Process -FilePath 'cmd' -ArgumentList '/c node server/index.js' -WindowStyle Hidden; Start-Sleep 1 }"
    powershell -Command "$c=Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select -First 1; if(-not $c){ Start-Process -FilePath 'cmd' -ArgumentList '/c npx vite --host 0.0.0.0 --port 5173' -WindowStyle Hidden; Start-Sleep 2 }"
)

set TOKEN=
if exist "server\data\.admin_token" set /p TOKEN=<"server\data\.admin_token"
set URL=http://localhost:%ADMIN_PORT%/admin?token=%TOKEN%
echo Opening: %URL%
start "" "%URL%"
echo Token: %TOKEN%
pause
