# start-local.ps1 — Windows-native equivalent of start-local.sh
#
# Starts the bananaduck backend and frontend together, locally.
# Each process runs in its own labelled console window.
#
# Usage (from PowerShell, in the repo root):
#   .\start-local.ps1
#
# Or just double-click start-local.ps1 from File Explorer.
#
# What it does:
#   1. Verifies prerequisites (venv, bun, frontend deps, both .env files)
#   2. Opens a window titled "bananaduck - backend" running uvicorn :8000
#   3. Opens a window titled "bananaduck - frontend" running `bun dev` :3000
#   4. Waits for Enter, then kills both child process trees and closes every window
#      (including this one, when launched by double-click)
#
# Prerequisites:
#   - .venv at the repo root with backend\requirements.txt installed
#   - bun on PATH (https://bun.sh)
#   - frontend deps installed (cd frontend; bun install)
#   - backend\.env populated from backend\.env.example
#   - frontend\.env.local populated from frontend\.env.local.example

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── resolve paths ──────────────────────────────────────────────────────────
$REPO = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$VENV = Join-Path $REPO '.venv'
$UVICORN = Join-Path $VENV 'Scripts\uvicorn.exe'

# ── prerequisite checks ────────────────────────────────────────────────────
function Fail([string]$msg) {
    Write-Host $msg -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $UVICORN)) {
    Fail "ERROR: venv not found at $VENV`nRun: python -m venv .venv && .venv\Scripts\pip install -r backend\requirements.txt"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "ERROR: bun not found on PATH. Install from https://bun.sh"
}
if (-not (Test-Path (Join-Path $REPO 'frontend\node_modules'))) {
    Fail "ERROR: frontend deps not installed.`nRun: cd frontend; bun install"
}
if (-not (Test-Path (Join-Path $REPO 'backend\.env'))) {
    Fail "ERROR: backend\.env missing. Copy from backend\.env.example and fill in keys."
}
if (-not (Test-Path (Join-Path $REPO 'frontend\.env.local'))) {
    Fail "ERROR: frontend\.env.local missing. Copy from frontend\.env.local.example."
}

# ── helpers ────────────────────────────────────────────────────────────────
function Stop-ServerTree {
    param([System.Diagnostics.Process]$Proc)
    if ($null -eq $Proc -or $Proc.HasExited) { return }
    try {
        Start-Process taskkill -ArgumentList '/T','/F','/PID',$Proc.Id -Wait -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {}
}

function Stop-OrphanServers {
    # Belt-and-braces: if any dev server somehow slipped out of the process tree,
    # kill anything running out of the repo's venv or frontend dir.
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = $_.CommandLine
        ($cmd -match 'uvicorn' -and $cmd -match [regex]::Escape($REPO)) -or
        ($cmd -match 'bun(\.exe)?\s+dev' -and $cmd -match [regex]::Escape($REPO))
    }
    foreach ($t in $targets) {
        try { Stop-Process -Id ([int]$t.ProcessId) -Force -ErrorAction Stop } catch {}
    }
}

function Close-HostWindow {
    # When double-clicked from File Explorer, the host PowerShell window otherwise
    # stays open after the script exits. Detect that case (parent is explorer.exe)
    # and post WM_CLOSE to our console. A no-op when run from a normal terminal.
    try {
        Add-Type -Namespace Win32 -Name Host -MemberDefinition @'
            [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
            [DllImport("user32.dll")]  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@ -ErrorAction Stop
        $hwnd = [Win32.Host]::GetConsoleWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return }
        $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
        if ($parent -le 0) { return }
        $parentName = (Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue).Name
        if ($parentName -ieq 'explorer.exe') {
            [Win32.Host]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
    } catch {}
}

# ── spawn both processes in their own console windows ─────────────────────
# /c (not /k): the cmd window closes as soon as the dev server exits, so there's
# no lingering "press any key to close" prompt left behind.
Write-Host '==> Starting backend on http://localhost:8000' -ForegroundColor Cyan
$backendCmd = "title bananaduck - backend && `"$UVICORN`" backend.main:app --host 0.0.0.0 --port 8000"
$backendProc = Start-Process cmd -ArgumentList '/c', $backendCmd -PassThru -WindowStyle Normal

Write-Host '==> Starting frontend on http://localhost:3000' -ForegroundColor Cyan
$frontendCmd = "title bananaduck - frontend && cd /d `"$REPO\frontend`" && bun dev"
$frontendProc = Start-Process cmd -ArgumentList '/c', $frontendCmd -PassThru -WindowStyle Normal

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  Backend:  http://localhost:8000  (window: "bananaduck - backend")'
Write-Host '  Frontend: http://localhost:3000  (window: "bananaduck - frontend")'
Write-Host ''
Write-Host '  Open the frontend URL in your browser.'
Write-Host '  Press Enter here to stop both, or close the windows yourself.'
Write-Host '============================================================' -ForegroundColor Green

try {
    Read-Host | Out-Null
} catch {
    # Ctrl-C — fall through to cleanup
}

# ── cleanup ────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Shutting down...' -ForegroundColor Yellow
Stop-ServerTree -Proc $backendProc
Stop-ServerTree -Proc $frontendProc
Stop-OrphanServers
Write-Host 'Done.' -ForegroundColor Green

Close-HostWindow
