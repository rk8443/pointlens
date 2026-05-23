# =====================================================================
#  3D Viewer — one-click Windows installer build
# =====================================================================
#  Right-click this file in File Explorer → "Run with PowerShell".
#  When it finishes you'll get an MSI installer and an NSIS .exe in
#  src-tauri\target\release\bundle\.  Both create a Start Menu entry
#  and a Desktop shortcut for "3D Viewer".
#
#  First run takes ~10-15 minutes (downloads Rust + builds everything).
#  Subsequent runs take ~3 minutes.
#
#  Requirements (the script will check and tell you what's missing):
#    - Windows 10 or 11 (64-bit)
#    - Node.js 20+              https://nodejs.org/
#    - Visual Studio Build Tools with the
#      "Desktop development with C++" workload
#      https://visualstudio.microsoft.com/downloads/?q=build+tools
#    - Rust (installed automatically if missing)
#    - WebView2 runtime (already on Windows 11; auto-installs on Win10)
# =====================================================================

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# --- Move to the artifact root (parent of src-tauri) ---------------
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactRoot = Split-Path -Parent $scriptDir
Set-Location $artifactRoot
Write-Host "Working from: $artifactRoot"

# --- 1. Check Node.js ----------------------------------------------
Write-Step "Checking Node.js"
try {
    $nodeVersion = (& node --version) -replace 'v',''
    Write-Host "Found Node.js $nodeVersion"
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 20) { Fail "Node.js 20 or newer is required (found $nodeVersion). Install from https://nodejs.org/" }
} catch {
    Fail "Node.js is not installed or not on PATH. Install from https://nodejs.org/ (LTS) and re-run."
}

# --- 2. Ensure pnpm -------------------------------------------------
Write-Step "Checking pnpm"
try {
    $pnpmVersion = & pnpm --version
    Write-Host "Found pnpm $pnpmVersion"
} catch {
    Write-Host "pnpm not found, installing via corepack..."
    & corepack enable
    & corepack prepare pnpm@9 --activate
    if ($LASTEXITCODE -ne 0) { Fail "Could not install pnpm. Run 'npm install -g pnpm' manually." }
}

# --- 3. Check / install Rust ---------------------------------------
Write-Step "Checking Rust toolchain"
$rustOk = $false
try {
    $rustcVersion = & rustc --version
    Write-Host "Found $rustcVersion"
    $rustOk = $true
} catch {
    Write-Host "Rust not found — downloading rustup-init..."
    $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupExe
    & $rustupExe -y --default-toolchain stable --profile minimal
    if ($LASTEXITCODE -ne 0) { Fail "Rust installation failed." }
    # Add cargo to current session PATH
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
    $rustOk = $true
}

# --- 4. Verify MSVC build tools (linker) ---------------------------
Write-Step "Checking MSVC linker (link.exe)"
$linkFound = $false
try {
    # Try to find link.exe via the standard vswhere path
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vsInstall) {
            Write-Host "Found Visual Studio at: $vsInstall"
            $linkFound = $true
        }
    }
} catch {}

if (-not $linkFound) {
    Write-Host ""
    Write-Host "WARNING: Visual Studio Build Tools with the C++ workload was not detected." -ForegroundColor Yellow
    Write-Host "If the build fails with a linker error, install from:" -ForegroundColor Yellow
    Write-Host "  https://visualstudio.microsoft.com/downloads/?q=build+tools" -ForegroundColor Yellow
    Write-Host "and select 'Desktop development with C++'." -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "Continue anyway? (y/N)"
    if ($continue -ne 'y' -and $continue -ne 'Y') { exit 1 }
}

# --- 5. Install workspace dependencies -----------------------------
Write-Step "Installing JavaScript dependencies (pnpm install)"
# Run from repo root so workspace dependencies resolve.
$repoRoot = (& git -C $artifactRoot rev-parse --show-toplevel 2>$null)
if (-not $repoRoot -or $LASTEXITCODE -ne 0) {
    # Fall back to walking up to find pnpm-workspace.yaml
    $repoRoot = $artifactRoot
    while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot "pnpm-workspace.yaml"))) {
        $repoRoot = Split-Path -Parent $repoRoot
    }
}
if (-not $repoRoot) { Fail "Could not find repo root (pnpm-workspace.yaml not found)." }
Write-Host "Repo root: $repoRoot"
Push-Location $repoRoot
try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed." }
} finally {
    Pop-Location
}

# --- 6. Build! ------------------------------------------------------
Write-Step "Building the desktop installers (this is the long step)"
Write-Host "First-time builds compile Rust and can take 10-15 minutes."
Write-Host ""
$env:TAURI_BUILD = "1"
& pnpm --filter "@workspace/point-cloud-viewer" run tauri build
if ($LASTEXITCODE -ne 0) { Fail "Tauri build failed. Scroll up to see the error." }

# --- 7. Show where the installers landed ---------------------------
Write-Step "Done!"
$bundleDir = Join-Path $artifactRoot "src-tauri\target\release\bundle"
$msi = Get-ChildItem -Path (Join-Path $bundleDir "msi") -Filter *.msi -ErrorAction SilentlyContinue | Select-Object -First 1
$nsis = Get-ChildItem -Path (Join-Path $bundleDir "nsis") -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1

if ($msi)  { Write-Host "MSI installer : $($msi.FullName)" -ForegroundColor Green }
if ($nsis) { Write-Host "EXE installer : $($nsis.FullName)" -ForegroundColor Green }

if (-not ($msi -or $nsis)) {
    Write-Host "No installer files were found in $bundleDir." -ForegroundColor Yellow
    Write-Host "Check the build output above for errors." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "Double-click either file to install 3D Viewer."
    Write-Host "It will create a Desktop shortcut and a Start Menu entry."
    # Open the folder for the user
    if ($msi) { Start-Process explorer.exe -ArgumentList ("/select,`"" + $msi.FullName + "`"") }
}

Write-Host ""
Read-Host "Press Enter to close"
