@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===== AI Novel Reader - Backend =====
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

REM TTS 服务端推理依赖 Python + sherpa-onnx（可选）：缺失仅影响"服务端推理"引擎，
REM 浏览器推理与 Web Speech 不受影响。探测并提示，不阻塞启动。
set "PY_OK="
for %%C in (python python3 py) do (
    if not defined PY_OK (
        where %%C >nul 2>&1 && (
            %%C -c "import sherpa_onnx" >nul 2>&1 && set "PY_OK=1"
        )
    )
)
if not defined PY_OK (
    echo.
    echo [NOTE] Python + sherpa-onnx 未检测到（可选依赖）。
    echo   服务端推理引擎将不可用。如需使用，请安装 Python 3.9+ 后运行：
    echo     pip install sherpa-onnx
    echo   浏览器推理与 Web Speech 朗读不受影响。
    echo.
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
echo Backend running at: http://localhost:5173
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
