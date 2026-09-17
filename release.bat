@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Resonance - PUBLISH a new update
echo   This uploads to GitHub Releases so every
echo   installed copy of the app can auto-update.
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
) else (
  echo Node.js found.
)

:: ---------------------------------------------
:: Check / auto-install yt-dlp
:: ---------------------------------------------
if not exist "tools\yt-dlp.exe" (
  echo Downloading yt-dlp...
  if not exist "tools" mkdir "tools"
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'tools\yt-dlp.exe'"
)

if not exist "node_modules" (
  echo Installing dependencies - first run, this can take a minute...
  call npm install --prefer-offline --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Scroll up to see why.
    pause
    exit /b 1
  )
)

:: ---------------------------------------------
:: Make sure package.json actually points at a real repo
:: ---------------------------------------------
findstr /C:"PON-TU-USUARIO-DE-GITHUB-AQUI" package.json >nul
if not errorlevel 1 (
  echo.
  echo [ERROR] package.json still has the placeholder GitHub owner/repo.
  echo Open package.json, find "build.publish", and replace:
  echo   PON-TU-USUARIO-DE-GITHUB-AQUI  -^> your GitHub username
  echo   PON-EL-NOMBRE-DE-TU-REPO-AQUI  -^> your repo name
  echo Then run this script again.
  pause
  exit /b 1
)

:: ---------------------------------------------
:: GitHub token (needed to upload the release)
:: ---------------------------------------------
if "%GH_TOKEN%"=="" (
  echo.
  echo A GitHub Personal Access Token is needed to upload the release.
  echo ^(GitHub.com -^> Settings -^> Developer settings -^> Personal access
  echo  tokens -^> generate one with "repo" scope. It's only used for this
  echo  upload and is not saved anywhere by this script.^)
  echo.
  set /p GH_TOKEN=Paste your GitHub token here: 
)
if "%GH_TOKEN%"=="" (
  echo [ERROR] No token entered. Cancelling.
  pause
  exit /b 1
)

:: ---------------------------------------------
:: Version bump
:: ---------------------------------------------
echo.
echo Current version:
call npm pkg get version
echo.
echo What kind of update is this?
echo   1 = patch  (bug fixes / small tweaks)      e.g. 1.0.0 -^> 1.0.1
echo   2 = minor  (new features)                  e.g. 1.0.0 -^> 1.1.0
echo   3 = major  (big changes)                   e.g. 1.0.0 -^> 2.0.0
echo   4 = don't bump - publish the current version as-is
echo.
choice /c 1234 /n /m "Choose 1, 2, 3 or 4: "
set BUMP_CHOICE=%errorlevel%

if "%BUMP_CHOICE%"=="1" call npm version patch --no-git-tag-version
if "%BUMP_CHOICE%"=="2" call npm version minor --no-git-tag-version
if "%BUMP_CHOICE%"=="3" call npm version major --no-git-tag-version

echo.
echo New version:
call npm pkg get version
echo.

echo Building and uploading to GitHub Releases... this can take a few minutes.
call npm run release:win
if errorlevel 1 (
  echo.
  echo [ERROR] Publish failed. Scroll up to see why.
  echo ^(Common cause: the token doesn't have "repo" scope, or the
  echo  owner/repo in package.json don't match your actual GitHub repo.^)
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Published! Every installed copy of the app
echo   will pick this up next time it's opened
echo   (or within a few hours if left running).
echo ============================================
pause
exit /b 0

:refreshpath
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
goto :eof
