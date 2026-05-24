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
Write-Host "First run total: ~15-25 minutes (downloads ~2 GB of build tools)."
Write-Host "After that, double-clicking launch.bat opens the app in ~1 sec."
Write-Host ""
Write-Host "You will see UAC prompts during installs. Click YES to allow." -ForegroundColor Yellow
Write-Host ""

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
Write-Step "Checking pnpm"
try {
    $v = & pnpm --version 2>$null
    Write-Host "    Found pnpm $v - skipping install"
} catch {
    Write-Host "    Trying corepack..."
    & corepack enable 2>&1 | ForEach-Object { Write-Host "    $_" }
    & corepack prepare pnpm@9 --activate 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    corepack failed, falling back to: npm install -g pnpm"
        & npm install -g pnpm 2>&1 | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) { Fail "Could not install pnpm." }
    }
    Refresh-Path
    try {
        $v = & pnpm --version
        Write-Host "    Installed pnpm $v"
    } catch {
        Fail "pnpm installed but not on PATH. Close this window and re-run launch.bat."
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
    Write-Host "    Workload: Desktop development with C++ + Windows 11 SDK (~1.5 GB)"
    Write-Host "    UAC prompt will appear - click YES, then wait. This is the slowest step."
    $vsArgs = @(
        "--quiet", "--wait", "--norestart", "--nocache",
        "--add", "Microsoft.VisualStudio.Workload.VCTools",
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621",
        "--includeRecommended"
    )
    $p = Start-WithProgress -FilePath $vsExe -ArgumentList $vsArgs -Label "Installing VS Build Tools"
    # 0 = success, 3010 = success but reboot suggested
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Fail @"
VS Build Tools installer returned code $($p.ExitCode).
Install manually from https://visualstudio.microsoft.com/downloads/?q=build+tools
Tick 'Desktop development with C++' during install, then re-run launch.bat.
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
Write-Step "Launching 3D Viewer"
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
