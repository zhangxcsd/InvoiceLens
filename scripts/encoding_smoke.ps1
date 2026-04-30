[CmdletBinding()]
param(
  [switch]$Fix
)

$ErrorActionPreference = "Stop"

Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))

# Enforce UTF-8 in current shell for a stable smoke baseline.
$cpBefore = [Console]::OutputEncoding.CodePage
chcp 65001 > $null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ok = $true
function Pass([string]$m) { Write-Output ("[PASS] " + $m) }
function Fail([string]$m) { Write-Output ("[FAIL] " + $m); $script:ok = $false }
function Info([string]$m) { Write-Output ("[INFO] " + $m) }

Info "repo=$(Get-Location)"

# 1) Console code page
$cp = [Console]::OutputEncoding.CodePage
if ($cp -eq 65001) { Pass "Console codepage is UTF-8 (65001)" }
else { Fail "Console codepage is $cp (expect 65001). Run: chcp 65001" }
Info "console codepage before smoke: $cpBefore"

# 2) dev.bat must not have UTF-8 BOM
$devBat = "dev.bat"
if (-not (Test-Path $devBat)) {
  Fail "dev.bat not found"
} else {
  $devPath = (Resolve-Path $devBat).Path
  $bytes = [System.IO.File]::ReadAllBytes($devPath)
  $sig = if ($bytes.Length -ge 3) { @($bytes[0], $bytes[1], $bytes[2]) -join "," } else { "" }
  if ($sig -eq "239,187,191") {
    if ($Fix) {
      $text = [System.IO.File]::ReadAllText($devPath, [System.Text.Encoding]::UTF8)
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($devPath, $text, $utf8NoBom)
      Pass "dev.bat BOM removed (auto-fix)"
    } else {
      Fail "dev.bat has UTF-8 BOM (EF BB BF)"
    }
  } else {
    Pass "dev.bat has no BOM"
  }
}

# 3) dev.bat can run
try {
  cmd /c "dev.bat help >nul"
  if ($LASTEXITCODE -eq 0) { Pass "dev.bat help exits 0" }
  else { Fail "dev.bat help exit code = $LASTEXITCODE" }
} catch {
  Fail "dev.bat help failed: $($_.Exception.Message)"
}

# 4) Local API reachable and payload valid JSON
$url = "http://127.0.0.1:8765/api/subject-library/summary"
try {
  $resp = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 10
  $body = $resp.Content
  $json = $body | ConvertFrom-Json
  if ($resp.StatusCode -eq 200 -and $json.ok -eq $true) {
    Pass "local API reachable ($url)"
  } else {
    Fail "local API response unexpected"
  }
} catch {
  Info "local API not reachable ($url), skip HTTP check"
}

if ($ok) {
  Write-Output "[RESULT] PASS"
  exit 0
}
Write-Output "[RESULT] FAIL"
exit 1
