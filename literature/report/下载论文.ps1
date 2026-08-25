#requires -Version 7.4

param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '3D生成与3D_AI最新进展_文献与PDF下载清单.tsv'),
    [string]$PaperDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'papers\3D生成与3D_AI最新进展_2026')
)

$ErrorActionPreference = 'Stop'
$rows = Import-Csv -LiteralPath $ManifestPath -Delimiter "`t"
New-Item -ItemType Directory -Force -Path $PaperDirectory | Out-Null

$results = $rows | ForEach-Object -Parallel {
    $row = $_
    $leafName = [System.IO.Path]::GetFileName($row.filename)
    if ($leafName -ne $row.filename) {
        return [pscustomobject]@{
            id = $row.id
            status = 'FAIL'
            bytes = 0
            file = $row.filename
            error = 'Manifest filename must be a leaf name without path components.'
        }
    }

    $destination = Join-Path $using:PaperDirectory $leafName
    $existingIsPdf = $false
    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Length -gt 10000)) {
        $stream = [System.IO.File]::OpenRead($destination)
        try {
            $headerBytes = [byte[]]::new(5)
            [void]$stream.Read($headerBytes, 0, 5)
            $existingIsPdf = [System.Text.Encoding]::ASCII.GetString($headerBytes) -eq '%PDF-'
        }
        finally {
            $stream.Dispose()
        }
    }

    if ($existingIsPdf) {
        return [pscustomobject]@{
            id = $row.id
            status = 'EXISTS'
            bytes = (Get-Item -LiteralPath $destination).Length
            file = $row.filename
            error = ''
        }
    }

    try {
        Invoke-WebRequest `
            -Uri $row.pdf_url `
            -OutFile $destination `
            -Headers @{ 'User-Agent' = 'Mozilla/5.0 CodexResearch/1.0' } `
            -MaximumRetryCount 3 `
            -RetryIntervalSec 2 `
            -ConnectionTimeoutSeconds 30 `
            -OperationTimeoutSeconds 180

        $bytes = (Get-Item -LiteralPath $destination).Length
        if ($bytes -lt 10000) {
            throw "Downloaded file too small: $bytes bytes"
        }

        $stream = [System.IO.File]::OpenRead($destination)
        try {
            $headerBytes = [byte[]]::new(5)
            [void]$stream.Read($headerBytes, 0, 5)
            $header = [System.Text.Encoding]::ASCII.GetString($headerBytes)
        }
        finally {
            $stream.Dispose()
        }
        if ($header -ne '%PDF-') {
            throw "Downloaded file is not a PDF (header: $header)."
        }

        return [pscustomobject]@{
            id = $row.id
            status = 'OK'
            bytes = $bytes
            file = $row.filename
            error = ''
        }
    }
    catch {
        return [pscustomobject]@{
            id = $row.id
            status = 'FAIL'
            bytes = 0
            file = $row.filename
            error = $_.Exception.Message
        }
    }
} -ThrottleLimit 6

$results | Sort-Object id | Format-Table -AutoSize
$failed = @($results | Where-Object status -eq 'FAIL')
if ($failed.Count -gt 0) {
    $failed | ConvertTo-Json -Depth 3
    exit 1
}
