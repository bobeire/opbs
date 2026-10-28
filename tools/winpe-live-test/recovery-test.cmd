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
if "%~1"=="" (
  echo  *** No phase given - nothing was run and no log was written. ***
  echo.
  echo  Start with:   recovery-test.cmd prep
  echo    prep    - prepare a scratch VHDX and a test backup image
  echo    stage   - stage the reboot-into-recovery restore ^(one UAC ^)
  echo    after   - verify the results after the reboot round trip
  echo    cancel  - remove a staged restore without rebooting
  echo.
  pause
  exit /b 1
)
echo  This test only creates/attaches VHDX files in test\ on this drive.
echo  It never writes to a physical disk of this machine. The staged
echo  one-shot boot entry is removed again at the end (after/cancel).
echo.
node "%~dp0recovery-test.js" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  if exist "%~dp0test\recovery-test-log.txt" (
    echo  Phase finished with error code %RC%. See test\recovery-test-log.txt
  ) else (
    echo  Phase finished with error code %RC% and wrote no log - the phase did not start.
  )
) else (
  echo  Phase finished successfully. See test\recovery-test-log.txt
)
echo.
pause
endlocal
exit /b %RC%
