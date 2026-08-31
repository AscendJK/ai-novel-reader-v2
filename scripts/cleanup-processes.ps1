# 清理 AI Novel Reader 残留进程（Windows / PowerShell）
# 被 start.bat / start-backend.bat / stop.bat 调用（含打包后端包内的 start.bat）
#
# 清理对象（精确匹配，避免误杀其他项目的 node/python）：
#   1. Node.js 进程：命令行含 server\index.js 或本项目路径（前端 dev / 后端服务）
#   2. Python 进程：命令行含 tts-worker.py（服务端 TTS 推理常驻进程）
#   3. 兜底：占用本项目端口 (8443/5173/5174) 的 node.exe 进程
$ErrorActionPreference = "SilentlyContinue"

$proj = [regex]::Escape((Get-Location).Path)
$ports = 8443, 5173, 5174
$targets = New-Object System.Collections.Generic.List[object]

# 端口兜底：收集占用项目端口的进程 PID（稍后验证是 node 才杀）
$portPids = @()
foreach ($p in $ports) {
  $own = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
  if ($own) { $portPids += [int]$own }
}

foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
  $cmd = [string]$proc.CommandLine
  # 排除清理脚本自身（命令行含本项目路径会匹配到自己）
  if ($cmd -match "cleanup-processes") { continue }
  $isNode = $proc.Name -eq "node.exe"
  $isPy = $proc.Name -eq "python.exe" -or $proc.Name -eq "python3.exe"
  $match = $false
  if ($isNode -and ($cmd -match "server[\\/]index\.js" -or $cmd -match $proj)) { $match = $true }
  elseif ($isPy -and $cmd -match "tts-worker\.py") { $match = $true }
  if ($match) { $targets.Add($proc) }
}

# 端口兜底：端口被 node 占用但上面未匹配到（如自定义启动方式）也清理
foreach ($pid2 in $portPids) {
  if ($pid2 -and -not ($targets | Where-Object { $_.ProcessId -eq $pid2 })) {
    $p2 = Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue
    if ($p2 -and $p2.Name -eq "node.exe") { $targets.Add($p2) }
  }
}

$seen = @{}
foreach ($t in $targets) {
  if (-not $seen.ContainsKey($t.ProcessId)) {
    $seen[$t.ProcessId] = $true
    Write-Host ("  Stopping {0} PID {1}" -f $t.Name, $t.ProcessId)
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
if ($targets.Count -eq 0) { Write-Host "  No leftover processes found." }
