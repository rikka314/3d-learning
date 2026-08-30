[CmdletBinding()]
param(
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$ShowcaseRoot = Join-Path $ReproRoot 'showcase'

Push-Location $ShowcaseRoot
try {
    npm run preview -- --host 127.0.0.1 --port $Port
}
finally {
    Pop-Location
}

