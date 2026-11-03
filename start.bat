@echo off
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if %errorlevel%==0 goto run

set "KIMI_EXE=%LOCALAPPDATA%\Programs\Kimi\Kimi.exe"
if exist "%KIMI_EXE%" (
  set "NODE=%KIMI_EXE%"
  set ELECTRON_RUN_AS_NODE=1
  goto run
)

echo [Ошибка] Node.js не найден на этом компьютере.
echo Установите Node.js с сайта https://nodejs.org и запустите этот файл снова.
echo.
pause
exit /b 1

:run
title Обмен - файлообменник офиса
echo Запуск файлообменника... Окно можно свернуть, но не закрывать.
echo Чтобы остановить сервер, закройте это окно или нажмите Ctrl+C.
echo.
chcp 65001 >nul
"%NODE%" server.js
pause
