# opencli-crz one-paste installer (Windows 10/11 PowerShell)
# powershell -c "irm https://raw.githubusercontent.com/Yakow13/opencli-crz/main/install.ps1 | iex"
# Installs: Node 22+ (winget) -> OpenCLI -> the crz adapter set. No admin rights needed for winget user scope.
$ErrorActionPreference = 'Stop'
$Repo = 'Yakow13/opencli-crz'
$InstallDir = if ($env:CRZ_INSTALL_DIR) { $env:CRZ_INSTALL_DIR } else { "$env:USERPROFILE\.opencli\clis\crz" }

function Say($m) { Write-Host "crz-setup: $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "crz-setup: $m" -ForegroundColor Red; exit 1 }

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:APPDATA\npm"
}

function Test-NodeOk {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    $v = ((node -v) -replace '^v', '') -split '\.'
    ([int]$v[0] -gt 22) -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 5)
}

# ── Node ──────────────────────────────────────────────────────────────────────
Update-PathFromRegistry
if (-not (Test-NodeOk)) {
    Say 'Node 22.5+ not found — installing via winget (OpenJS.NodeJS.LTS)…'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail 'winget missing — install Node LTS (>=22.5) from https://nodejs.org then rerun.'
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-terminations | Out-Null
    Update-PathFromRegistry
    if (-not (Test-NodeOk)) { Fail 'still no suitable node — open a new PowerShell window and rerun the one-liner.' }
}
Say "Node $(node -v)"

# ── OpenCLI ───────────────────────────────────────────────────────────────────
if (Get-Command opencli -ErrorAction SilentlyContinue) {
    Say "OpenCLI present: $(opencli --version 2>$null)"
} else {
    Say 'installing OpenCLI globally…'
    npm install -g @jackwener/opencli --loglevel error
    Update-PathFromRegistry
    if (-not (Get-Command opencli -ErrorAction SilentlyContinue)) { Fail 'opencli not on PATH — open a new window and rerun.' }
}

# ── adapter ───────────────────────────────────────────────────────────────────
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Fail 'bsdtar missing (Windows 10+ includes it) — upgrade Windows or extract manually.' }
Say "downloading $Repo…"
$tmp = Join-Path $env:TEMP ("crz-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $url = try {
        (Invoke-RestMethod 'https://api.github.com/repos/Yakow13/opencli-crz/releases/latest' -ErrorAction Stop).tarball_url
    } catch { $null }
    if (-not $url) { $url = 'https://codeload.github.com/Yakow13/opencli-crz/tar.gz/refs/heads/main' }
    Say "source: $url"
    Invoke-WebRequest -Uri $url -OutFile "$tmp\crz.tar.gz" -UseBasicParsing
    tar -xzf "$tmp\crz.tar.gz" -C $tmp --strip-components=1
    $parent = Split-Path $InstallDir -Parent
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Move-Item $tmp $InstallDir
    Say "installed to $InstallDir"
} finally {
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ── verify ────────────────────────────────────────────────────────────────────
Say 'verifying…'
$list = opencli list crz 2>$null | Out-String
$n = ([regex]::Matches($list, '"command":')).Count
if ($n -lt 12) { Fail "expected >=12 crz commands, found $n" }
Say "commands registered: $n OK"
try {
    $feed = opencli crz feed --limit 1 -f json 2>$null | Out-String
    if ($feed -match '"ok":true') { Say 'live smoke: feed ok OK' } else { throw 'shape fail' }
} catch { Say 'live smoke: CRZ unreachable right now (weekend maintenance?) — install itself is OK, retry later' }
Write-Host ''
Say 'CRZ ready. Try:'
Write-Host '    opencli crz recent --limit 5'
Write-Host '    opencli crz sync --since 2025-01-01   # local mirror for crz sql / crz entity'
