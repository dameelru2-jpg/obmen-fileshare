@echo off
cd /d "%~dp0"
title Обмен - файлообменник офиса
chcp 65001 >nul

if exist "Obmen.exe" (
  echo Запуск файлообменника... Окно можно свернуть, но не закрывать.
  echo Чтобы остановить сервер, закройте окно Obmen или нажмите Ctrl+C в нём.
  start "" "Obmen.exe"
  exit /b 0
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Запуск через Python...
  python server.py
  pause
  exit /b 0
)

where node >nul 2>nul
if %errorlevel%==0 (
  echo Запуск через Node.js...
  node server.js
  pause
  exit /b 0
)

echo [Ошибка] Не найден ни Obmen.exe, ни Python, ни Node.js.
pause
exit /b 1
