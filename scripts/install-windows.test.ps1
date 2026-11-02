# Run the installer's real download/checksum functions without installing a
# program, editing PATH, or touching user configuration.
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot "../site/install.ps1"), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "Installer parse failed: $parseErrors" }

foreach ($name in @("BaseUrl", "downloadUrl")) {
    $assignment = $ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]
    }, $true) | Where-Object { $_.Left.VariablePath.UserPath -eq $name }
    if (@($assignment).Count -ne 1) { throw "Missing or ambiguous $name assignment" }
    if ($name -eq "BaseUrl") { . ([scriptblock]::Create($assignment.Extent.Text)) }
    else { $downloadAssignment = $assignment.Extent.Text }
}
foreach ($name in @("Get-LatestVersion", "Get-ReleaseChecksums", "Invoke-Download", "Assert-Checksum")) {
    $function = $ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $true) | Where-Object { $_.Name -eq $name }
    if (@($function).Count -ne 1) { throw "Missing or ambiguous $name function" }
    . ([scriptblock]::Create($function.Extent.Text))
}
function Fail($Message) { throw $Message }

$root = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $root | Out-Null
try {
    $payload = [Text.Encoding]::UTF8.GetBytes("fixture binary")
    $fixture = Join-Path $root "fixture"
    [IO.File]::WriteAllBytes($fixture, $payload)
    $hash = (Get-FileHash -Algorithm SHA256 $fixture).Hash.ToLowerInvariant()
    $script:failure = ""
    function Invoke-WebRequest($Uri, $OutFile, $ErrorAction, [switch]$UseBasicParsing) {
        if ($Uri -notlike "https://releases.drive9.ai/latest/*") { throw "Unexpected origin: $Uri" }
        if ($Uri.EndsWith("/version")) { return @{ Content = "v0.2.0`n" } }
        if ($Uri.EndsWith("/checksums.txt")) {
            if ($script:failure -eq "manifest") { throw "HTTP 403" }
            return @{ Content = "$hash  drive9-windows-amd64.exe`n$hash  drive9-windows-arm64.exe`n" }
        }
        if ($Uri -notmatch '/drive9-windows-(amd64|arm64)\.exe$') { throw "Unexpected artifact: $Uri" }
        if ($script:failure -eq "binary") { throw "HTTP 404" }
        [IO.File]::WriteAllBytes($OutFile, $payload)
    }
    if ((Get-LatestVersion) -ne "v0.2.0") { throw "Version fetch failed" }
    $checksums = Get-ReleaseChecksums
    foreach ($arch in @("amd64", "arm64")) {
        $artifactName = "drive9-windows-$arch.exe"
        . ([scriptblock]::Create($downloadAssignment))
        $download = Join-Path $root $artifactName
        if (-not (Invoke-Download $downloadUrl $download)) { throw "Download failed" }
        Assert-Checksum $download $artifactName $checksums
        [IO.File]::WriteAllText($download, "corrupted")
        $rejected = $false
        try { Assert-Checksum $download $artifactName $checksums } catch {
            if ($_.Exception.Message -notlike "Checksum mismatch*") { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw "Corrupt download accepted" }
    }
    $script:failure = "binary"
    if (Invoke-Download $downloadUrl (Join-Path $root "missing")) { throw "Missing binary accepted" }
    $script:failure = "manifest"
    $rejected = $false
    try { Get-ReleaseChecksums | Out-Null } catch {
        if ($_.Exception.Message -notlike "Unable to download release checksums*") { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Missing manifest accepted" }
    Write-Output "Windows installer download and checksum cases passed (amd64, arm64, corruption, missing files)."
} finally {
    Remove-Item -Recurse -Force $root
}
