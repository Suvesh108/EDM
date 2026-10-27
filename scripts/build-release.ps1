# EDM Production Release Build Script
# This is the single canonical release build command for EDM.

$ErrorActionPreference = "Stop"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " [EDM] Starting Unified Production Release Build" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

# 1. Build Desktop UI Frontend
Write-Host "`n[1/6] Building Desktop UI frontend with Vite..." -ForegroundColor Yellow
Set-Location "$RootDir/apps/desktop"
npm install --no-audit --prefer-offline
npm run build
if ($LASTEXITCODE -ne 0) { throw "Desktop frontend build failed" }

# 2. Build Browser Extension
Write-Host "`n[2/6] Building Browser Extension..." -ForegroundColor Yellow
Set-Location "$RootDir/extension"
npm install --no-audit --prefer-offline
npm run build
if ($LASTEXITCODE -ne 0) { throw "Browser extension build failed" }

# 3. Build Native Messaging Host (edm-nmh)
Write-Host "`n[3/6] Building edm-nmh executable..." -ForegroundColor Yellow
Set-Location $RootDir
cargo build --release -p edm-nmh
if ($LASTEXITCODE -ne 0) { throw "edm-nmh build failed" }

# 4. Ensure WebView2Loader.dll is in target/release
Write-Host "`n[4/6] Verifying WebView2Loader.dll..." -ForegroundColor Yellow
$wv2Source = Get-ChildItem -Path "$RootDir/target" -Recurse -Filter "WebView2Loader.dll" | Select-Object -First 1
if ($wv2Source) {
    Copy-Item -Path $wv2Source.FullName -Destination "$RootDir/target/release/WebView2Loader.dll" -Force
    Write-Host "Copied WebView2Loader.dll to target/release/" -ForegroundColor Green
} else {
    Write-Warning "WebView2Loader.dll not found in target. Cargo build will generate it."
}

# 5. Build Desktop Tauri Application & NSIS Installer
Write-Host "`n[5/6] Building Desktop Tauri App & NSIS Installer..." -ForegroundColor Yellow
Set-Location "$RootDir/apps/desktop"

# Check if MSVC is available; if so use target x86_64-pc-windows-msvc
$hasCl = Get-Command "cl.exe" -ErrorAction SilentlyContinue
if ($hasCl) {
    Write-Host "Using MSVC toolchain (x86_64-pc-windows-msvc)..." -ForegroundColor Green
    npx @tauri-apps/cli build --target x86_64-pc-windows-msvc
} else {
    Write-Host "MSVC not detected in path; building with active toolchain..." -ForegroundColor Yellow
    npx @tauri-apps/cli build
}
if ($LASTEXITCODE -ne 0) { throw "Tauri application build failed" }

# 6. CI Safety Check: Fail if release installer or packaged assets contain localhost:1420
Write-Host "`n[6/6] Verifying Release Installer for embedded assets..." -ForegroundColor Yellow
$setupExe = Get-ChildItem -Path "$RootDir/target/release/bundle/nsis" -Filter "EDM_*_x64-setup.exe" | Select-Object -First 1

if ($setupExe -and (Test-Path $setupExe.FullName)) {
    # Check that NSIS installer does not embed localhost devUrl
    $containsDevUrl = Select-String -Path $setupExe.FullName -Pattern "http://localhost:1420" -SimpleMatch -Quiet
    if ($containsDevUrl) {
        throw "CRITICAL SECURITY/BUILD FAILURE: Release installer contains 'localhost:1420' devUrl! Bundled assets were not embedded."
    } else {
        Write-Host "PASS: Release installer verified clean of devUrl ($($setupExe.Name))." -ForegroundColor Green
    }
} else {
    Write-Host "Warning: Setup installer not found in expected path." -ForegroundColor Yellow
}

Write-Host "`n==============================================" -ForegroundColor Green
Write-Host " [EDM] Release Build Complete Successfully!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
