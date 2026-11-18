@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem BRC portable Windows launcher. No fixed repository path is embedded.
rem Run once beside the source build to register the root, then copy this .bat anywhere.
if not defined BRC_LAUNCHER_HOME set "BRC_LAUNCHER_HOME=%LOCALAPPDATA%\BRC"
if not defined BRC_LAUNCHER_HOME set "BRC_LAUNCHER_HOME=%USERPROFILE%\.brc"
set "BRC_SOURCE_ROOT="
set "BRC_ROOT="

rem Prefer the source build next to this batch file, and register its location.
if exist "%~dp0packages\agent\dist\cli.js" (
  set "BRC_ROOT=%~dp0"
  set "BRC_SOURCE_ROOT=1"
)
rem Explicit machine setup always takes precedence over a saved pointer.
if not defined BRC_ROOT if defined BRC_AGENT_ROOT (
  if exist "%BRC_AGENT_ROOT%\packages\agent\dist\cli.js" set "BRC_ROOT=%BRC_AGENT_ROOT%\"
)
rem Moving/copying the BAT never loses the registered source location.
if not defined BRC_ROOT if exist "%BRC_LAUNCHER_HOME%\agent-root.txt" (
  for /f "usebackq delims=" %%R in ("%BRC_LAUNCHER_HOME%\agent-root.txt") do (
    if exist "%%Rpackages\agent\dist\cli.js" set "BRC_ROOT=%%R"
  )
)

if defined BRC_ROOT goto :run_local
rem If source path is unknown, a globally installed CLI is another valid installation.
where brc-agent.cmd >nul 2>&1
if not errorlevel 1 (
  echo [BRC] Starting globally installed agent...
  call brc-agent.cmd %*
  exit /b %errorlevel%
)
echo.
echo [BRC] Agent installation could not be located.
echo Run this BAT once inside the built repository, then copy it anywhere.
echo Or set BRC_AGENT_ROOT to your project directory, or install brc-agent globally.
echo Build the repository first if packages\agent\dist\cli.js is missing.
if "%~1"=="" pause
exit /b 2

:run_local
if defined BRC_SOURCE_ROOT (
  if not exist "%BRC_LAUNCHER_HOME%" mkdir "%BRC_LAUNCHER_HOME%" >nul 2>&1
  if exist "%BRC_LAUNCHER_HOME%" (
    > "%BRC_LAUNCHER_HOME%\agent-root.txt" echo(%BRC_ROOT%
  )
)
if /i "%~1"=="--register-only" (
  echo [BRC] Portable launcher registered to: "%BRC_ROOT%"
  exit /b 0
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [BRC] Node.js 22.13 or newer is required.
  if "%~1"=="" pause
  exit /b 2
)
title Better Remote Commander - Local Agent
rem Keep a local, bounded failure-only log unless the owner explicitly opts out.
if not defined BRC_ERROR_LOG set "BRC_ERROR_LOG=1"
rem Responsive profile: fast native commands + concurrent I/O, without parallel CPU-heavy jobs.
set "BRC_RESOURCE_PROFILE=responsive"
rem Rolling last-20-line BRC console only; no accumulated console transcript.
if not defined BRC_ROLLING_LOG_UI set "BRC_ROLLING_LOG_UI=1"
set "BRC_MAX_JOBS=1"
set "BRC_MAX_CONCURRENCY=3"
set "BRC_PARSER_WORKERS=1"
rem Avoid additional proxy/database processes unless explicitly enabled by owner.
if not defined BRC_RTK set "BRC_RTK=0"
if not defined BRC_FAST_EXEC set "BRC_FAST_EXEC=1"
pushd "%BRC_ROOT%" >nul 2>&1
if errorlevel 1 (
  echo [BRC] Could not enter the registered project directory.
  if "%~1"=="" pause
  exit /b 2
)
echo [BRC] Starting responsive agent: quick commands, up to 3 I/O calls, 1 heavy job...
echo [BRC] Controls: M settings, S status, L activity, V verbose
if "%~1"=="" (
  start "" /b /belownormal /wait node "%BRC_ROOT%packages\agent\dist\cli.js" --auto-connect
) else (
  start "" /b /belownormal /wait node "%BRC_ROOT%packages\agent\dist\cli.js" %*
)
set "BRC_EXIT=%errorlevel%"
popd
if not "%BRC_EXIT%"=="0" (
  echo [BRC] Agent exited with error code %BRC_EXIT%.
  if "%~1"=="" pause
)
exit /b %BRC_EXIT%
