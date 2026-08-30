param(
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& wsl.exe -d $Distro --cd $root -- bash scripts/model_load_smoke_wsl.sh
exit $LASTEXITCODE

