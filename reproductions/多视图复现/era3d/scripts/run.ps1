param(
    [ValidateSet("standard", "ortho")]
    [string]$Variant = "standard",
    [int]$Seed = 600,
    [ValidateSet(400, 420)]
    [int]$CropSize = 420,
    [ValidateRange(0, 8)]
    [int]$DataloaderWorkers = 0,
    [switch]$DryRun,
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dryRunValue = if ($DryRun) { 1 } else { 0 }
& wsl.exe -d $Distro --cd $root -- bash scripts/run_wsl.sh $Variant $Seed $CropSize $DataloaderWorkers $dryRunValue
exit $LASTEXITCODE
