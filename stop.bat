@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Stopping AI Novel Reader...
echo.

REM Helper: kill Node.js process on a specific port using PowerShell
call :killNodeOnPort 8443 "HTTPS server"
call :killNodeOnPort 5173 "HTTP server"
call :killNodeOnPort 5174 "Vite dev server"

echo.
echo Done.
pause
endlocal
exit /b 0

:killNodeOnPort
set "PORT=%~1"
set "NAME=%~2"
set "FOUND="
REM Use PowerShell for reliable cross-locale port detection
for /f "tokens=*" %%a in ('powershell -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"') do (
    if not defined FOUND (
        REM Verify it's a Node.js process before killing
        tasklist /FI "PID eq %%a" 2>nul | findstr /I "node.exe" >nul 2>&1
        if !errorlevel! equ 0 (
            echo Stopping %NAME% on port %PORT% (PID %%a)
            taskkill /PID %%a /F >nul 2>&1
            set "FOUND=1"
        ) else (
            echo Skipping non-Node.js process on port %PORT% (PID %%a)
        )
    )
)
if not defined FOUND (
    echo No %NAME% running on port %PORT%
)
exit /b 0
