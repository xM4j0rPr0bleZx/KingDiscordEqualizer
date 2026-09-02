@echo off
title KingEqualizer
cd /d "%~dp0"
if not exist .env (
  echo Missing .env file. Copy .env.example to .env and fill it in.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
call npm start
pause

