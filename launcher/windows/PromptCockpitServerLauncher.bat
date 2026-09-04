@echo off
setlocal

pushd "%~dp0..\.."
set "REPO_PATH=%CD%"
popd

if not exist "%REPO_PATH%" (
    echo [ERROR] REPO_PATH does not exist: %REPO_PATH%
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0PromptCockpitServerLauncher.ps1" -RepoPath "%REPO_PATH%"

endlocal
exit /b 0
