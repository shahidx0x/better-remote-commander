# One-shot rename SES-RDP -> Better Remote Commander (brc). Run from repo root.
$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -Recurse -File -Include *.ts,*.mjs,*.json,*.yml,*.yaml,*.md,*.sh,*.ps1,Dockerfile,Caddyfile,.env.example,.dockerignore,NOTICE,LICENSE |
  Where-Object { $_.FullName -notmatch '\\(node_modules|dist|reference-desktop-commander|data|tools|\.git)\\' -and $_.Name -ne 'server.ts.ref' -and $_.Name -ne 'rename-to-brc.ps1' }
$map = [ordered]@{
  '@ses-systems/rdp-shared' = 'brc-shared'
  '@ses-systems/rdp-agent'  = 'brc-agent'
  '@ses-systems/rdp-relay'  = 'brc-relay'
  'ses-systems-rdp-shared-' = 'brc-shared-'
  'ses-systems-rdp-agent-'  = 'brc-agent-'
  'ses-systems-rdp-relay-'  = 'brc-relay-'
  'ses-systems/rdp-relay'   = 'brc/relay'
  'ses-systems/rdp-agent'   = 'brc/agent'
  'com.ses-systems.'        = 'dev.brc.'
  'ses-rdp-agent'           = 'brc-agent'
  'ses-rdp-relay'           = 'brc-relay'
  'ses-rdp-shared'          = 'brc-shared'
  'ses-rdp-e2e-'            = 'brc-e2e-'
  'ses-rdp-big.txt'         = 'brc-big.txt'
  'ses_rdp_session'         = 'brc_session'
  'X-SES-RDP-Protocol'      = 'X-BRC-Protocol'
  'SES_RDP_UPSTREAM_TELEMETRY' = 'BRC_UPSTREAM_TELEMETRY'
  'SES_RDP_'                = 'BRC_'
  'sesrdp_ak_'              = 'brc_ak_'
  'sesrdp_at_'              = 'brc_at_'
  'sesrdp_rt_'              = 'brc_rt_'
  'sesrdp_dev_'             = 'brc_dev_'
  '.ses-rdp'                = '.brc'
  "name: 'ses-rdp'"         = "name: 'brc'"
  'SES-RDP relay'           = 'BRC relay'
  'SES-RDP agent'           = 'BRC agent'
  'SES-RDP'                 = 'Better Remote Commander (BRC)'
  '"RDP: ..."'              = '"BRC: ..."'
  'use SES-RDP to'          = 'use BRC to'
}
$changed = 0
foreach ($f in $files) {
  $c = [IO.File]::ReadAllText($f.FullName)
  $o = $c
  foreach ($k in $map.Keys) { $c = $c.Replace($k, $map[$k]) }
  $c = $c.Replace('ses-rdp', 'brc')
  if ($c -ne $o) { [IO.File]::WriteAllText($f.FullName, $c); $changed++ }
}
"files changed: $changed"
