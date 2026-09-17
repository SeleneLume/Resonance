@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Resonance - build INSTALLER (local test)
echo   This does NOT publish anything to GitHub.
echo ============================================
echo.

:: ---------------------------------------------
:: Relaunch elevated (admin) if we aren't already
:: ---------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Administrator privileges are required - requesting elevation...
  set "UAC_VBS=%TEMP%\resonance-getadmin.vbs"
  echo Set UAC = CreateObject^("Shell.Application"^) > "!UAC_VBS!"
  echo UAC.ShellExecute "%~s0", "%*", "%~dp0", "runas", 1 >> "!UAC_VBS!"
  cscript //nologo "!UAC_VBS!"
  del "!UAC_VBS!" >nul 2>nul
  exit /b
)

:: ---------------------------------------------
:: Check / auto-install Node.js
:: ---------------------------------------------
echo Checking for Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found - downloading and installing the latest LTS release...
  set "NODE_MSI=%TEMP%\node-lts-installer.msi"
  powershell -NoProfile -Command ^
    "$ProgressPreference='SilentlyContinue'; $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $lts = $idx | Where-Object { $_.lts -ne $false } | Select-Object -First 1; $url = 'https://nodejs.org/dist/' + $lts.version + '/node-' + $lts.version + '-x64.msi'; Invoke-WebRequest -Uri $url -OutFile '%NODE_MSI%'"
  if not exist "%NODE_MSI%" (
    echo [ERROR] Failed to download Node.js. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo Installing Node.js silently, this can take a minute...
  msiexec /i "%NODE_MSI%" /qn /norestart
  del "%NODE_MSI%" >nul 2>nul
  call :refreshpath
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js was installed, but this window can't see it yet.
    echo Close this window, open a new terminal, and run this script again.
    pause
    exit /b 1
  )
  echo Node.js installed successfully.
) else (
  echo Node.js found.
)

:: ---------------------------------------------
:: Check / auto-install yt-dlp
:: ---------------------------------------------
echo Checking for yt-dlp...
if not exist "tools\yt-dlp.exe" (
  echo yt-dlp not found - downloading the latest standalone build...
  if not exist "tools" mkdir "tools"
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'tools\yt-dlp.exe'"
  if not exist "tools\yt-dlp.exe" (
    echo [ERROR] Failed to download yt-dlp. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo yt-dlp downloaded - it will be bundled straight into the installer.
) else (
  echo yt-dlp found in tools\ - it will be bundled into the installer.
)

echo.

if /i "%~1"=="--clean" (
  echo Forcing a clean reinstall...
  if exist "node_modules" rmdir /s /q "node_modules"
  if exist "package-lock.json" del /f /q "package-lock.json"
)

if not exist "node_modules" (
  echo [1/2] Installing dependencies - first run, this can take a minute...
  call npm install --prefer-offline --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Scroll up to see why.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies already installed - skipping npm install.
  echo       ^(run "build-installer.bat --clean" if something's acting weird^)
)

echo.
echo [2/2] Building the Windows installer (Setup.exe)...
call npm run dist:win:installer
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. Scroll up to see why.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Done! Your Setup.exe is in the "release" folder.
echo   This build was NOT published - installing it
echo   won't auto-update unless you also run release.bat
echo   at least once from a repo GitHub knows about.
echo ============================================
if exist "release" start "" explorer "release"
pause
exit /b 0

:refreshpath
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
goto :eof
