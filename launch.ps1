# =====================================================================
#  3D Viewer - launch script (Windows)
# =====================================================================
#  Usage:   double-click launch.bat  (which runs this script)
#
#  First run: auto-installs Node.js, Visual Studio C++ Build Tools,
#             Rust, WebView2; installs project deps; builds the desktop
#             app; then launches it.
#  Later runs: just launches the existing 3D Viewer.exe in ~1 second.
#
#  Installers are downloaded directly from Microsoft / Node.js / Rust
#  (no winget required), so this works on older Windows 10 builds too.
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
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user;$env:Path"
}
function Download-File($url, $outPath) {
    Write-Host "  downloading $url"
    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'  # massively speeds up Invoke-WebRequest
    try {
        Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing
    } finally {
        $ProgressPreference = $oldPref
    }
}

# --- Move to the repo root (folder containing this script) ----------
$repoRoot     = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
$artifact     = Join-Path $repoRoot "artifacts\point-cloud-viewer"
$srcTauri     = Join-Path $artifact "src-tauri"
$builtExeDir  = Join-Path $srcTauri "target\release"
$builtExe     = Join-Path $builtExeDir "3D Viewer.exe"
$tempDir      = Join-Path $env:TEMP "3dviewer-setup"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

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
Write-Host "You will see UAC prompts during installs. Click YES to allow." -ForegroundColor Yellow
Write-Host ""

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
    Write-Host "Downloading Node.js 20 LTS installer..."
    $nodeMsi = Join-Path $tempDir "node-lts.msi"
    Download-File "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi" $nodeMsi
    Write-Host "Running Node.js installer (silent, may take 1-2 min, UAC will prompt)..."
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "Node.js installer returned code $($p.ExitCode). Install manually from https://nodejs.org/" }
    Refresh-Path
    try {
        $v = & node --version
        Write-Host "Installed Node.js $v"
    } catch {
        Fail "Node.js installed but not on PATH yet. Close this window and run launch.bat again."
    }
}

# --- 2. pnpm via corepack (ships with Node.js) ---------------------
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

# --- 3. Visual Studio C++ Build Tools (Rust linker needs this) ----
Write-Step "Checking Visual Studio C++ Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveMsvc = $false
if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vs) { Write-Host "Found Visual Studio at: $vs"; $haveMsvc = $true }
}
if (-not $haveMsvc) {
    Write-Host "Downloading Visual Studio 2022 Build Tools bootstrapper..."
    $vsExe = Join-Path $tempDir "vs_BuildTools.exe"
    Download-File "https://aka.ms/vs/17/release/vs_BuildTools.exe" $vsExe
    Write-Host "Running Build Tools installer (~1.5 GB, 5-15 min, UAC will prompt)..."
    Write-Host "Installing workload: Desktop development with C++ + Windows 11 SDK"
    $vsArgs = @(
        "--quiet", "--wait", "--norestart", "--nocache",
        "--add", "Microsoft.VisualStudio.Workload.VCTools",
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621",
        "--includeRecommended"
    )
    $p = Start-Process -FilePath $vsExe -ArgumentList $vsArgs -Wait -PassThru
    # 0 = success, 3010 = success but reboot suggested
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Fail @"
Visual Studio Build Tools installer returned code $($p.ExitCode).
Install manually from https://visualstudio.microsoft.com/downloads/?q=build+tools
Tick 'Desktop development with C++' during install, then re-run launch.bat.
"@
    }
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vs) { Write-Host "MSVC Build Tools installed at: $vs"; $haveMsvc = $true }
    }
    if (-not $haveMsvc) {
        Fail "MSVC Build Tools install did not complete successfully. Try installing manually."
    }
}

# --- 4. Rust --------------------------------------------------------
Write-Step "Checking Rust"
try {
    $v = & rustc --version
    Write-Host "Found $v"
} catch {
    Write-Host "Downloading rustup-init..."
    $rustupExe = Join-Path $tempDir "rustup-init.exe"
    Download-File "https://win.rustup.rs/x86_64" $rustupExe
    Write-Host "Installing Rust stable (silent, ~2 min)..."
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

# --- 5. WebView2 runtime (Tauri needs this at runtime) -------------
Write-Step "Checking WebView2 runtime"
$wv2Keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$hasWv2 = $false
foreach ($k in $wv2Keys) { if (Test-Path $k) { $hasWv2 = $true; break } }
if ($hasWv2) {
    Write-Host "WebView2 already installed."
} else {
    Write-Host "Downloading WebView2 evergreen bootstrapper..."
    $wv2Exe = Join-Path $tempDir "MicrosoftEdgeWebview2Setup.exe"
    try {
        Download-File "https://go.microsoft.com/fwlink/p/?LinkId=2124703" $wv2Exe
        Write-Host "Installing WebView2 runtime (silent)..."
        Start-Process -FilePath $wv2Exe -ArgumentList "/silent /install" -Wait
    } catch {
        Write-Host "WebView2 install attempt failed - usually OK on Win11. Will continue." -ForegroundColor Yellow
    }
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
