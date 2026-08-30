[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias("Input")]
    [string]$InputPath,
    [string]$Output = "",
    [ValidateRange(1, 100)]
    [int]$Steps = 28,
    [int]$Seed = 42,
    [switch]$CpuOffload,
    [switch]$Offline,
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
function Convert-ToWslPath([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath -notmatch '^([A-Za-z]):\\(.*)$') {
        throw "Expected an absolute Windows drive path, received '$fullPath'."
    }
    return "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')"
}
$wslRoot = Convert-ToWslPath $root
$wslInput = Convert-ToWslPath $resolvedInput
$arguments = @("$wslRoot/scripts/run_wsl.sh", "--input", $wslInput, "--steps", "$Steps", "--seed", "$Seed")

if ($Output) {
    $outputParent = Split-Path -Parent $Output
    if ($outputParent) {
        New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
    }
    $absoluteOutput = [System.IO.Path]::GetFullPath($Output)
    $wslOutput = Convert-ToWslPath $absoluteOutput
    $arguments += @("--output", $wslOutput)
}
if ($CpuOffload) { $arguments += "--cpu-offload" }
if ($Offline) { $arguments += "--offline" }

wsl.exe -d $Distro -- bash @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Zero123++ inference failed with exit code $LASTEXITCODE."
}
