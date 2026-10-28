@echo off
chcp 65001 >nul
rem ============================================================
rem  Castalia 记忆体 —— 托盘 exe 重新打包
rem  什么时候需要跑:只有**新增第三方依赖**时才需要。
rem  日常改托盘逻辑(custalia_tray.py)不用打包 —— exe 是薄壳,
rem  真正代码从磁盘加载,改完重启托盘即可生效。
rem ============================================================
setlocal
set "PY=%CASTALIA_BUILD_PY%"
if not defined PY set "PY=C:\Users\1\AppData\Local\Programs\Python\Python313\python.exe"
if not exist "%PY%" exit /b 2
"%PY%" -m PyInstaller --version >nul 2>&1
if errorlevel 1 exit /b 2
cd /d "%~dp0.."

rem Build in staging before touching any running host.

echo [2/3] 打包中(约 2-3 分钟)…
"%PY%" -m PyInstaller --noconfirm --clean --noconsole --name Castalia ^
  --icon "scripts\tray-icons\castalia-tray.ico" ^
  --version-file "scripts\tray-icons\version_info.txt" ^
  --distpath "build-staging" ^
  --exclude-module numpy ^
  --workpath "%LOCALAPPDATA%\Temp\tray_build" --specpath "%LOCALAPPDATA%\Temp\tray_build" ^
  scripts\tray_launcher.py

if errorlevel 1 exit /b 1
echo Build ready: %CD%\build-staging\Castalia
echo Close Castalia services before replacing the working host directory.
echo.
echo 输出: D:\AI\castalia\run\Castalia\Castalia\Castalia.exe
exit /b 0
