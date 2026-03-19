@echo off
setlocal enabledelayedexpansion
title MFCLIVE - Setup & Launcher
cd /d "%~dp0"

echo.
echo  =====================================================
echo    MFCLIVE - Setup ^& Launcher
echo  =====================================================
echo.
echo  Checking requirements...
echo.

:: ──────────────────────────────────────────────────────
::  1. NODE.JS
:: ──────────────────────────────────────────────────────
call :check_node
if "!NODE_OK!"=="1" goto node_done

echo  [ ] Node.js not found - attempting install...

:: Try winget (available on Windows 10 1709+ and Windows 11)
where winget >nul 2>&1
if not errorlevel 1 (
  echo      Using winget...
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  call :refresh_path
  call :check_node
  if "!NODE_OK!"=="1" goto node_done
)

:: Fall back to downloading the MSI installer via PowerShell
echo      Downloading Node.js LTS installer...
powershell -ExecutionPolicy Bypass -NoProfile -Command "$v=(Invoke-RestMethod 'https://nodejs.org/dist/index.json'|Where-Object{$_.lts}|Select-Object -First 1).version;Invoke-WebRequest \"https://nodejs.org/dist/$v/node-$v-x64.msi\" -OutFile \"$env:TEMP\nodejs-setup.msi\" -UseBasicParsing" >nul 2>&1
if exist "%TEMP%\nodejs-setup.msi" (
  echo      Running installer - follow the prompts...
  start /wait msiexec /i "%TEMP%\nodejs-setup.msi" /passive /norestart
  call :refresh_path
  call :check_node
  if "!NODE_OK!"=="1" goto node_done
)

:: Give up - manual install required
echo.
echo  [!!] Could not install Node.js automatically.
echo       Please install it from https://nodejs.org/ and run this file again.
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:node_done
echo  [OK] Node.js !NODE_VER!

:: ──────────────────────────────────────────────────────
::  2. CLOUDFLARED  (enables controller access outside local WiFi)
:: ──────────────────────────────────────────────────────
call :check_cloudflared
if "!CF_OK!"=="1" goto cf_done

echo  [ ] cloudflared not found - downloading...
set "CF_DEST=%~dp0cloudflared.exe"
powershell -ExecutionPolicy Bypass -NoProfile -Command "Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CF_DEST%' -UseBasicParsing" >nul 2>&1
call :check_cloudflared
if "!CF_OK!"=="1" (
  echo  [OK] cloudflared downloaded
) else (
  echo  [ ] cloudflared unavailable - controller will only work on local WiFi
)
goto cf_done

:cf_done
if "!CF_OK!"=="1" echo  [OK] cloudflared ready

:: ──────────────────────────────────────────────────────
::  3. NPM PACKAGES
:: ──────────────────────────────────────────────────────
if not exist "node_modules" (
  echo  [ ] Installing npm packages...
  call npm install --prefer-offline
  if errorlevel 1 (
    echo  [!!] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
  echo  [OK] npm packages installed
) else (
  echo  [OK] npm packages ready
)

:: ──────────────────────────────────────────────────────
::  4. CHECK FOR EXISTING INSTANCE
:: ──────────────────────────────────────────────────────
set "MFCLIVE_PID="
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
  if not defined MFCLIVE_PID set "MFCLIVE_PID=%%p"
)

if defined MFCLIVE_PID (
  echo.
  echo  [!!] MFCLIVE is already running ^(PID !MFCLIVE_PID!^).
  echo.
  choice /C YN /M "  Kill it and restart"
  if errorlevel 2 (
    echo.
    echo  Cancelled. The existing server is still running.
    echo.
    pause
    exit /b 0
  )
  taskkill /PID !MFCLIVE_PID! /F >nul 2>&1
  echo  [OK] Old instance stopped.
  :: Brief pause so the port is released before we re-bind
  timeout /t 1 /nobreak >nul
)

:: ──────────────────────────────────────────────────────
::  5. LAUNCH
:: ──────────────────────────────────────────────────────
echo.
echo  All good - starting MFCLIVE...
echo.
start "MFCLIVE Server" cmd /k "title MFCLIVE Server && node server.js"
exit /b 0


:: ══════════════════════════════════════════════════════
::  SUBROUTINES
:: ══════════════════════════════════════════════════════

:check_node
set "NODE_OK=0" & set "NODE_VER="
node --version >nul 2>&1
if not errorlevel 1 (
  for /f %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
  set "NODE_OK=1"
)
exit /b 0

:check_cloudflared
set "CF_OK=0"
where cloudflared >nul 2>&1
if not errorlevel 1 ( set "CF_OK=1" & exit /b 0 )
if exist "%~dp0cloudflared.exe" ( set "CF_OK=1" & exit /b 0 )
exit /b 0

:refresh_path
:: Re-read PATH from registry so a freshly installed tool is visible in this session
for /f "skip=2 tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
for /f "skip=2 tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
if defined SYS_PATH set "PATH=!SYS_PATH!"
if defined USR_PATH set "PATH=!PATH!;!USR_PATH!"
exit /b 0