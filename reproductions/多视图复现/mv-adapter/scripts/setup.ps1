[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if ($root -notmatch '^([A-Za-z]):\\(.*)$') {
    throw "Expected an absolute Windows drive path, got: $root"
}
$rootWsl = "/mnt/$($Matches[1].ToLower())/$($Matches[2].Replace('\', '/'))"

& wsl.exe -d $Distro -- bash "$rootWsl/scripts/setup_wsl.sh"
if ($LASTEXITCODE -ne 0) {
    throw "MV-Adapter WSL setup failed with exit code $LASTEXITCODE."
}
