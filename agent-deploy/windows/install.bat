@echo off
:: IT Asset Agent - Windows 安装脚本
:: 用法: install.bat --server http://YOUR_SERVER:3001
:: 需要以管理员身份运行

setlocal enabledelayedexpansion
set SERVER=http://localhost:3001
set SECRET=
set VNC_PORT=5900
set INTERVAL=300

:parse
if "%~1"=="" goto install
if /i "%~1"=="--server" (set SERVER=%~2& shift& shift& goto parse)
if /i "%~1"=="--secret" (set SECRET=%~2& shift& shift& goto parse)
if /i "%~1"=="--vnc-port" (set VNC_PORT=%~2& shift& shift& goto parse)
if /i "%~1"=="--interval" (set INTERVAL=%~2& shift& shift& goto parse)
shift & goto parse

:install
if "%SECRET%"=="" (
  echo Error: --secret is required
  exit /b 1
)
echo =^> 安装 IT Asset Agent (Windows)
echo    服务器: %SERVER%

set INSTALL_DIR=C:\it-asset-agent
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%~dp0it-asset-agent.exe" "%INSTALL_DIR%\it-asset-agent.exe" >nul

:: 注册为 Windows 计划任务（开机自启，SYSTEM 账户）
schtasks /delete /tn "ITAssetAgent" /f >nul 2>&1
schtasks /create /tn "ITAssetAgent" ^
  /tr "\"%INSTALL_DIR%\it-asset-agent.exe\" --server %SERVER% --interval %INTERVAL% --vnc-port %VNC_PORT% --agent-secret %SECRET%" ^
  /sc onstart /ru SYSTEM /rl HIGHEST /f

echo =^> 安装完成！立即启动 Agent...
schtasks /run /tn "ITAssetAgent"

echo.
echo    卸载: schtasks /delete /tn ITAssetAgent /f  ^&^&  rmdir /s /q C:\it-asset-agent
pause
