# Dev helper (Windows): run the relay behind a temporary ngrok URL. Requires ngrok on PATH.
param([int]$Port = 3210)
if (-not $env:SES_RDP_ADMIN_PASSWORD) { throw 'set SES_RDP_ADMIN_PASSWORD' }
$ngrok = Start-Process ngrok -ArgumentList "http $Port" -PassThru -WindowStyle Hidden
try {
  $url = $null
  for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    Start-Sleep 1
    try { $url = (Invoke-RestMethod http://localhost:4040/api/tunnels).tunnels | ? { $_.public_url -like 'https:*' } | Select-Object -First 1 -ExpandProperty public_url } catch {}
  }
  if (-not $url) { throw 'ngrok did not come up' }
  Write-Host "PUBLIC_URL=$url"
  $env:PUBLIC_URL = $url; $env:TRUST_PROXY = 'true'; $env:PORT = "$Port"
  node packages/relay/dist/cli.js
} finally { Stop-Process -Id $ngrok.Id -Force -ErrorAction SilentlyContinue }
