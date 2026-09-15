# dsh-sql-tool 安装后重启 DSH web
Start-Sleep -Seconds 6
Write-Output "重启: 停止旧进程..."
Stop-Process -Id 9568 -Force -ErrorAction SilentlyContinue
Stop-Process -Id 8080 -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Write-Output "重启: 启动 dsh web..."
Start-Process -FilePath "C:\Users\Administrator\AppData\Roaming\npm\dsh.cmd" -ArgumentList "web","--no-open" -WindowStyle Hidden
Write-Output "重启: 完成"
