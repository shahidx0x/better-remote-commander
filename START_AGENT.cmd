@echo off
rem Legacy launcher preserved. The portable BAT registers the source directory.
call "%~dp0START_AGENT.bat" %*
exit /b %errorlevel%
