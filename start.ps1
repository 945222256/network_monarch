$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "清理 Vite 缓存..." -ForegroundColor Yellow
if (Test-Path "$ScriptPath\network_monarch_ui\node_modules\.vite") {
    Remove-Item -Recurse -Force "$ScriptPath\network_monarch_ui\node_modules\.vite"
}

Write-Host "启动 Network Monarch 后端 (需要管理员权限)..." -ForegroundColor Cyan
Start-Process powershell -Verb RunAs -ArgumentList "-NoExit -Command `"cd '$ScriptPath\monarch_probe'; cargo run`""

Write-Host "启动 Network Monarch 前端..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"cd '$ScriptPath\network_monarch_ui'; npx tauri dev`""

Write-Host "所有进程已启动。请在弹出的窗口中查看日志！" -ForegroundColor Green
