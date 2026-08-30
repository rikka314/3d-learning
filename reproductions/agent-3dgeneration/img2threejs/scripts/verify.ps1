[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$ShowcaseRoot = Join-Path $ReproRoot 'showcase'
$UpstreamRoot = Join-Path $ReproRoot 'upstream'
$LogRoot = Join-Path $ReproRoot 'outputs\logs'

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

Push-Location $ShowcaseRoot
try {
    npm run build 2>&1 | Tee-Object -LiteralPath (Join-Path $LogRoot 'showcase-build.txt')
    if ($LASTEXITCODE -ne 0) {
        throw "showcase build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$env:IMG2THREEJS_SHOWCASE_ROOT = $ShowcaseRoot
$env:IMG2THREEJS_REQUIRE_SHOWCASE = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:Path = (Join-Path $ShowcaseRoot 'node_modules\.bin') + ';' + $env:Path

Push-Location $UpstreamRoot
try {
    uv run --no-project --python 3.11 python -m unittest discover -s forge/tests -p 'test_*.py' -v 2>&1 |
        Tee-Object -LiteralPath (Join-Path $LogRoot 'unittest-v1.5.1.txt')
    if ($LASTEXITCODE -ne 0) {
        throw "img2threejs tests failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host 'Build and test verification completed successfully.'

