[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$UpstreamRoot = Join-Path $ReproRoot 'upstream'
$LogRoot = Join-Path $ReproRoot 'outputs\logs'
$SetupLog = Join-Path $LogRoot 'setup.txt'
$ExpectedUvVersion = '0.12.1'

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv was not found. Install it from https://docs.astral.sh/uv/ first.'
}

$ActualUvVersion = ((uv --version) -split '\s+')[1]
if ($ActualUvVersion -ne $ExpectedUvVersion) {
    throw "Expected uv $ExpectedUvVersion, found $ActualUvVersion."
}

$OriginalUvLinkMode = [Environment]::GetEnvironmentVariable('UV_LINK_MODE', 'Process')
try {
    $env:UV_LINK_MODE = 'copy'

    Push-Location $UpstreamRoot
    try {
        uv sync --locked --python 3.11 2>&1 | Tee-Object -LiteralPath $SetupLog
        if ($LASTEXITCODE -ne 0) {
            throw "uv sync failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    [Environment]::SetEnvironmentVariable('UV_LINK_MODE', $OriginalUvLinkMode, 'Process')
}

Write-Host "Blender-MCP dependencies are ready. Log: $SetupLog"
