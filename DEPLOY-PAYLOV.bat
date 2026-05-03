@echo off
REM ============================================================
REM Bu faylni ikki marta bosing - hammasi avtomatik ishga tushadi
REM ============================================================

cd /d "%~dp0"
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-paylov.ps1"
pause
