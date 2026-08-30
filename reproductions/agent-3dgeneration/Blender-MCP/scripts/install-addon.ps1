[CmdletBinding()]
param(
    [string]$AddonsDir,
    [switch]$EnableTelemetry
)

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$UpstreamRoot = Join-Path $ReproRoot 'upstream'

$OriginalTelemetry = [Environment]::GetEnvironmentVariable('DISABLE_TELEMETRY', 'Process')
$env:DISABLE_TELEMETRY = if ($EnableTelemetry) { 'false' } else { 'true' }

$Arguments = @('run', 'blender-mcp', 'install-addon')
if ($AddonsDir) {
    $Arguments += @('--addons-dir', $AddonsDir)
}

Push-Location $UpstreamRoot
try {
    & uv @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Blender addon installation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable('DISABLE_TELEMETRY', $OriginalTelemetry, 'Process')
}
