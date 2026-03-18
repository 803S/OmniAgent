@echo off
REM OmniAgent 启动脚本 (Windows)
REM 版本: 2.0

echo.
echo ============================================
echo   OmniAgent - 全场景智能助手
echo ============================================
echo.

cd /d "%~dp0"

REM 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python，请先安装 Python 3.8+
    pause
    exit /b 1
)

echo [检查] Python 环境... OK

REM 检查/创建虚拟环境
if not exist "venv\Scripts\python.exe" (
    echo [安装] 创建虚拟环境...
    python -m venv venv
)

REM 激活虚拟环境
call venv\Scripts\activate.bat

REM 检查依赖
echo [检查] 依赖包...
pip show flask >nul 2>&1
if %errorlevel% neq 0 (
    echo [安装] 安装项目依赖...
    pip install -r requirements.txt
)

REM 检查可选依赖
pip show playwright >nul 2>&1
if %errorlevel% equ 0 (
    pip show playwright >nul 2>&1 || python -m playwright install chromium --with-deps >nul 2>&1
)

pip show chromadb >nul 2>&1
if %errorlevel% equ 0 (
    echo [提示] RAG 模块已启用
)

echo.
echo [启动] 后端服务 http://127.0.0.1:5000
echo [停止] 按 Ctrl+C
echo.
python server.py

deactivate
pause