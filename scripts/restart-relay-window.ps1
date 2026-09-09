# Restart the visible relay window on the current source build (same DB / public URL).
$root = 'C:\Users\info\Desktop\SES-RDP'
Set-Location $root
$url = Get-Content data\public_url.txt
$pw = Get-Content data\admin_password.txt
$db = (Resolve-Path data\relay-live.sqlite).Path
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'SES-RDP RELAY*' } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*relay\dist\cli.js*' -or $_.CommandLine -like '*rdp-relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2
$cmd = "`$Host.UI.RawUI.WindowTitle='SES-RDP RELAY (source build)'; cd '$root'; `$env:PORT='3000'; `$env:PUBLIC_URL='$url'; `$env:TRUST_PROXY='true'; `$env:SES_RDP_ADMIN_PASSWORD='$pw'; `$env:SES_RDP_SESSION_SECRET='visual-session-secret'; `$env:SES_RDP_DB='$db'; node packages\relay\dist\cli.js"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmd
