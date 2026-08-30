param(
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& wsl.exe -d $Distro --cd $root -- bash scripts/setup_wsl.sh
exit $LASTEXITCODE
