# Move C:\Users\info\Desktop\Better Remote Commander (BRC) -> better-remote-commander and relaunch relay + agent windows.
$ErrorActionPreference = 'Continue'
$old = 'C:\Users\info\Desktop\Better Remote Commander (BRC)'; $new = 'C:\Users\info\Desktop\better-remote-commander'
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Better Remote Commander (BRC)*' -or $_.MainWindowTitle -like 'BRC*' } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*Better Remote Commander (BRC)*' -or $_.CommandLine -like '*rdp-agent*' -or $_.CommandLine -like '*rdp-relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 3
if (Test-Path $old) { Rename-Item $old 'better-remote-commander' }
Set-Location $new
# tunnel: keep the existing quick tunnel process (it points at localhost:3000 and does not care about folders)
$url = Get-Content data\public_url.txt
$pw = Get-Content data\admin_password.txt
$db = (Resolve-Path data\relay-live.sqlite).Path
$relay = "`$Host.UI.RawUI.WindowTitle='BRC RELAY'; cd '$new'; `$env:PORT='3000'; `$env:PUBLIC_URL='$url'; `$env:TRUST_PROXY='true'; `$env:BRC_ADMIN_PASSWORD='$pw'; `$env:BRC_SESSION_SECRET='visual-session-secret'; `$env:BRC_DB='$db'; node packages\relay\dist\cli.js"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $relay
Start-Sleep 6
$agent = "`$Host.UI.RawUI.WindowTitle='BRC AGENT'; cd '$new'; node packages\agent\dist\cli.js --debug"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $agent
