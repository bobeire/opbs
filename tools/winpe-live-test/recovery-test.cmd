@echo off
setlocal
title OPBS Recovery Live Test
mode con cols=100 lines=45
set "OPENSSL_CONF="
cd /d "%~dp0"
echo =============================================================
echo  OPBS recovery-after-reboot live test
echo  (stage - reboot into OPBS Recovery - auto-restore - verify)
echo =============================================================
echo.
echo  Usage: recovery-test.cmd prep ^| stage ^| after ^| cancel [--cli path]
echo.
echo  This test only creates/attaches VHDX files in test\ on this drive.
echo  It never writes to a physical disk of this machine. The staged
echo  one-shot boot entry is removed again at the end (after/cancel).
echo.
node "%~dp0recovery-test.js" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo  Phase finished with error code %RC%. See test\recovery-test-log.txt
) else (
  echo  Phase finished successfully. See test\recovery-test-log.txt
)
echo.
pause
endlocal
exit /b %RC%
