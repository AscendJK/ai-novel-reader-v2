# 后端精简包打包脚本（跨平台：Windows PowerShell / macOS / Linux pwsh）
# 用法:
#   Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File pack-backend.ps1
#   跨平台:   pwsh -File pack-backend.ps1
#   或:       npm run pack:backend

$ErrorActionPreference = "Stop"

# 基于脚本所在目录，保证从任意工作目录运行都正确
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

# 清理旧的临时目录和压缩包
if (Test-Path "backend-pack-tmp") { Remove-Item -Recurse -Force "backend-pack-tmp" }
# 清理历史遗留的旧文件名和当前实际输出文件
if (Test-Path "release-backend.zip") { Remove-Item -Force "release-backend.zip" }
if (Test-Path "ai-novel-reader-v2-backend.zip") { Remove-Item -Force "ai-novel-reader-v2-backend.zip" }

# 创建目录结构
New-Item -ItemType Directory -Force -Path "backend-pack-tmp/server/routes" | Out-Null
New-Item -ItemType Directory -Force -Path "backend-pack-tmp/server/middleware" | Out-Null
New-Item -ItemType Directory -Force -Path "backend-pack-tmp/server/lib" | Out-Null
New-Item -ItemType Directory -Force -Path "backend-pack-tmp/scripts" | Out-Null

# 复制服务器核心文件
$serverFiles = @(
    "server/index.js",
    "server/database.js",
    "server/admin.js",
    "server/admin.html",
    "server/rag-builder.js",
    "server/rag-worker.mjs",
    "server/sync-handler.js",
    "server/tts-worker.py"
)
foreach ($f in $serverFiles) {
    Copy-Item $f "backend-pack-tmp/server/"
}

# 复制目录
Copy-Item "server/routes/*.js" "backend-pack-tmp/server/routes/"
Copy-Item "server/middleware/*.js" "backend-pack-tmp/server/middleware/"
Copy-Item "server/lib/engine-config.js" "backend-pack-tmp/server/lib/"

# 复制并重命名配置和脚本
# 后端包版本号跟随主 package.json（单一事实来源），避免前后端版本不一致
node -e "const fs=require('fs');const main=JSON.parse(fs.readFileSync('package.json','utf8'));const pkg=JSON.parse(fs.readFileSync('package-server.json','utf8'));pkg.version=main.version;fs.writeFileSync('backend-pack-tmp/package.json',JSON.stringify(pkg,null,2)+'\n');"
Copy-Item "start-backend.bat" "backend-pack-tmp/start.bat"
Copy-Item "start-backend.sh" "backend-pack-tmp/start.sh"
Copy-Item "admin-backend.bat" "backend-pack-tmp/admin.bat"
Copy-Item "admin-backend.sh" "backend-pack-tmp/admin.sh"
Copy-Item "README-BACKEND.txt" "backend-pack-tmp/README.txt"

# 停止脚本 + 进程清理脚本：start.bat/start.sh 启动前会自动清理残留，
# 用户也可运行 stop.bat/stop.sh 手动停止（杀 node + python tts-worker）
Copy-Item "stop.bat" "backend-pack-tmp/stop.bat"
Copy-Item "stop.sh" "backend-pack-tmp/stop.sh"
Copy-Item "scripts/cleanup-processes.ps1" "backend-pack-tmp/scripts/cleanup-processes.ps1"
Copy-Item "scripts/cleanup-processes.sh" "backend-pack-tmp/scripts/cleanup-processes.sh"

# 压缩
Compress-Archive -Path "backend-pack-tmp/*" -DestinationPath "ai-novel-reader-v2-backend.zip" -Force

# 清理临时目录
Remove-Item -Recurse -Force "backend-pack-tmp"

# 显示结果
$file = Get-Item "ai-novel-reader-v2-backend.zip"
Write-Host "打包完成: ai-novel-reader-v2-backend.zip ($([math]::Round($file.Length / 1KB))KB)" -ForegroundColor Green
