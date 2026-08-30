param(
    [ValidateSet("standard", "ortho")]
    [string]$Variant = "standard",
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& wsl.exe -d $Distro --cd $root -- bash scripts/download_weights_wsl.sh $Variant
exit $LASTEXITCODE
