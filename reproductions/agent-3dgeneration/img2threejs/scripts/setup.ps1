[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$ShowcaseRoot = Join-Path $ReproRoot 'showcase'

Push-Location $ShowcaseRoot
try {
    npm ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host 'img2threejs showcase dependencies are ready.'

