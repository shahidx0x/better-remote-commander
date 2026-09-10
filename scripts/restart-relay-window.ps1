# Restart the visible relay window on the current source build (same DB / public URL).
$root = 'C:\Users\info\Desktop\Better Remote Commander (BRC)'
Set-Location $root
$url = Get-Content data\public_url.txt
$pw = Get-Content data\admin_password.txt
$db = (Resolve-Path data\relay-live.sqlite).Path
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Better Remote Commander (BRC) RELAY*' } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*relay\dist\cli.js*' -or $_.CommandLine -like '*rdp-relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2
$cmd = "`$Host.UI.RawUI.WindowTitle='Better Remote Commander (BRC) RELAY (source build)'; cd '$root'; `$env:PORT='3000'; `$env:PUBLIC_URL='$url'; `$env:TRUST_PROXY='true'; `$env:BRC_ADMIN_PASSWORD='$pw'; `$env:BRC_SESSION_SECRET='visual-session-secret'; `$env:BRC_DB='$db'; node packages\relay\dist\cli.js"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmd
