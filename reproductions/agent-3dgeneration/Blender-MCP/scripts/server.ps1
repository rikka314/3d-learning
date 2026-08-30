[CmdletBinding()]
param(
    [string]$BlenderHost = 'localhost',
    [int]$BlenderPort = 9876,
    [switch]$EnableTelemetry
)

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$UpstreamRoot = Join-Path $ReproRoot 'upstream'

$ManagedEnvironment = @('BLENDER_HOST', 'BLENDER_PORT', 'PYTHONUTF8', 'DISABLE_TELEMETRY')
$OriginalEnvironment = @{}
foreach ($Name in $ManagedEnvironment) {
    $OriginalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
}

$env:BLENDER_HOST = $BlenderHost
$env:BLENDER_PORT = $BlenderPort.ToString()
$env:PYTHONUTF8 = '1'
$env:DISABLE_TELEMETRY = if ($EnableTelemetry) { 'false' } else { 'true' }

Push-Location $UpstreamRoot
try {
    uv run blender-mcp
    if ($LASTEXITCODE -ne 0) {
        throw "Blender-MCP server exited with code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
    foreach ($Name in $ManagedEnvironment) {
        [Environment]::SetEnvironmentVariable($Name, $OriginalEnvironment[$Name], 'Process')
    }
}
