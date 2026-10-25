@echo off
rem Start copilot-bridge on Windows.
rem
rem Usage: scripts\run.bat [menu^|node^|docker^|auto^|stop]      (or set RUN_MODE=...)
rem   (no argument)  ask which option to use (menu)
rem   node           option A: build and run the bridge with host Node.js 20+ (this window; Ctrl+C stops it)
rem   docker         option B: run the bridge and the CDP proxy as containers (needs only Docker)
rem   auto           node if Node.js 20+ is installed, otherwise docker, without asking
rem   stop           stop the Docker containers (switch between the options with this)
rem
rem Both options first make sure a dedicated Edge with remote debugging is running.
setlocal
title Copilot Bridge MCP Stack

set "DEBUG_PORT=9222"
set "PROXY_PORT=9223"
set "BRIDGE_PORT=3100"
set "PROXY_IMAGE=node:22-alpine"
set "EDGE_PROFILE=%USERPROFILE%\.copilot-bridge-edge"
if not defined COPILOT_URL set "COPILOT_URL=https://copilot.cloud.microsoft/"

set "MODE=%~1"
if not defined MODE set "MODE=%RUN_MODE%"
if not defined MODE set "MODE=menu"

set "SCRIPTSDIR=%~dp0"
if "%SCRIPTSDIR:~-1%"=="\" set "SCRIPTSDIR=%SCRIPTSDIR:~0,-1%"
for %%I in ("%SCRIPTSDIR%\..") do set "PROJECTDIR=%%~fI"

set "GIT_SHA=dev"
for /f %%I in ('git -C "%PROJECTDIR%" rev-parse --short HEAD 2^>nul') do set "GIT_SHA=%%I"

rem === What is available ===
set "HAVE_NODE="
where node >nul 2>&1 && where npm >nul 2>&1 && (
    for /f "tokens=1 delims=v." %%V in ('node -v') do if %%V GEQ 20 set "HAVE_NODE=1"
)
set "HAVE_DOCKER="
docker info >nul 2>&1 && set "HAVE_DOCKER=1"

if /i "%MODE%"=="stop" goto :stop
if /i "%MODE%"=="menu" goto :menu
if /i "%MODE%"=="auto" goto :auto
if /i "%MODE%"=="node" goto :checknode
if /i "%MODE%"=="docker" goto :checkdocker
echo ERROR: Unknown mode "%MODE%". Use menu, node, docker, auto or stop.
goto :end

:menu
echo.
echo How do you want to run copilot-bridge?
if defined HAVE_NODE (
    echo   1^) Node.js  - build and run on this machine. No Docker, no proxy.        [available]
) else (
    echo   1^) Node.js  - build and run on this machine. No Docker, no proxy.        [NOT available: needs Node.js 20+ and npm]
)
if defined HAVE_DOCKER (
    echo   2^) Docker   - bridge and CDP proxy as containers. No Node.js needed.     [available]
) else (
    echo   2^) Docker   - bridge and CDP proxy as containers. No Node.js needed.     [NOT available: Docker is not installed or not running]
)
echo   q^) Quit
set "DEFAULT=q"
if defined HAVE_DOCKER set "DEFAULT=2"
if defined HAVE_NODE set "DEFAULT=1"
set "CHOICE="
set /p "CHOICE=Choice [%DEFAULT%]: "
if not defined CHOICE set "CHOICE=%DEFAULT%"
if /i "%CHOICE%"=="q" goto :end
if "%CHOICE%"=="1" (
    if defined HAVE_NODE (set "MODE=node" & goto :checknode)
    echo Node.js option is not available on this machine.
    goto :menu
)
if "%CHOICE%"=="2" (
    if defined HAVE_DOCKER (set "MODE=docker" & goto :checkdocker)
    echo Docker option is not available on this machine.
    goto :menu
)
echo Enter 1, 2 or q.
goto :menu

:auto
if defined HAVE_NODE (set "MODE=node" & goto :checknode)
if defined HAVE_DOCKER (set "MODE=docker" & goto :checkdocker)
echo ERROR: Neither Node.js 20+ nor a running Docker was found. Install one of them.
goto :end

:checknode
if not defined HAVE_NODE (
    echo ERROR: Node.js 20+ and npm are required for the Node.js option. Use "docker" instead.
    goto :end
)
rem Port check: the Docker option may still be running
netstat -ano | findstr /R /C:":%BRIDGE_PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
    echo ERROR: Port %BRIDGE_PORT% is already in use. If it is the Docker bridge, run "scripts\run.bat stop" first.
    goto :end
)
goto :modeok

:checkdocker
if not defined HAVE_DOCKER (
    echo ERROR: Docker is not installed or not running. Use "node" instead.
    goto :end
)
rem Port check: a Node.js bridge may still be running (the Docker bridge itself is fine)
set "BRIDGE_UP="
for /f %%C in ('docker ps -q --filter "name=^copilot-bridge$"') do set "BRIDGE_UP=1"
netstat -ano | findstr /R /C:":%BRIDGE_PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 if not defined BRIDGE_UP (
    echo ERROR: Port %BRIDGE_PORT% is used by another process, probably a Node.js bridge. Stop it first ^(Ctrl+C in its window^).
    goto :end
)
goto :modeok

:stop
if not defined HAVE_DOCKER (
    echo ERROR: Docker is not installed or not running.
    goto :end
)
pushd "%PROJECTDIR%"
docker compose down
popd
docker rm -f cdp-proxy >nul 2>&1
echo Docker containers stopped.
goto :end

:modeok
echo Mode: %MODE%

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

echo.
echo === Step 1: Ensure Microsoft Edge is running with remote debugging ===

netstat -ano | findstr /R /C:":%DEBUG_PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Port %DEBUG_PORT% is already listening. Skipping Edge launch.
    goto :step2
)
if not defined EDGE (
    echo ERROR: Microsoft Edge was not found.
    goto :end
)
echo Launching Edge...
start "" "%EDGE%" --remote-debugging-port=%DEBUG_PORT% --user-data-dir="%EDGE_PROFILE%" --no-first-run "%COPILOT_URL%"
timeout /t 3 /nobreak >nul

:step2
if /i "%MODE%"=="docker" goto :docker

rem === Node.js option ===
echo.
echo === Step 2: Build and run the bridge with Node.js ===
pushd "%PROJECTDIR%"
if not exist node_modules call npm ci
if errorlevel 1 goto :end
call npm run build
if errorlevel 1 goto :end

rem Edge accepts a Host header of localhost, so no CDP proxy is needed on the host.
set "CDP_ENDPOINT=http://127.0.0.1:%DEBUG_PORT%"
if not defined RESPONSE_TIMEOUT_MS set "RESPONSE_TIMEOUT_MS=240000"
if not defined OUTPUT_DIR set "OUTPUT_DIR=%PROJECTDIR%\output"
echo.
echo MCP endpoint: http://localhost:%BRIDGE_PORT%/mcp   (status page: http://localhost:%BRIDGE_PORT%/)
echo Sign in to Copilot in the Edge window if the status page says "not authenticated".
node dist\index.js
popd
goto :end

:docker
rem === Docker option ===
echo.
echo === Step 2: Start the CDP proxy container ===

docker rm -f cdp-proxy >nul 2>&1

rem Published on host loopback only: this port gives full control of the browser.
docker run -d ^
  --name cdp-proxy ^
  --restart unless-stopped ^
  --add-host=host.docker.internal:host-gateway ^
  -e CDP_TARGET_HOST=host.docker.internal ^
  -e CDP_PROXY_HOST=0.0.0.0 ^
  -e CDP_PORT=%DEBUG_PORT% ^
  -e CDP_PROXY_PORT=%PROXY_PORT% ^
  -p 127.0.0.1:%PROXY_PORT%:%PROXY_PORT% ^
  -v "%SCRIPTSDIR%:/scripts:ro" ^
  %PROXY_IMAGE% ^
  node /scripts/cdp-proxy.mjs

echo.
echo === Step 3: Bring up the bridge with Docker Compose ===

rem Compose expands ${PWD} for the host output path, so run it from the project root.
pushd "%PROJECTDIR%"
docker compose up -d --build
popd

echo.
echo === Step 4: Waiting for the bridge ===

timeout /t 8 /nobreak >nul

echo.
echo Health check:

where curl >nul 2>&1
if %ERRORLEVEL%==0 (
    curl -s http://localhost:%BRIDGE_PORT%/health
) else (
    powershell -Command "try { Invoke-RestMethod -Uri 'http://localhost:%BRIDGE_PORT%/health' } catch { Write-Host $_ }"
)

echo.
echo Container to proxy to Edge:
docker exec copilot-bridge node -e "fetch('http://host.docker.internal:%PROXY_PORT%/json/version').then(r=>{console.log(r.ok?'reachable':'HTTP '+r.status);process.exit(r.ok?0:1)}).catch(e=>{console.log('NOT reachable');process.exit(1)})"

echo.
echo Copilot Bridge startup completed.
echo If authentication is not ready, sign in to Copilot in the Edge window, then click Re-check on http://localhost:%BRIDGE_PORT%/
echo MCP endpoint: http://localhost:%BRIDGE_PORT%/mcp      Stop: scripts\run.bat stop

:end
endlocal
pause
