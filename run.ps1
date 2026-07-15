# Quick PowerShell script: installs dependencies (if needed) and runs the app
Set-Location $PSScriptRoot
$env:ELECTRON_RUN_AS_NODE = $null

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Write-Error "npm.cmd not found. Install Node.js and retry."
  exit 1
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies. This is needed only on first launch."
  npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed. Run Start again after checking the output."
    exit $LASTEXITCODE
  }
}

Write-Host "Starting Media Library..."
if (Test-Path "node_modules\electron\dist\electron.exe") {
  & "node_modules\electron\dist\electron.exe" --disable-gpu --disable-gpu-sandbox --disable-software-rasterizer .
} else {
  npm.cmd run start
}
exit $LASTEXITCODE
