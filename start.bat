@echo off
setlocal

set ROOT_DIR=%~dp0
for %%I in ("%ROOT_DIR%..") do set PROJECT_DIR=%%~fI
set VENV_DIR=%ROOT_DIR%.venv
set LOG_DIR=%ROOT_DIR%logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%I
set LOG_FILE=%LOG_DIR%\start-%TS%.log

echo [INFO] OmniAgent Gemini Baseline Rebuild
echo [INFO] root=%ROOT_DIR%
echo [INFO] project=%PROJECT_DIR%
echo [INFO] log_file=%LOG_FILE%
echo [INFO] py_launcher=py
echo [INFO] runtime_env_primary=%ROOT_DIR%.env
echo [INFO] project_root_env_opt_in=%OMNIAGENT_ALLOW_PROJECT_ROOT_ENV%
echo [INFO] ccswitch_endpoint_resolution=CCSWITCH_BASE_URL ^> CCSWITCH_PROXY_URL ^> CCSWITCH_PROXY_HOST:PORT ^> trusted_system_proxy ^> host_ccswitch_discovery
echo [INFO] ccswitch_http_proxy_mode=%CCSWITCH_USE_HTTP_PROXY%

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo [INFO] creating virtualenv: %VENV_DIR%
  py -3 -m venv "%VENV_DIR%"
)

echo [INFO] venv_python=%VENV_DIR%\Scripts\python.exe
echo [INFO] venv_pip=%VENV_DIR%\Scripts\pip.exe

if "%OMNIAGENT_SKIP_INSTALL%"=="1" (
  echo [INFO] skipping dependency install because OMNIAGENT_SKIP_INSTALL=1
) else (
  echo [INFO] installing requirements
  "%VENV_DIR%\Scripts\pip.exe" install -r "%ROOT_DIR%backend\requirements.txt"
)

echo [INFO] running syntax check
"%VENV_DIR%\Scripts\python.exe" -m py_compile "%ROOT_DIR%backend\server.py" "%ROOT_DIR%backend\db.py"

echo [INFO] starting backend on default http://127.0.0.1:8765
pushd "%ROOT_DIR%"
echo [INFO] backend stdout/stderr will be mirrored to console and %LOG_FILE%
powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%VENV_DIR%\Scripts\python.exe' -m backend.server 2>&1 | Tee-Object -FilePath '%LOG_FILE%'"
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%
