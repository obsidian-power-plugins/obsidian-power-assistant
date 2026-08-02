# Power Assistant WhisperX server: one-command setup for Windows.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# What it does, in order: finds Python, makes a private venv (outside your
# vault, so sync never sees it), installs PyTorch matched to your GPU, installs
# the server, asks for a Hugging Face token (Enter to skip; transcription works
# without it, speaker labels do not), registers the server to start when you
# log in, starts it now, waits for it to come up, and prints the address to
# paste into Power Assistant. Safe to run again any time; it only redoes what
# changed.

param([string]$HfToken = $env:HF_TOKEN)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$venv = Join-Path $env:LOCALAPPDATA "PowerAssistant\whisperx-venv"
$runCmd = Join-Path $env:LOCALAPPDATA "PowerAssistant\run-whisperx.cmd"
$taskName = "PowerAssistant WhisperX server"
$port = 8571

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---- Python ----------------------------------------------------------------
Step "Looking for Python (3.10 to 3.12)"
$python = $null
foreach ($cand in @("py -3.12", "py -3.11", "py -3.10", "python")) {
    try {
        $v = Invoke-Expression "$cand --version 2>&1"
        if ($v -match "Python 3\.(\d+)") {
            $minor = [int]$Matches[1]
            if ($minor -ge 10 -and $minor -le 12) { $python = $cand; Write-Host "    using $v ($cand)"; break }
            if ($minor -gt 12 -and -not $python) { Write-Host "    found $v (may not be supported yet; will use it only if nothing older turns up)" }
        }
    } catch { }
}
if (-not $python) {
    Write-Host "No suitable Python found. Install Python 3.12 with:" -ForegroundColor Yellow
    Write-Host "    winget install Python.Python.3.12"
    Write-Host "then run this script again."
    exit 1
}

# ---- venv ------------------------------------------------------------------
Step "Private environment at $venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $venv) | Out-Null
    Invoke-Expression "$python -m venv `"$venv`""
}
$vpy = Join-Path $venv "Scripts\python.exe"
& $vpy -m pip install --upgrade pip --quiet

# ---- PyTorch, matched to the hardware --------------------------------------
$hasNvidia = $false
try { $null = & nvidia-smi 2>$null; if ($LASTEXITCODE -eq 0) { $hasNvidia = $true } } catch { }
$cudaIndex = "https://download.pytorch.org/whl/cu128"
if ($hasNvidia) {
    Step "NVIDIA GPU found; installing CUDA PyTorch (about 3 GB, one time)"
    & $vpy -m pip install torch torchaudio --index-url $cudaIndex
} else {
    Step "No NVIDIA GPU found; installing CPU PyTorch (transcription will be slower)"
    & $vpy -m pip install torch torchaudio
}

# ---- the server ------------------------------------------------------------
Step "Installing the transcription server"
if ($hasNvidia) {
    # the CUDA index rides along: if the server's requirements move to a newer
    # torch, pip must resolve it as +cu, NEVER as the plain-PyPI CPU wheel
    # (which is exactly what a rerun without this once did, silently parking
    # the GPU)
    & $vpy -m pip install -r (Join-Path $here "requirements.txt") --extra-index-url $cudaIndex
} else {
    & $vpy -m pip install -r (Join-Path $here "requirements.txt")
}
# belt and braces: a CPU torch on a CUDA box is never acceptable after this
if ($hasNvidia) {
    $flavor = & $vpy -c "import torch; print(torch.__version__)"
    if ($flavor -notmatch "\+cu") {
        Step "PyTorch came back as CPU ($flavor); restoring the CUDA build"
        & $vpy -m pip install "torch==$($flavor -replace '\+.*','')+cu128" "torchaudio==$($flavor -replace '\+.*','')+cu128" --index-url $cudaIndex
    }
}

# ---- Hugging Face token (speaker labels) -----------------------------------
if (-not $HfToken) {
    Step "Speaker labels need a free Hugging Face token"
    Write-Host "    1. Create a read token at https://huggingface.co/settings/tokens"
    Write-Host "    2. While signed in, open each page and accept its terms:"
    Write-Host "         https://huggingface.co/pyannote/segmentation-3.0"
    Write-Host "         https://huggingface.co/pyannote/speaker-diarization-3.1"
    Write-Host "         https://huggingface.co/pyannote/speaker-diarization-community-1 (newest pipeline)"
    Write-Host "         https://huggingface.co/pyannote/embedding (voiceprints)"
    $HfToken = Read-Host "    Paste the token (or press Enter to skip; you can rerun this script later)"
}

# ---- can the token actually reach the gated models? -------------------------
# The metadata API answers 200 even when terms are NOT accepted; only a file
# fetch tells the truth. Catch it here, not as a silent labels-off at runtime.
if ($HfToken) {
    Step "Checking the token can reach the gated speaker models"
    $gated = @("pyannote/segmentation-3.0", "pyannote/speaker-diarization-3.1", "pyannote/speaker-diarization-community-1", "pyannote/embedding")
    $blocked = @()
    foreach ($r in $gated) {
        $reachable = $false
        try {
            $null = Invoke-WebRequest -Uri "https://huggingface.co/$r/resolve/main/config.yaml" -Headers @{ Authorization = "Bearer $HfToken" } -Method Head -TimeoutSec 10 -ErrorAction Stop
            $reachable = $true
        } catch { }
        if ($reachable) { Write-Host "    ok       $r" }
        else { $blocked += $r; Write-Host "    BLOCKED  $r" -ForegroundColor Yellow }
    }
    if ($blocked.Count -gt 0) {
        Write-Host ""
        Write-Host "    Speaker labels stay OFF until the blocked models are accepted:" -ForegroundColor Yellow
        foreach ($r in $blocked) { Write-Host "      1. Sign in and accept at https://huggingface.co/$r" }
        Write-Host "      2. A fine-grained token also needs the 'gated repositories' read permission (a classic Read token is simplest)."
        Write-Host "      3. Rerun this script (or just restart the server) afterwards; nothing else needs redoing."
        Write-Host "    Labels need segmentation-3.0 plus either diarization pipeline; voiceprints need embedding."
    }
}

# ---- run script + start at logon -------------------------------------------
Step "Registering the server to start when you log in"
$tokenLine = if ($HfToken) { "set HF_TOKEN=$HfToken" } else { "rem no HF token yet; rerun setup.ps1 to add speaker labels" }
@"
@echo off
$tokenLine
"$vpy" "$(Join-Path $here 'server.py')" --port $port
"@ | Set-Content -Path $runCmd -Encoding ASCII
schtasks /Create /F /TN "$taskName" /TR "`"$runCmd`"" /SC ONLOGON 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "    registered task: $taskName"
} else {
    # Corporate policy denies schtasks on some machines. Deliberately NOT
    # writing a Startup-folder launcher here: a script that drops files into
    # Startup is indistinguishable from malware persistence, and antivirus
    # rightly quarantines the whole script for it. Two manual steps do the
    # same job and stay on the right side of the heuristics.
    Write-Host "    Task Scheduler said no (a policy setting on this machine)." -ForegroundColor Yellow
    Write-Host "    To start the server at logon, add it to your Startup folder yourself:"
    Write-Host "      1. Press Win+R, type  shell:startup  and press Enter."
    Write-Host "      2. In that folder: right-click, New, Shortcut, and point it at:"
    Write-Host "         $runCmd"
    Write-Host "    Skip this if you prefer starting the server by hand; it is running now either way."
}

# ---- start it now and wait -------------------------------------------------
Step "Starting the server (first start downloads models, a few GB; be patient)"
$already = $false
try { $null = Invoke-RestMethod "http://localhost:$port/health" -TimeoutSec 2; $already = $true } catch { }
if (-not $already) { Start-Process -WindowStyle Minimized -FilePath $runCmd }
$up = $false
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 5
    try {
        $h = Invoke-RestMethod "http://localhost:$port/health" -TimeoutSec 3
        if ($h.ok) { $up = $true; break }
    } catch { }
    if ($i % 6 -eq 5) { Write-Host "    still starting ($([int](($i+1)*5/60)) min)..." }
}

# ---- the address to paste ---------------------------------------------------
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match "^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)" } |
    Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }

if ($up) {
    $h = Invoke-RestMethod "http://localhost:$port/health"
    $labels = if ($h.diarization) { "speaker labels ON" } else { "speaker labels OFF (no token yet)" }
    Step "The server is up: $($h.model) on $($h.device), $labels"
    Write-Host ""
    Write-Host "Paste this into Power Assistant settings (API keys tab, WhisperX section):" -ForegroundColor Green
    Write-Host ""
    Write-Host "    http://${ip}:$port" -ForegroundColor Green
    Write-Host ""
    Write-Host "Other devices on your network need Windows Firewall to allow the port."
    Write-Host "If they cannot connect, run this once in an ADMIN PowerShell:"
    Write-Host "    netsh advfirewall firewall add rule name=`"PowerAssistant WhisperX`" dir=in action=allow protocol=TCP localport=$port"
} else {
    Step "The server did not come up in 15 minutes"
    Write-Host "It may still be downloading models. Check the minimized console window it started in,"
    Write-Host "or run it by hand to see the log:"
    Write-Host "    `"$runCmd`""
}
