[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if ($root -notmatch '^([A-Za-z]):\\(.*)$') {
    throw "Expected an absolute Windows drive path, received '$root'."
}
$wslRoot = "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')"
wsl.exe -d $Distro -- bash "$wslRoot/scripts/download_wsl.sh"
if ($LASTEXITCODE -ne 0) {
    throw "Zero123++ checkpoint download failed with exit code $LASTEXITCODE."
}
