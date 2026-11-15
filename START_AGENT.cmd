@echo off
setlocal
cd /d "%~dp0"
if not exist "packages\agent\dist\cli.js" (
  echo Build first: pnpm install ^&^& pnpm build
  exit /b 1
)
node "packages\agent\dist\cli.js" %*
exit /b %errorlevel%
