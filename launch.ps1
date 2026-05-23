# =====================================================================
#  3D Viewer — launch script (Windows)
# =====================================================================
#  Usage:   double-click launch.bat  (which runs this script)
#  Or:      Right-click launch.ps1 -> "Run with PowerShell"
#
#  First run: checks for Node + Rust + MSVC, installs deps, builds the
#             desktop app, then launches it.
#  Later runs: just launches the existing 3D Viewer.exe.
# =====================================================================

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# --- Move to the repo root (folder containing this script) ----------
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$artifact     = Join-Path $repoRoot "artifacts\point-cloud-viewer"
$srcTauri     = Join-Path $artifact "src-tauri"
$builtExeDir  = Join-Path $srcTauri "target\release"
$builtExe     = Join-Path $builtExeDir "3D Viewer.exe"

# --- Fast path: built binary already exists, just launch it ---------
if (Test-Path $builtExe) {
    Write-Host "Launching 3D Viewer..." -ForegroundColor Green
    Start-Process -FilePath $builtExe
    Start-Sleep -Seconds 2
    exit 0
}

Write-Host "First-time setup. This will install dependencies and build the desktop app."
Write-Host "Expect 10-15 minutes on the first run. After that, launching takes 1 second."

# --- 1. Node.js -----------------------------------------------------
Write-Step "Checking Node.js"
try {
    $nodeVersion = (& node --version) -replace 'v',''
    Write-Host "Found Node.js $nodeVersion"
    if ([int]($nodeVersion.Split('.')[0]) -lt 20) {
        Fail "Node.js 20 or newer required. Install LTS from https://nodejs.org/"
    }
} catch {
    Fail "Node.js not found. Install LTS from https://nodejs.org/ then re-run."
}

# --- 2. pnpm via corepack ------------------------------------------
Write-Step "Checking pnpm"
try {
    $v = & pnpm --version
    Write-Host "Found pnpm $v"
} catch {
    Write-Host "Installing pnpm via corepack..."
    & corepack enable
    & corepack prepare pnpm@9 --activate
    if ($LASTEXITCODE -ne 0) { Fail "Could not install pnpm. Run: npm install -g pnpm" }
}

# --- 3. Rust --------------------------------------------------------
Write-Step "Checking Rust"
$rustOk = $false
try {
    $v = & rustc --version
    Write-Host "Found $v"
    $rustOk = $true
} catch {
    Write-Host "Rust not found. Downloading rustup-init..."
    $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupExe
    & $rustupExe -y --default-toolchain stable --profile minimal
    if ($LASTEXITCODE -ne 0) { Fail "Rust installation failed." }
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
    $rustOk = $true
}

# --- 4. MSVC build tools check (warn only) -------------------------
Write-Step "Checking Visual Studio C++ Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveMsvc = $false
if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vs) { Write-Host "Found Visual Studio at: $vs"; $haveMsvc = $true }
}
if (-not $haveMsvc) {
    Write-Host "MSVC Build Tools not detected." -ForegroundColor Yellow
    Write-Host "If the build fails with a linker error, install from:" -ForegroundColor Yellow
    Write-Host "  https://visualstudio.microsoft.com/downloads/?q=build+tools" -ForegroundColor Yellow
    Write-Host "and tick 'Desktop development with C++'." -ForegroundColor Yellow
    $continue = Read-Host "Continue anyway? (y/N)"
    if ($continue -ne 'y' -and $continue -ne 'Y') { exit 1 }
}

# --- 5. pnpm install ------------------------------------------------
Write-Step "Installing JavaScript dependencies (pnpm install)"
& pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed." }

# --- 6. Tauri build -------------------------------------------------
Write-Step "Building the desktop app (Rust compile — this is the slow part)"
$env:TAURI_BUILD = "1"
& pnpm --filter "@workspace/point-cloud-viewer" run tauri build
if ($LASTEXITCODE -ne 0) { Fail "Tauri build failed. Scroll up for the error." }

# --- 7. Launch ------------------------------------------------------
if (Test-Path $builtExe) {
    Write-Step "Done. Launching 3D Viewer..."
    Start-Process -FilePath $builtExe
    Write-Host ""
    Write-Host "Next time, just double-click launch.bat and it will open instantly." -ForegroundColor Green
    Start-Sleep -Seconds 2
} else {
    Fail "Build finished but $builtExe was not found. Check the build output above."
}
