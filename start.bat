@echo off
title Monitor Backend Startup
echo ============================================
echo   Starting Monitor Backend Services
echo ============================================

echo.
echo [1/3] Starting monitor-backend via PM2...
cd /d "C:\Projects\Mutli-Account Balance & Transaction Monitoring System"
call pm2 delete all 2>nul
call pm2 start ecosystem.config.js
call pm2 save

echo.
echo [2/3] Waiting for server to initialize...
timeout /t 5 /nobreak >nul

echo.
echo [3/3] Starting Cloudflare tunnel...
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared" >nul
if errorlevel 1 (
    powershell -WindowStyle Hidden -Command "Start-Process 'C:\Program Files (x86)\cloudflared\cloudflared.exe' -ArgumentList 'tunnel --config C:\Users\Administrator\.cloudflared\config.yml run e1d2299e-343b-4845-a279-8c977bef2569' -WindowStyle Hidden"
    echo    Cloudflare tunnel started.
) else (
    echo    Cloudflare tunnel already running.
)

timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo   All services started!
echo   Backend:  http://localhost:3001
echo   Tunnel:   https://monitor.primeclc.com
echo ============================================
call pm2 status
echo.
cmd /k
