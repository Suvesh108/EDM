# Verification Script for EDM v0.0.7

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   EDM Version 0.0.7 Full Verification Pipeline           " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$allPassed = $true

function Run-Step($name, $command) {
    Write-Host "`n[RUNNING] $name..." -ForegroundColor Yellow
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-Expression $command
    $sw.Stop()
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[PASS] $name ($($sw.Elapsed.TotalSeconds.ToString('F1'))s)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $name failed with exit code $LASTEXITCODE" -ForegroundColor Red
        $script:allPassed = $false
    }
}

# 1. Rust Clippy with -D warnings
Run-Step "Rust Clippy Static Analysis" "cargo clippy --workspace --all-targets -- -D warnings"

# 2. Cargo Workspace Tests
Run-Step "Full Cargo Test Suite" "cargo test --workspace"

# 3. Extension Production Build
Run-Step "Browser Extension Production Build & Hash Verification" "npm --prefix extension run build"

# 4. Frontend Production Build
Run-Step "Frontend Typecheck & Vite Production Build" "npm --prefix apps/desktop run build"

Write-Host "`n==========================================================" -ForegroundColor Cyan
if ($allPassed) {
    Write-Host "   OVERALL RESULT: ALL CHECKS PASSED (GO)                 " -ForegroundColor Green
} else {
    Write-Host "   OVERALL RESULT: VERIFICATION FAILED (NO-GO)            " -ForegroundColor Red
}
Write-Host "==========================================================" -ForegroundColor Cyan
