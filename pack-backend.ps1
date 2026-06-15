# 后端精简包打包脚本
# 用法: powershell -ExecutionPolicy Bypass -File pack-backend.ps1

$ErrorActionPreference = "Stop"

# 清理旧的临时目录和压缩包
if (Test-Path "backend-pack-tmp") { Remove-Item -Recurse -Force "backend-pack-tmp" }
if (Test-Path "release-backend.zip") { Remove-Item -Force "release-backend.zip" }

# 创建目录结构
New-Item -ItemType Directory -Force -Path "backend-pack-tmp\server\routes" | Out-Null
New-Item -ItemType Directory -Force -Path "backend-pack-tmp\server\middleware" | Out-Null
New-Item -ItemType Directory -Force -Path "backend-pack-tmp\server\lib" | Out-Null

# 复制服务器核心文件
$serverFiles = @(
    "server\index.js",
    "server\database.js",
    "server\admin.js",
    "server\admin.html",
    "server\rag-builder.js",
    "server\rag-worker.mjs",
    "server\sync-handler.js"
)
foreach ($f in $serverFiles) {
    Copy-Item $f "backend-pack-tmp\server\"
}

# 复制目录
Copy-Item "server\routes\*.js" "backend-pack-tmp\server\routes\"
Copy-Item "server\middleware\*.js" "backend-pack-tmp\server\middleware\"
Copy-Item "server\lib\engine-config.js" "backend-pack-tmp\server\lib\"

# 复制并重命名配置和脚本
Copy-Item "package-server.json" "backend-pack-tmp\package.json"
Copy-Item "start-backend.bat" "backend-pack-tmp\start.bat"
Copy-Item "start-backend.sh" "backend-pack-tmp\start.sh"
Copy-Item "admin-backend.bat" "backend-pack-tmp\admin.bat"
Copy-Item "admin-backend.sh" "backend-pack-tmp\admin.sh"

# 压缩
Compress-Archive -Path "backend-pack-tmp\*" -DestinationPath "ai-novel-reader-v2-backend.zip" -Force

# 清理临时目录
Remove-Item -Recurse -Force "backend-pack-tmp"

# 显示结果
$file = Get-Item "ai-novel-reader-v2-backend.zip"
Write-Host "打包完成: ai-novel-reader-v2-backend.zip ($([math]::Round($file.Length / 1KB))KB)" -ForegroundColor Green
