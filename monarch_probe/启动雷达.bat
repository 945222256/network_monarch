@echo off
:: Request Admin privileges
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo Requesting Administrator privileges...
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    exit /B

:gotAdmin
    if exist "%temp%\getadmin.vbs" ( del "%temp%\getadmin.vbs" )
    cd /d "G:\Playground\network_monarch\monarch_probe"
    echo [Monarch] Killing existing probe...
    taskkill /F /IM monarch_probe.exe /T >nul 2>&1
    taskkill /F /IM cargo.exe /T >nul 2>&1
    echo [Monarch] Re-compiling...
    cargo build
    echo [Monarch] Initializing Kernel Driver...
    powershell -Command "cargo run 2>&1 | Tee-Object -FilePath 'probe_output.log'"
    pause
