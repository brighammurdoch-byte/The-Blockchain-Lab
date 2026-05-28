@echo off
REM Blockchain Lab - Easy Production Starter for Windows
REM Run this as Administrator for best results (PM2 service registration)

echo Starting Blockchain Lab in production mode...
echo.

cd /d "%~dp0"

where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo PM2 not found globally. Installing...
    call npm install -g pm2
)

echo.
echo Starting with PM2 (auto-restart, logging)...
pm2 start ecosystem.config.js --env production

echo.
echo Making PM2 resurrect on boot (you may need to run the printed command as Admin)...
pm2 save
pm2 startup

echo.
echo Done! Your app should now be managed by PM2.
echo.
echo Useful commands:
echo   pm2 logs blockchain-lab
echo   pm2 restart blockchain-lab
echo   pm2 status
echo   pm2 stop blockchain-lab
echo.
pause
