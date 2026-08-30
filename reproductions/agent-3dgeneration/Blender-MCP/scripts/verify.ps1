[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ReproRoot = Split-Path -Parent $PSScriptRoot
$UpstreamRoot = Join-Path $ReproRoot 'upstream'
$LogRoot = Join-Path $ReproRoot 'outputs\logs'
$SmokeScript = Join-Path $PSScriptRoot 'mcp_smoke.py'
$SmokeStdoutLog = Join-Path $LogRoot 'mcp-stdio-smoke.txt'
$SmokeStderrLog = Join-Path $LogRoot 'mcp-stdio-smoke.stderr.txt'
$SmokeTimeoutMilliseconds = 30000
$BuildConstraints = Join-Path $ReproRoot 'build-constraints.txt'
$ExpectedUvVersion = '0.12.1'
$PytestRequirement = 'pytest==9.1.1'

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv was not found. Run scripts/setup.ps1 after installing uv.'
}

$ActualUvVersion = ((uv --version) -split '\s+')[1]
if ($ActualUvVersion -ne $ExpectedUvVersion) {
    throw "Expected uv $ExpectedUvVersion, found $ActualUvVersion."
}

$ManagedEnvironment = @('PYTHONUTF8', 'PYTHONIOENCODING', 'UV_LINK_MODE', 'DISABLE_TELEMETRY')
$OriginalEnvironment = @{}
foreach ($Name in $ManagedEnvironment) {
    $OriginalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
}

try {
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:UV_LINK_MODE = 'copy'
    $env:DISABLE_TELEMETRY = 'true'

    Push-Location $UpstreamRoot
    try {
        uv lock --check 2>&1 | Tee-Object -LiteralPath (Join-Path $LogRoot 'lock-check.txt')
        if ($LASTEXITCODE -ne 0) {
            throw "uv lock --check failed with exit code $LASTEXITCODE"
        }

        uv run --with $PytestRequirement pytest -q 2>&1 |
            Tee-Object -LiteralPath (Join-Path $LogRoot 'pytest-tests.txt')
        if ($LASTEXITCODE -ne 0) {
            throw "upstream tests failed with exit code $LASTEXITCODE"
        }

        uv run --with $PytestRequirement pytest -q .\test_process_bbox_validation.py 2>&1 |
            Tee-Object -LiteralPath (Join-Path $LogRoot 'pytest-root-bbox.txt')
        if ($LASTEXITCODE -ne 0) {
            throw "root bbox tests failed with exit code $LASTEXITCODE"
        }

        uv build --build-constraints $BuildConstraints 2>&1 |
            Tee-Object -LiteralPath (Join-Path $LogRoot 'build.txt')
        if ($LASTEXITCODE -ne 0) {
            throw "uv build failed with exit code $LASTEXITCODE"
        }

        uv run blender-mcp --help 2>&1 |
            Tee-Object -LiteralPath (Join-Path $LogRoot 'cli-help.txt')
        if ($LASTEXITCODE -ne 0) {
            throw "CLI smoke test failed with exit code $LASTEXITCODE"
        }

        $UvCommand = (Get-Command uv).Source
        $SmokeProcess = Start-Process `
            -FilePath $UvCommand `
            -ArgumentList @('run', 'python', "`"$SmokeScript`"") `
            -WorkingDirectory $UpstreamRoot `
            -RedirectStandardOutput $SmokeStdoutLog `
            -RedirectStandardError $SmokeStderrLog `
            -WindowStyle Hidden `
            -PassThru

        if (-not $SmokeProcess.WaitForExit($SmokeTimeoutMilliseconds)) {
            $SmokeProcessId = $SmokeProcess.Id
            if ($SmokeProcessId -le 0) {
                throw 'MCP stdio smoke process returned an invalid process ID.'
            }

            & "$env:SystemRoot\System32\taskkill.exe" /PID $SmokeProcessId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and -not $SmokeProcess.HasExited) {
                Stop-Process -Id $SmokeProcessId -Force
            }
            $SmokeProcess.WaitForExit()
            throw "MCP stdio smoke test timed out after $SmokeTimeoutMilliseconds ms"
        }

        $SmokeProcess.WaitForExit()
        Get-Content -LiteralPath $SmokeStderrLog
        Get-Content -LiteralPath $SmokeStdoutLog
        if ($SmokeProcess.ExitCode -ne 0) {
            throw "MCP stdio smoke test failed with exit code $($SmokeProcess.ExitCode)"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($Name in $ManagedEnvironment) {
        [Environment]::SetEnvironmentVariable($Name, $OriginalEnvironment[$Name], 'Process')
    }
}

Write-Host "Blender-MCP verification completed successfully. Logs: $LogRoot"
