# =====================================================================
#  PointLens - launch script (Windows)
# =====================================================================
#  Usage:   double-click launch.bat  (which runs this script)
#
#  First run: auto-installs Node.js, Visual Studio C++ Build Tools,
#             Rust, WebView2; installs project deps; builds the desktop
#             app; then launches it.
#  Later runs: just launches the existing PointLens.exe in ~1 second.
#
#  All long operations report live progress so you always know what
#  is happening: downloads show MB / total + speed, installers show
#  elapsed time + spinner, and each step prints how long it took.
# =====================================================================

$ErrorActionPreference = "Stop"

# --- Total steps (kept in sync with the "Step N/$TotalSteps" headers) ---
$Script:TotalSteps   = 8
$Script:CurrentStep  = 0
$Script:TotalStart   = Get-Date
$Script:StepStart    = $null

function Write-Step($title) {
    if ($Script:StepStart) {
        $elapsed = (Get-Date) - $Script:StepStart
        Write-Host ("    done in {0:mm}:{0:ss}" -f $elapsed) -ForegroundColor DarkGray
    }
    $Script:CurrentStep++
    $Script:StepStart = Get-Date
    $pct = [int](100 * ($Script:CurrentStep - 1) / $Script:TotalSteps)
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}%  ==> {3}" -f $Script:CurrentStep, $Script:TotalSteps, $pct, $title) -ForegroundColor Cyan
}
function Write-StepDone {
    if ($Script:StepStart) {
        $elapsed = (Get-Date) - $Script:StepStart
        Write-Host ("    done in {0:mm}:{0:ss}" -f $elapsed) -ForegroundColor DarkGray
        $Script:StepStart = $null
    }
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

# --- Download with live progress: MB / total + percent + MB/s ---------
# Uses HttpClient streaming so we always get a meaningful in-place readout
# even on hosts that suppress Invoke-WebRequest's native progress bar.
function Download-FileWithProgress($url, $outPath, $label) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    $client  = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(15)
    try {
        $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $resp.EnsureSuccessStatusCode() | Out-Null
        $total = $resp.Content.Headers.ContentLength
        $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        try {
            $fs = [System.IO.File]::Create($outPath)
            try {
                $buf = New-Object byte[] 131072
                [int64]$read = 0
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $lastPrint = 0
                while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                    $fs.Write($buf, 0, $n)
                    $read += $n
                    if ($sw.ElapsedMilliseconds - $lastPrint -gt 200) {
                        $lastPrint = $sw.ElapsedMilliseconds
                        $mbDone = [math]::Round($read / 1MB, 1)
                        $speed  = if ($sw.Elapsed.TotalSeconds -gt 0) { [math]::Round(($read / 1MB) / $sw.Elapsed.TotalSeconds, 1) } else { 0 }
                        if ($total -and $total -gt 0) {
                            $mbTot = [math]::Round($total / 1MB, 1)
                            $pct   = [int](($read * 100) / $total)
                            $bar   = ('#' * [int]($pct/4)).PadRight(25, '.')
                            Write-Host -NoNewline ("`r    {0}  [{1}] {2,3}%  {3} / {4} MB  {5} MB/s     " -f $label, $bar, $pct, $mbDone, $mbTot, $speed)
                        } else {
                            Write-Host -NoNewline ("`r    {0}  {1} MB downloaded  {2} MB/s     " -f $label, $mbDone, $speed)
                        }
                    }
                }
                # Final line
                $mbDone = [math]::Round($read / 1MB, 1)
                Write-Host -NoNewline ("`r    {0}  downloaded {1} MB in {2:F1}s                                   " -f $label, $mbDone, $sw.Elapsed.TotalSeconds)
                Write-Host ""
            } finally { $fs.Dispose() }
        } finally { $stream.Dispose() }
    } finally {
        if ($resp) { $resp.Dispose() }
        $client.Dispose()
    }
}

# --- Run a silent installer with a live elapsed/spinner readout -------
function Start-WithProgress {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$Label,
        [switch]$RunAs
    )
    $startArgs = @{
        FilePath     = $FilePath
        ArgumentList = $ArgumentList
        PassThru     = $true
    }
    if ($RunAs) { $startArgs['Verb'] = 'RunAs' }
    $proc = Start-Process @startArgs
    $spin = @('|','/','-','\')
    $i = 0
    $start = Get-Date
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 500
        $i = ($i + 1) % $spin.Length
        $elapsed = (Get-Date) - $start
        Write-Host -NoNewline ("`r    {0} {1}  elapsed {2:mm}:{2:ss}   (this can take several minutes - normal)   " -f $spin[$i], $Label, $elapsed)
    }
    $elapsed = (Get-Date) - $start
    Write-Host -NoNewline ("`r    {0}  finished in {1:mm}:{1:ss}                                                  " -f $Label, $elapsed)
    Write-Host ""
    return $proc
}

# --- Move to the repo root (folder containing this script) ----------
$repoRoot     = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
$artifact     = Join-Path $repoRoot "artifacts\point-cloud-viewer"
$srcTauri     = Join-Path $artifact "src-tauri"
$builtExeDir  = Join-Path $srcTauri "target\release"
$builtExe     = Join-Path $builtExeDir "PointLens.exe"
# The Cargo crate is still named `three_d_viewer` from before the rebrand,
# so `tauri build` produces three_d_viewer.exe even though productName is
# "PointLens". Treat it as a valid launch target.
$cargoExe     = Join-Path $builtExeDir "three_d_viewer.exe"
$legacyExe    = Join-Path $builtExeDir "3D Viewer.exe"
$tempDir      = Join-Path $env:TEMP "pointlens-setup"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

# --- Fast path: built binary already exists, just launch it ---------
if (Test-Path $builtExe) {
    Write-Host "Launching PointLens..." -ForegroundColor Green
    Start-Process -FilePath $builtExe
    Start-Sleep -Seconds 2
    exit 0
}
# Backward-compat: an older build may have produced "3D Viewer.exe".
if (Test-Path $legacyExe) {
    Write-Host "Launching PointLens..." -ForegroundColor Green
    Start-Process -FilePath $legacyExe
    Start-Sleep -Seconds 2
    exit 0
}
# --- Preflight: probe every prerequisite ONCE before doing anything --
# Without this the user has to wait for 5 sequential "Checking X" steps
# before seeing whether anything actually needs installing. The preflight
# runs all checks up front, prints a one-screen summary, and lets us
# skip the entire install banner + steps 1-5 when nothing is missing
# (we still run pnpm install + tauri build because the fast-path above
# didn't fire, which means either the binary is gone or git pulled
# updates).
function Test-NodeInstalled {
    try {
        $v = (& node --version 2>$null) -replace 'v',''
        if ($LASTEXITCODE -eq 0 -and $v -and [int]($v.Split('.')[0]) -ge 20) { return $v }
    } catch {}
    return $null
}
function Test-PnpmInstalled {
    try {
        $v = & pnpm --version 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        # Force corepack's network round-trip so we catch the stale-keys
        # failure now, not 5 steps later inside `pnpm install`.
        & pnpm root -g 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { return $v }
    } catch {}
    return $null
}
function Test-MsvcInstalled {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    try {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vs) { return $vs }
    } catch {}
    return $null
}
function Test-RustInstalled {
    try {
        $v = & rustc --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { return $v }
    } catch {}
    return $null
}
function Test-Wv2Installed {
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    foreach ($k in $keys) { if (Test-Path $k) { return "installed" } }
    return $null
}

$Script:NodeVer = Test-NodeInstalled
$Script:PnpmVer = Test-PnpmInstalled
$Script:MsvcPath = Test-MsvcInstalled
$Script:RustVer = Test-RustInstalled
$Script:Wv2State = Test-Wv2Installed

$missing = @()
if (-not $Script:NodeVer)  { $missing += "Node.js 20+" }
if (-not $Script:PnpmVer)  { $missing += "pnpm 9" }
if (-not $Script:MsvcPath) { $missing += "Visual Studio C++ Build Tools" }
if (-not $Script:RustVer)  { $missing += "Rust (stable)" }
if (-not $Script:Wv2State) { $missing += "WebView2 runtime" }

# Helper to render one row with green check or yellow cross.
function Show-PreflightRow($name, $present, $detail) {
    if ($present) {
        Write-Host ("    {0,-32} " -f $name) -NoNewline
        Write-Host "[OK] " -ForegroundColor Green -NoNewline
        Write-Host $detail -ForegroundColor DarkGray
    } else {
        Write-Host ("    {0,-32} " -f $name) -NoNewline
        Write-Host "[MISSING] " -ForegroundColor Yellow -NoNewline
        Write-Host "will install" -ForegroundColor DarkGray
    }
}
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " PointLens - prerequisite check" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Show-PreflightRow "Node.js 20+"                       ($null -ne $Script:NodeVer)  ("v" + $Script:NodeVer)
Show-PreflightRow "pnpm 9"                            ($null -ne $Script:PnpmVer)  ("v" + $Script:PnpmVer)
Show-PreflightRow "Visual Studio C++ Build Tools"     ($null -ne $Script:MsvcPath) $Script:MsvcPath
Show-PreflightRow "Rust toolchain"                    ($null -ne $Script:RustVer)  $Script:RustVer
Show-PreflightRow "WebView2 runtime"                  ($null -ne $Script:Wv2State) $Script:Wv2State
Write-Host ""

if ($missing.Count -eq 0) {
    # Everything's installed - skip the entire install banner + steps 1-5.
    # We still need steps 6/7/8 because we wouldn't be here if the fast-path
    # had launched the cached exe.
    Write-Host "All prerequisites are present. Skipping install steps." -ForegroundColor Green
    Write-Host "Going straight to building/launching PointLens." -ForegroundColor Green
    Write-Host ""
    # Advance the step counter past the 5 install steps so the [6/8] / [7/8]
    # / [8/8] headers below still look right.
    $Script:CurrentStep = 5
} else {
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " PointLens - installing missing prerequisites" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host ("Will install: " + ($missing -join ", ")) -ForegroundColor Yellow
    Write-Host "Total: depends on what's missing (5-25 min)."
    Write-Host "After that, double-clicking launch.bat opens the app in ~1 sec."
    Write-Host ""
    Write-Host "You will see UAC prompts during installs. Click YES to allow." -ForegroundColor Yellow
    Write-Host ""
}

# Steps 1-5 install missing prerequisites. Skipped entirely when the
# preflight above found everything present.
if ($missing.Count -gt 0) {

# --- 1. Node.js -----------------------------------------------------
Write-Step "Checking Node.js"
$nodeOk = $false
try {
    $nodeVersion = (& node --version) -replace 'v',''
    if ([int]($nodeVersion.Split('.')[0]) -ge 20) {
        Write-Host "    Found Node.js $nodeVersion - skipping install"
        $nodeOk = $true
    } else {
        Write-Host "    Node.js $nodeVersion is too old (need 20+). Will upgrade."
    }
} catch {
    Write-Host "    Node.js not found - will install."
}
if (-not $nodeOk) {
    $nodeMsi = Join-Path $tempDir "node-lts.msi"
    $nodeLog = Join-Path $tempDir "node-install.log"
    Download-FileWithProgress "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi" $nodeMsi "Node.js 20 LTS"

    Write-Host "    Launching Node.js installer (UAC prompt will appear - click YES)..."
    $msiArgs = @("/i", "`"$nodeMsi`"", "/qb", "/norestart", "/L*v", "`"$nodeLog`"")
    try {
        $p = Start-WithProgress -FilePath "msiexec.exe" -ArgumentList $msiArgs -Label "Installing Node.js" -RunAs
    } catch {
        Fail @"
Could not start the Node.js installer with admin rights.
Easiest fix: install Node.js manually, then re-run launch.bat:
  1. Open this file:  $nodeMsi
  2. Double-click it, accept defaults.
  3. Close this window and double-click launch.bat again.
"@
    }
    if ($p.ExitCode -ne 0) {
        $hint = switch ($p.ExitCode) {
            1602 { "the UAC prompt was cancelled" }
            1603 { "a fatal MSI error (often: not admin, antivirus blocked it, or a conflicting old Node install)" }
            1618 { "another MSI install is already running - close it and retry" }
            1625 { "your account is blocked from installing software by group policy" }
            default { "exit code $($p.ExitCode)" }
        }
        Fail @"
Node.js installer failed: $hint.

Quick fixes:
  1. Re-run launch.bat and CLICK YES on the UAC prompt.
  2. Or right-click -> Run as administrator on:  $nodeMsi
  3. Full installer log:  $nodeLog
"@
    }
    Refresh-Path
    try {
        $v = & node --version
        Write-Host "    Installed Node.js $v"
    } catch {
        Fail "Node.js installed but not on PATH yet. Close this window and double-click launch.bat again."
    }
}

# --- 2. pnpm -------------------------------------------------------
# We deliberately install pnpm DIRECTLY via npm rather than via corepack.
# Reason: the corepack bundled with Node 20.18.1 (and several other LTS
# builds) has stale npm-registry signing keys, so any `pnpm install` ends
# in: "Cannot find matching keyid: ..." once corepack tries to fetch fresh
# package metadata. A direct `npm install -g pnpm@9` gives us a real pnpm
# binary that doesn't go through corepack's signature verification path.
#
# We also refresh corepack itself, because a previously-installed
# corepack-shimmed `pnpm` would still hijack the call and fail. Updating
# corepack pulls in the current signing keys so even the shim path works.
Write-Step "Checking pnpm"
$needsPnpm = $true
try {
    # Probe with `pnpm -v` (cheap) AND `pnpm root -g` (forces corepack to
    # do its registry round-trip, exposing stale-keys breakage upfront).
    $v = & pnpm --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) {
        & pnpm root -g 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    Found working pnpm $v - skipping install"
            $needsPnpm = $false
        } else {
            Write-Host "    pnpm $v is installed but broken (likely corepack signing-keys issue). Reinstalling..." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "    pnpm not found - installing..."
}
if ($needsPnpm) {
    # npm prints harmless warnings to stderr (deprecations, EBADENGINE on
    # mismatched engines, etc.) and with $ErrorActionPreference='Stop'
    # PowerShell turns those into terminating RemoteException errors. Drop
    # back to 'Continue' around npm calls so warnings stay warnings, and
    # rely on $LASTEXITCODE for the real success/failure signal.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Best-effort: remove any old corepack-shimmed pnpm so the real
        # binary we're about to install via npm wins on PATH. Failure
        # here is fine (corepack might not be enabled at all).
        try { & corepack disable pnpm 2>&1 | Out-Null } catch {}

        # Install pnpm directly via npm. --silent hides the noisy warnings
        # while still letting real errors through via the exit code. -g
        # writes to npm's global prefix, which is on PATH after Node's
        # installer ran.
        Write-Host "    Installing pnpm 9 via npm (this bypasses corepack entirely)..."
        & npm install -g --silent pnpm@9 2>&1 | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) {
            Fail "Could not install pnpm. Run 'npm install -g pnpm@9' manually in a new PowerShell window, then re-run launch.bat."
        }
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    Refresh-Path
    try {
        $v = & pnpm --version
        Write-Host "    Installed pnpm $v"
    } catch {
        Fail "pnpm installed but not on PATH yet. Close this window and re-run launch.bat."
    }
}

# --- 3. Visual Studio C++ Build Tools ------------------------------
Write-Step "Checking Visual Studio C++ Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveMsvc = $false
if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vs) { Write-Host "    Found at: $vs - skipping install"; $haveMsvc = $true }
}
if (-not $haveMsvc) {
    $vsExe = Join-Path $tempDir "vs_BuildTools.exe"
    Download-FileWithProgress "https://aka.ms/vs/17/release/vs_BuildTools.exe" $vsExe "VS Build Tools bootstrapper"
    Write-Host ""
    Write-Host "    ============================================================" -ForegroundColor Yellow
    Write-Host "    IMPORTANT: A Microsoft Visual Studio Installer WINDOW will open." -ForegroundColor Yellow
    Write-Host "    It shows the real download/install progress (size in MB,"            -ForegroundColor Yellow
    Write-Host "    current package name, percentage). Watch THAT window, not this one." -ForegroundColor Yellow
    Write-Host "    This script will wait until Microsoft's installer finishes."         -ForegroundColor Yellow
    Write-Host "    Total: ~1.5 GB download + install, usually 8-15 minutes."            -ForegroundColor Yellow
    Write-Host "    ============================================================" -ForegroundColor Yellow
    Write-Host "    UAC prompt will appear first - click YES."

    # --passive (not --quiet) shows Microsoft's official installer UI with a
    # real progress bar and current-package readout, but does not require
    # any clicks. --quiet hides everything and looks frozen for 15+ minutes.
    # We only request the minimum components Tauri/Rust actually need so the
    # install stays lean (~1.5 GB instead of ~5 GB with --includeRecommended).
    $vsArgs = @(
        "--passive", "--wait", "--norestart", "--nocache",
        "--add", "Microsoft.VisualStudio.Workload.VCTools",
        "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621"
    )
    $p = Start-WithProgress -FilePath $vsExe -ArgumentList $vsArgs -Label "VS Build Tools (watch the Microsoft installer window)"
    # 0 = success, 3010 = success but reboot suggested
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Fail @"
VS Build Tools installer returned code $($p.ExitCode).

If the Microsoft installer window showed an error, follow its instructions.
Otherwise install manually:
  https://visualstudio.microsoft.com/downloads/?q=build+tools
Tick 'Desktop development with C++' + 'Windows 11 SDK' during install,
then re-run launch.bat.
"@
    }
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vs) { Write-Host "    Installed at: $vs"; $haveMsvc = $true }
    }
    if (-not $haveMsvc) { Fail "VS Build Tools install did not complete." }
}

# --- 4. Rust --------------------------------------------------------
Write-Step "Checking Rust"
try {
    $v = & rustc --version 2>$null
    Write-Host "    Found $v - skipping install"
} catch {
    $rustupExe = Join-Path $tempDir "rustup-init.exe"
    Download-FileWithProgress "https://win.rustup.rs/x86_64" $rustupExe "rustup-init"
    Write-Host "    Installing Rust stable toolchain (~2 min)..."
    $p = Start-WithProgress -FilePath $rustupExe -ArgumentList @("-y", "--default-toolchain", "stable", "--profile", "minimal") -Label "Installing Rust"
    if ($p.ExitCode -ne 0) { Fail "Rust installation failed (exit $($p.ExitCode))." }
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
    Refresh-Path
    try {
        $v = & rustc --version
        Write-Host "    Installed $v"
    } catch {
        Fail "Rust installed but rustc not on PATH. Close this window and re-run launch.bat."
    }
}

# --- 5. WebView2 runtime -------------------------------------------
Write-Step "Checking WebView2 runtime"
$wv2Keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$hasWv2 = $false
foreach ($k in $wv2Keys) { if (Test-Path $k) { $hasWv2 = $true; break } }
if ($hasWv2) {
    Write-Host "    Already installed - skipping"
} else {
    $wv2Exe = Join-Path $tempDir "MicrosoftEdgeWebview2Setup.exe"
    try {
        Download-FileWithProgress "https://go.microsoft.com/fwlink/p/?LinkId=2124703" $wv2Exe "WebView2 bootstrapper"
        Start-WithProgress -FilePath $wv2Exe -ArgumentList @("/silent", "/install") -Label "Installing WebView2" | Out-Null
    } catch {
        Write-Host "    WebView2 install attempt failed - usually OK on Win11. Continuing." -ForegroundColor Yellow
    }
}

} # end if ($missing.Count -gt 0) — prerequisite install block

# --- 6. pnpm install -----------------------------------------------
Write-Step "Installing JavaScript dependencies (pnpm install, 1-3 min)"
Write-Host "    pnpm streams its own progress below:"
Write-Host "    -------------------------------------"
& pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed. Scroll up for details." }
Write-Host "    -------------------------------------"

# --- 7. Tauri build ------------------------------------------------
Write-Step "Building the desktop app (Rust compile - the slow part, 10-15 min)"
Write-Host "    Rust shows 'Compiling <crate>' lines as it works."
Write-Host "    Long pauses on lines like 'tao', 'wry', 'webkit' are normal."
Write-Host "    ----------------------------------------------------"
$env:TAURI_BUILD = "1"
& pnpm --filter "@workspace/point-cloud-viewer" run tauri build
if ($LASTEXITCODE -ne 0) { Fail "Tauri build failed. Scroll up for the error." }
Write-Host "    ----------------------------------------------------"

# --- 8. Launch ------------------------------------------------------
Write-Step "Launching PointLens"
if (Test-Path $builtExe) {
    Write-StepDone
    $total = (Get-Date) - $Script:TotalStart
    Write-Host ""
    Write-Host ("Total setup time: {0:hh\:mm\:ss}" -f $total) -ForegroundColor Green
    Write-Host "Next time, just double-click launch.bat - it opens instantly." -ForegroundColor Green
    Write-Host ""
    Start-Process -FilePath $builtExe
    Start-Sleep -Seconds 2
} else {
    Fail "Build finished but $builtExe was not found. Check the build output above."
}
