@echo off
setlocal
title OPBS WinPE VHD Live Test
mode con cols=100 lines=45
set "OPENSSL_CONF="
cd /d "%~dp0"
echo =============================================================
echo  OPBS WinPE VHD live test (backup-from-VHD + restore-to-VHD)
echo =============================================================
echo.
echo  This test only creates/attaches VHDX files on this stick.
echo  It never writes to a physical disk of this machine.
echo.
"%~dp0node.exe" "%~dp0vhd-test.js"
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo  Test finished with error code %RC%. See test\winpe-test-log.txt
) else (
  echo  Test finished successfully. See test\winpe-test-log.txt
)
echo.
pause
endlocal
exit /b %RC%
