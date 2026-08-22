[CmdletBinding()]
param(
    [ValidateRange(1, 72)]
    [int]$Hours = 6,

    [ValidateRange(1, 3072)]
    [int]$MaxArchiveMiB = 50,

    [ValidatePattern('^https://')]
    [string]$Origin = 'https://macro.expeditions.gg',

    [string]$OutputDirectory = '',

    [ValidateRange(1, 60)]
    [int]$PollSeconds = 5,

    [ValidateRange(1, 60)]
    [int]$VerificationTimeoutMinutes = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($env:MACROADMIN_API_KEY)) {
    throw 'MACROADMIN_API_KEY must be supplied through the environment or Doppler.'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path (Get-Location) ".local\admin-diagnostics\$stamp"
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$archiveRoot = Join-Path $outputRoot 'archives'
$evidenceRoot = Join-Path $outputRoot 'text-evidence'
New-Item -ItemType Directory -Path $archiveRoot, $evidenceRoot -Force | Out-Null

$originRoot = $Origin.TrimEnd('/')
$headers = @{
    Authorization = "Bearer $($env:MACROADMIN_API_KEY)"
    Accept = 'application/json'
}

function Invoke-AdminApi {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('GET', 'POST')]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Path
    )

    if ($Method -eq 'POST') {
        Invoke-RestMethod -Method $Method -Uri "$originRoot$Path" -Headers $headers -ContentType 'application/json' -Body '{}'
    }
    else {
        Invoke-RestMethod -Method $Method -Uri "$originRoot$Path" -Headers $headers
    }
}

function Get-SafeArchiveName {
    param([Parameter(Mandatory)]$Record)

    $leaf = [IO.Path]::GetFileName([string]$Record.fileName)
    if ([string]::IsNullOrWhiteSpace($leaf) -or -not $leaf.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
        $leaf = 'diagnostic.zip'
    }
    return "$($Record.id)-$leaf"
}

$script:lastDownloadRequestAt = [DateTimeOffset]::MinValue

function Request-DiagnosticDownload {
    param([Parameter(Mandatory)]$Record)

    $path = "/v1/admin-data/diagnostics/$($Record.id)/download"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $elapsed = [DateTimeOffset]::UtcNow - $script:lastDownloadRequestAt
        if ($elapsed.TotalMilliseconds -lt 2100) {
            Start-Sleep -Milliseconds ([int](2100 - $elapsed.TotalMilliseconds))
        }
        try {
            $result = Invoke-AdminApi -Method POST -Path $path
            $script:lastDownloadRequestAt = [DateTimeOffset]::UtcNow
            if ($result.status -eq 'Accepted' -and -not [string]::IsNullOrWhiteSpace([string]$result.url)) {
                return $result
            }
            if ($result.status -ne 'Verifying') {
                throw "Diagnostic $($Record.id) returned unexpected download status '$($result.status)'."
            }
            return $result
        }
        catch {
            $script:lastDownloadRequestAt = [DateTimeOffset]::UtcNow
            $statusCode = if ($null -ne $_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            if ($statusCode -ne 429 -or $attempt -eq 3) {
                throw
            }
            Start-Sleep -Seconds 60
        }
    }
}

function Save-DiagnosticDownload {
    param(
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$SignedUrl
    )

    $archivePath = Join-Path $archiveRoot (Get-SafeArchiveName -Record $Record)
    Invoke-WebRequest -Uri $SignedUrl -OutFile $archivePath | Out-Null
    $actualBytes = (Get-Item -LiteralPath $archivePath).Length
    if ($actualBytes -ne [int64]$Record.sizeBytes) {
        Remove-Item -LiteralPath $archivePath -Force
        throw "Downloaded byte count $actualBytes did not match metadata $($Record.sizeBytes)."
    }
    Expand-TextEvidence -ArchivePath $archivePath -DiagnosticId $Record.id
    return [pscustomobject]@{
        Id = $Record.id
        FileName = $Record.fileName
        CreatedAt = $Record.createdAt
        SizeBytes = [int64]$Record.sizeBytes
        ArchivePath = $archivePath
        Error = $null
    }
}

function Expand-TextEvidence {
    param(
        [Parameter(Mandatory)]
        [string]$ArchivePath,

        [Parameter(Mandatory)]
        [string]$DiagnosticId
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in '.json', '.jsonl', '.log', '.md', '.txt', '.csv') {
        [void]$allowed.Add($extension)
    }

    $destination = Join-Path $evidenceRoot $DiagnosticId
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $destinationPrefix = [IO.Path]::GetFullPath($destination) + [IO.Path]::DirectorySeparatorChar
    $expandedBytes = 0L
    $maxEntryBytes = 64MB
    $maxTotalBytes = 256MB
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $extension = [IO.Path]::GetExtension($entry.Name)
            if (-not $allowed.Contains($extension) -or $entry.Length -gt $maxEntryBytes) {
                continue
            }
            $relative = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
            if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            if ($expandedBytes + $entry.Length -gt $maxTotalBytes) {
                break
            }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Create($target)
            try {
                $inputStream.CopyTo($outputStream)
            }
            finally {
                $outputStream.Dispose()
                $inputStream.Dispose()
            }
            $expandedBytes += $entry.Length
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Get-FailureFindings {
    $patterns = @(
        '(?i)\b(error|exception|failed|failure|fatal|crash(?:ed)?)\b',
        '(?i)recoverable anomaly',
        '(?i)access (?:to the path )?is denied',
        '(?i)no capturable area',
        '(?i)not responding',
        '(?i)timed? out|timeout',
        '(?i)(?:placement setup|selection ui|roblox lobby) (?:was )?not found'
    )
    $findings = [Collections.Generic.List[object]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $evidenceRoot -Recurse -File) {
        $reader = [IO.File]::OpenText($file.FullName)
        try {
            $lineNumber = 0
            while (($line = $reader.ReadLine()) -ne $null) {
                $lineNumber++
                if (-not ($patterns | Where-Object { $line -match $_ } | Select-Object -First 1)) {
                    continue
                }
                $sample = if ($line.Length -le 600) { $line } else { $line.Substring(0, 600) }
                $signature = $sample.ToUpperInvariant()
                $signature = $signature -replace '\b[0-9A-F]{8}-[0-9A-F-]{27,}\b', '<GUID>'
                $signature = $signature -replace '\b\d+(?:\.\d+)?\b', '<N>'
                $findings.Add([pscustomobject]@{
                    DiagnosticId = $file.Directory.Name
                    Member = [IO.Path]::GetRelativePath((Join-Path $evidenceRoot $file.Directory.Name), $file.FullName)
                    Line = $lineNumber
                    Signature = $signature
                    Sample = $sample
                })
            }
        }
        finally {
            $reader.Dispose()
        }
    }
    return $findings
}

$cutoff = [DateTimeOffset]::UtcNow.AddHours(-$Hours)
$maxBytes = [int64]$MaxArchiveMiB * 1MB
$rawRecords = Invoke-AdminApi -Method GET -Path '/v1/admin-data/diagnostics?limit=250'
# Invoke-RestMethod intentionally writes a top-level JSON array as one pipeline object.
# Cast it explicitly so filtering operates on individual diagnostic records.
$records = [object[]]$rawRecords
$selected = @(
    $records |
        Where-Object {
            [DateTimeOffset]::Parse([string]$_.createdAt) -ge $cutoff -and
            [int64]$_.sizeBytes -le $maxBytes -and
            $_.status -in @('Stored', 'Verifying', 'Accepted')
        } |
        Sort-Object { [DateTimeOffset]::Parse([string]$_.createdAt) }
)

$downloads = [Collections.Generic.List[object]]::new()
$pending = [Collections.Generic.List[object]]::new()
foreach ($record in $selected) {
    Write-Host "Queueing $($record.id) ($([math]::Round([int64]$record.sizeBytes / 1MB, 2)) MiB)..."
    try {
        $result = Request-DiagnosticDownload -Record $record
        if ($result.status -eq 'Accepted') {
            $downloads.Add((Save-DiagnosticDownload -Record $record -SignedUrl ([string]$result.url)))
        }
        else {
            $pending.Add($record)
        }
    }
    catch {
        $downloads.Add([pscustomobject]@{
            Id = $record.id
            FileName = $record.fileName
            CreatedAt = $record.createdAt
            SizeBytes = [int64]$record.sizeBytes
            ArchivePath = $null
            Error = $_.Exception.Message
        })
    }
}

$verificationDeadline = [DateTimeOffset]::UtcNow.AddMinutes($VerificationTimeoutMinutes)
while ($pending.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $verificationDeadline) {
    $nextPending = [Collections.Generic.List[object]]::new()
    foreach ($record in $pending) {
        try {
            $result = Request-DiagnosticDownload -Record $record
            if ($result.status -eq 'Accepted') {
                Write-Host "Downloading $($record.id)..."
                $downloads.Add((Save-DiagnosticDownload -Record $record -SignedUrl ([string]$result.url)))
            }
            else {
                $nextPending.Add($record)
            }
        }
        catch {
            $downloads.Add([pscustomobject]@{
                Id = $record.id
                FileName = $record.fileName
                CreatedAt = $record.createdAt
                SizeBytes = [int64]$record.sizeBytes
                ArchivePath = $null
                Error = $_.Exception.Message
            })
        }
    }
    $pending = $nextPending
    if ($pending.Count -gt 0) {
        Start-Sleep -Seconds $PollSeconds
    }
}
foreach ($record in $pending) {
    $downloads.Add([pscustomobject]@{
        Id = $record.id
        FileName = $record.fileName
        CreatedAt = $record.createdAt
        SizeBytes = [int64]$record.sizeBytes
        ArchivePath = $null
        Error = "Verification did not finish within $VerificationTimeoutMinutes minutes."
    })
}

$findings = @(Get-FailureFindings)
$groups = @(
    $findings |
        Group-Object Signature |
        Sort-Object Count -Descending |
        ForEach-Object {
            [pscustomobject]@{
                Count = $_.Count
                Signature = $_.Name
                Samples = @($_.Group | Select-Object -First 3 DiagnosticId, Member, Line, Sample)
            }
        }
)
$report = [ordered]@{
    GeneratedAt = [DateTimeOffset]::UtcNow.ToString('O')
    Filter = [ordered]@{
        Hours = $Hours
        MaxArchiveMiB = $MaxArchiveMiB
        Cutoff = $cutoff.ToString('O')
    }
    Listed = $records.Count
    Selected = $selected.Count
    Downloaded = @($downloads | Where-Object { $null -eq $_.Error }).Count
    Failed = @($downloads | Where-Object { $null -ne $_.Error }).Count
    Downloads = @($downloads)
    FindingCount = $findings.Count
    FindingGroups = $groups
}
$reportPath = Join-Path $outputRoot 'report.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
Write-Host "Completed: $($report.Downloaded) downloaded, $($report.Failed) failed, $($report.FindingCount) findings."
Write-Host "Report: $reportPath"
if ($report.Failed -gt 0) {
    exit 1
}
