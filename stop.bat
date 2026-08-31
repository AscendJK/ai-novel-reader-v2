@echo off
setlocal
cd /d "%~dp0"

echo Stopping AI Novel Reader (server + TTS inference)...
echo.

REM 清理残留：本项目 node 进程 + Python TTS 推理进程(tts-worker.py) + 端口兜底
REM 精确匹配命令行，不误杀其他项目的 node/python。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cleanup-processes.ps1"

echo.
echo Done.
pause
endlocal
exit /b 0
