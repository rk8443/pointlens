# =====================================================================
#  3D Viewer - launch script (Windows)
# =====================================================================
#  Usage:   double-click launch.bat  (which runs this script)
#  Or:      Right-click launch.ps1 -> "Run with PowerShell"
#
#  First run: auto-installs all prerequisites (Node.js, pnpm, Rust,
#             Visual Studio C++ Build Tools), installs project deps,
#             builds the desktop app, then launches it.
#  Later runs: just launches the existing 3D Viewer.exe - no checks.
#
#  Requires Windows 10/11 64-bit with winget available (winget is
#  preinstalled on Windows 11 and on up-to-date Windows 10).
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

# Refresh PATH for current session after installs that added to system PATH.
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user;$env:Path"
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

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " 3D Viewer - first-time setup" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "This will install everything needed and build the app."
Write-Host "First run: 15-25 minutes (downloads ~2 GB of build tools)."
Write-Host "After that, double-clicking launch.bat opens the app in 1 sec."
Write-Host ""

# --- 0. Check winget (needed for auto-installs) --------------------
Write-Step "Checking winget"
try {
    & winget --version | Out-Null
    Write-Host "winget OK"
} catch {
    Fail @"
winget is not available on this system.
winget ships with Windows 11 and recent Windows 10 builds.
Update Windows or install 'App Installer' from the Microsoft Store, then re-run.
"@
}

# --- 1. Node.js -----------------------------------------------------
Write-Step "Checking Node.js"
$nodeOk = $false
try {
    $nodeVersion = (& node --version) -replace 'v',''
    if ([int]($nodeVersion.Split('.')[0]) -ge 20) {
        Write-Host "Found Node.js $nodeVersion"
        $nodeOk = $true
    } else {
        Write-Host "Node.js $nodeVersion is too old (need 20+). Will upgrade."
    }
} catch {
    Write-Host "Node.js not found."
}
if (-not $nodeOk) {
    Write-Host "Installing Node.js LTS via winget..."
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) { Fail "Node.js install failed. Install manually from https://nodejs.org/ and re-run." }
    Refresh-Path
    try {
        $v = & node --version
        Write-Host "Installed Node.js $v"
    } catch {
        Fail "Node.js installed but not on PATH. Close this window and run launch.bat again."
    }
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
    if ($LASTEXITCODE -ne 0) {
        Write-Host "corepack failed, falling back to npm..."
        & npm install -g pnpm
        if ($LASTEXITCODE -ne 0) { Fail "Could not install pnpm." }
    }
    Refresh-Path
}

# --- 3. Visual Studio C++ Build Tools (needed for Rust linker) -----
Write-Step "Checking Visual Studio C++ Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveMsvc = $false
if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vs) { Write-Host "Found Visual Studio at: $vs"; $haveMsvc = $true }
}
if (-not $haveMsvc) {
    Write-Host "MSVC Build Tools not found. Installing via winget (this is the big one - ~1.5 GB, 5-10 min)..."
    # Install Build Tools with the required workload and Windows SDK.
    & winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --silent --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "winget reported an error code $LASTEXITCODE. Re-checking..." -ForegroundColor Yellow
    }
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vs) { Write-Host "MSVC Build Tools installed at: $vs"; $haveMsvc = $true }
    }
    if (-not $haveMsvc) {
        Fail @"
MSVC Build Tools install did not complete successfully.
Please install manually:
  https://visualstudio.microsoft.com/downloads/?q=build+tools
Tick 'Desktop development with C++' during install, then re-run launch.bat.
"@
    }
}

# --- 4. Rust --------------------------------------------------------
Write-Step "Checking Rust"
try {
    $v = & rustc --version
    Write-Host "Found $v"
} catch {
    Write-Host "Rust not found. Downloading rustup-init..."
    $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupExe
    & $rustupExe -y --default-toolchain stable --profile minimal
    if ($LASTEXITCODE -ne 0) { Fail "Rust installation failed." }
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
    Refresh-Path
    try {
        $v = & rustc --version
        Write-Host "Installed $v"
    } catch {
        Fail "Rust installed but rustc not on PATH. Close this window and run launch.bat again."
    }
}

# --- 5. WebView2 runtime (needed at runtime by Tauri) --------------
Write-Step "Checking WebView2 runtime"
$webview2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$hasWebView2 = Test-Path $webview2Key
if ($hasWebView2) {
    Write-Host "WebView2 already installed."
} else {
    Write-Host "Installing WebView2 runtime via winget..."
    & winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements --silent 2>$null
    # Non-fatal if it can't - Windows 11 always has it; some Win10 builds too.
}

# --- 6. pnpm install ------------------------------------------------
Write-Step "Installing JavaScript dependencies (pnpm install)"
& pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed. Scroll up for details." }

# --- 7. Tauri build -------------------------------------------------
Write-Step "Building the desktop app (Rust compile - slow part, 10-15 min)"
$env:TAURI_BUILD = "1"
& pnpm --filter "@workspace/point-cloud-viewer" run tauri build
if ($LASTEXITCODE -ne 0) { Fail "Tauri build failed. Scroll up for the error." }

# --- 8. Launch ------------------------------------------------------
if (Test-Path $builtExe) {
    Write-Step "Done. Launching 3D Viewer..."
    Start-Process -FilePath $builtExe
    Write-Host ""
    Write-Host "Next time, just double-click launch.bat - it opens instantly." -ForegroundColor Green
    Start-Sleep -Seconds 2
} else {
    Fail "Build finished but $builtExe was not found. Check the build output above."
}
