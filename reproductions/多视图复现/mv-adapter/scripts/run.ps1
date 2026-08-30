[CmdletBinding()]
param(
    [ValidateSet("i2mv", "ig2mv")]
    [string]$Mode = "i2mv",
    [string]$Image = "",
    [string]$Mesh = "",
    [string]$Output = "outputs/mv-adapter-sd21.png",
    [string]$Prompt = "high quality anatomical teaching model",
    [ValidateRange(1, 200)]
    [int]$Steps = 50,
    [int]$Seed = 0,
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if ($root -notmatch '^([A-Za-z]):\\(.*)$') {
    throw "Expected an absolute Windows drive path, got: $root"
}
$rootWsl = "/mnt/$($Matches[1].ToLower())/$($Matches[2].Replace('\', '/'))"

$wslArguments = @(
    "-d", $Distro, "--", "bash", "$rootWsl/scripts/run_wsl.sh",
    "--mode", $Mode, "--output", $Output, "--prompt", $Prompt,
    "--steps", $Steps.ToString(), "--seed", $Seed.ToString()
)
if ($Image) { $wslArguments += @("--image", $Image) }
if ($Mesh) { $wslArguments += @("--mesh", $Mesh) }

& wsl.exe @wslArguments
if ($LASTEXITCODE -ne 0) {
    throw "MV-Adapter inference failed with exit code $LASTEXITCODE."
}
