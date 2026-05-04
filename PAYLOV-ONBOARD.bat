@echo off
REM ============================================================
REM Double-click qiling — Paylov onboarding skripti ishga tushadi.
REM Yangi onboarding tokenni so'raydi, credentials yaratadi va
REM ekranda hamda fayl'ga saqlaydi.
REM ============================================================

cd /d "%~dp0"
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paylov-onboard.ps1"
pause
