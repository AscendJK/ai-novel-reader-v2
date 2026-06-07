@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Stopping AI Novel Reader...
echo.

REM Kill processes on port 8443 (HTTPS)
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8443 ^| findstr LISTENING') do (
    if not defined FOUND (
        echo Stopping HTTPS server on port 8443 (PID %%a)
        taskkill /PID %%a /F >nul 2>&1
        set "FOUND=1"
    )
)

REM Kill processes on port 5173 (HTTP)
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    if not defined FOUND (
        echo Stopping HTTP server on port 5173 (PID %%a)
        taskkill /PID %%a /F >nul 2>&1
        set "FOUND=1"
    )
)

REM Kill processes on port 3001 (Dev API)
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    if not defined FOUND (
        echo Stopping API server on port 3001 (PID %%a)
        taskkill /PID %%a /F >nul 2>&1
        set "FOUND=1"
    )
)

echo.
echo Done.
pause
endlocal
