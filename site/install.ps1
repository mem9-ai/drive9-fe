# drive9 installer
# Usage: irm https://drive9.ai/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-Info($Message) {
    Write-Host "  $Message" -ForegroundColor DarkGray
}

function Write-Success($Message) {
    Write-Host "  $Message" -ForegroundColor Green
}

function Write-WarnMessage($Message) {
    Write-Host "  $Message" -ForegroundColor Yellow
}

function Fail($Message) {
    Write-Host "  error: $Message" -ForegroundColor Red
    exit 1
}

if ($PSVersionTable.PSVersion.Major -lt 6) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
    }
}

$BaseUrl = "https://releases.drive9.ai/latest"
$ApiUrl = "https://api.drive9.ai"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    if ($env:LOCALAPPDATA) {
        $localAppData = $env:LOCALAPPDATA
    } elseif ($env:USERPROFILE) {
        $localAppData = Join-Path $env:USERPROFILE "AppData\Local"
    } elseif ($HOME) {
        $localAppData = Join-Path $HOME "AppData\Local"
    } else {
        Fail "Could not determine the LocalApplicationData directory"
    }
}

$DefaultInstallDir = Join-Path $localAppData "drive9"
$InstallDir = $null

function Get-Architecture() {
    try {
        $archCode = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Architecture)
        switch ($archCode) {
            9 { return "amd64" }
            12 { return "arm64" }
        }
    } catch {
    }

    $archName = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }

    switch (($archName | ForEach-Object { $_.ToUpperInvariant() })) {
        "AMD64" { return "amd64" }
        "ARM64" { return "arm64" }
        default { Fail "Unsupported architecture: $archName" }
    }
}

function Invoke-Download($Url, $OutputPath) {
    try {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            Invoke-WebRequest -Uri $Url -OutFile $OutputPath -UseBasicParsing -ErrorAction Stop | Out-Null
        } else {
            Invoke-WebRequest -Uri $Url -OutFile $OutputPath -ErrorAction Stop | Out-Null
        }
    } catch {
        return $false
    }

    return (Test-Path $OutputPath)
}

function Get-LatestVersion() {
    $versionUrl = "$BaseUrl/version"

    try {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            return (Invoke-WebRequest -Uri $versionUrl -UseBasicParsing -ErrorAction Stop).Content.Trim()
        }

        return (Invoke-WebRequest -Uri $versionUrl -ErrorAction Stop).Content.Trim()
    } catch {
        return ""
    }
}

function Get-ReleaseChecksums() {
    $checksumsUrl = "$BaseUrl/checksums.txt"

    try {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            $content = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing -ErrorAction Stop).Content
        } else {
            $content = (Invoke-WebRequest -Uri $checksumsUrl -ErrorAction Stop).Content
        }
    } catch {
        Fail "Unable to download release checksums from $checksumsUrl"
    }

    $checksums = @{}
    foreach ($line in (($content | Out-String) -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Length -eq 2) {
            $checksums[$parts[1]] = $parts[0].ToLowerInvariant()
        }
    }

    return $checksums
}

function Assert-Checksum($Path, $ArtifactName, $Checksums) {
    if (-not $Checksums.ContainsKey($ArtifactName)) {
        Fail "Missing checksum for $ArtifactName in releases/checksums.txt"
    }

    try {
        $actual = (Get-FileHash -Path $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
        Fail "Unable to compute SHA256 for $ArtifactName"
    }

    if ($actual -ne $Checksums[$ArtifactName]) {
        Fail "Checksum mismatch for $ArtifactName"
    }
}

function Get-ActiveDrive9Command() {
    return Get-Command drive9 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

# The only directories drive9 may be installed into. Everything below validates
# against this list: an inherited DRIVE9_INSTALL_DIR must not be able to choose
# the directory that is written to or appended to the persistent user PATH.
function Get-AllowedInstallDirs {
    $allowed = @()
    try {
        $allowed += [System.IO.Path]::GetFullPath($DefaultInstallDir)
    } catch {
    }
    if ($HOME) {
        try {
            $allowed += [System.IO.Path]::GetFullPath((Join-Path $HOME "bin"))
        } catch {
        }
    }
    if ($localAppData) {
        try {
            $allowed += [System.IO.Path]::GetFullPath((Join-Path $localAppData "Programs\drive9"))
        } catch {
        }
    }
    return $allowed
}

function ConvertTo-NormalizedDir($Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $trimmed = $full -replace '[\\/]+$', ''
    if ([string]::IsNullOrEmpty($trimmed)) {
        return $full
    }
    return $trimmed
}

function Test-AllowedInstallDir($Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    try {
        $normalized = ConvertTo-NormalizedDir $Path
    } catch {
        return $false
    }

    foreach ($allowed in Get-AllowedInstallDirs) {
        if ($normalized -ieq (ConvertTo-NormalizedDir $allowed)) {
            return $true
        }
    }
    return $false
}

function Resolve-SafeInstallDir($Requested) {
    $value = $Requested.Trim()

    # This value is used as a filesystem target and is persisted into the user
    # PATH, so only plain absolute local paths are accepted: no quotes, no
    # wildcards, no shell metacharacters, no UNC paths.
    if ($value -match '[\x00-\x1f"''`$;&|<>^*?!%]') {
        Fail "DRIVE9_INSTALL_DIR contains unsupported characters: $value"
    }
    if ($value.StartsWith('\\')) {
        Fail "DRIVE9_INSTALL_DIR must be a local directory, not a UNC path: $value"
    }
    if ($value.IndexOf(':', 2) -ge 0) {
        Fail "DRIVE9_INSTALL_DIR must not contain ':' beyond the drive letter: $value"
    }
    if (-not [System.IO.Path]::IsPathRooted($value)) {
        Fail "DRIVE9_INSTALL_DIR must be an absolute path: $value"
    }

    if (-not (Test-AllowedInstallDir $value)) {
        Fail ("DRIVE9_INSTALL_DIR='" + $value + "' is not an allowed install directory. Allowed directories: " + ((Get-AllowedInstallDirs) -join ", "))
    }

    return (ConvertTo-NormalizedDir $value)
}

function ConvertTo-NormalizedDirOrNull($Path) {
    try {
        return ConvertTo-NormalizedDir $Path
    } catch {
        return $null
    }
}

function Resolve-InstallDir() {
    if ($env:DRIVE9_INSTALL_DIR) {
        $script:InstallDir = Resolve-SafeInstallDir $env:DRIVE9_INSTALL_DIR
        Write-Info "Install dir: $InstallDir (from DRIVE9_INSTALL_DIR)"
        return
    }

    $existing = Get-ActiveDrive9Command
    if ($existing -and $existing.Source) {
        $existingDir = Split-Path -Parent $existing.Source
        if (Test-AllowedInstallDir $existingDir) {
            $script:InstallDir = ConvertTo-NormalizedDir $existingDir
            Write-Info "Upgrading active drive9 in $InstallDir"
            return
        }

        $script:InstallDir = ConvertTo-NormalizedDir $DefaultInstallDir
        Write-WarnMessage "drive9 currently resolves to $($existing.Source), which is outside the supported install directories"
        Write-WarnMessage "Installing to $InstallDir instead; remove the other copy to avoid PATH shadowing"
        return
    }

    $script:InstallDir = ConvertTo-NormalizedDir $DefaultInstallDir
    Write-Info "Install dir: $InstallDir"
}

function Get-BinaryVersion($BinaryPath) {
    if (-not (Test-Path $BinaryPath)) {
        return ""
    }

    try {
        $output = & $BinaryPath --version 2>$null
        if ($LASTEXITCODE -ne 0) {
            return ""
        }

        return (($output | Out-String).Trim() -replace '^drive9\s*', '')
    } catch {
        return ""
    }
}

function Add-ToUserPath($PathToAdd) {
    if (-not (Test-AllowedInstallDir $PathToAdd)) {
        Write-WarnMessage "Refusing to add $PathToAdd to the persistent user PATH: it is not an allowed install directory"
        return $false
    }

    $normalized = ConvertTo-NormalizedDir $PathToAdd
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($userPath) {
        $parts = $userPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)
    }

    $alreadyPresent = $parts | Where-Object {
        $existing = ConvertTo-NormalizedDirOrNull $_.Trim()
        $existing -and $existing -ieq $normalized
    }
    if ($alreadyPresent) {
        return $false
    }

    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
        $normalized
    } else {
        "$userPath;$normalized"
    }

    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    return $true
}

function Refresh-SessionPath() {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($machinePath, $userPath) -join ';'
}

function Report-PathStatus() {
    $installed = Join-Path $InstallDir "drive9.exe"
    $active = Get-ActiveDrive9Command

    if (-not $active -or -not $active.Source) {
        Write-WarnMessage "drive9 is installed at $installed, but $InstallDir is not on your PATH"
        Write-WarnMessage "Run $installed directly or add $InstallDir to PATH"
        return
    }

    $activePath = [System.IO.Path]::GetFullPath($active.Source)
    $installedPath = [System.IO.Path]::GetFullPath($installed)

    if ($activePath -ine $installedPath) {
        Write-WarnMessage "PATH shadowing detected: drive9 resolves to $activePath"
        Write-WarnMessage "Installed binary: $installedPath"
        $activeDir = [System.IO.Path]::GetDirectoryName($activePath)
        if (Test-AllowedInstallDir $activeDir) {
            Write-WarnMessage ('Re-run with $env:DRIVE9_INSTALL_DIR = "' + $activeDir + '" to replace the active binary')
        } else {
            Write-WarnMessage "Remove the other drive9 copy ($activePath) to avoid PATH shadowing"
        }
    }
}

function Bootstrap-Config() {
    if (-not $HOME) {
        return
    }

    $configDir = Join-Path $HOME ".drive9"
    $configFile = Join-Path $configDir "config"

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    if (-not (Test-Path $configFile)) {
        $configContent = @"
{
  "server": "$ApiUrl",
  "contexts": {}
}
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($configFile, $configContent, $utf8NoBom)
    }
}

Write-Host ""
Write-Host "  drive9 installer" -ForegroundColor White
Write-Host "  ----------------------------" -ForegroundColor DarkGray
Write-Host ""

$arch = Get-Architecture
Write-Info "Platform: windows/$arch"

$latestVersion = Get-LatestVersion
if ($latestVersion) {
    Write-Info "Latest version: v$latestVersion"
}

Resolve-InstallDir

$targetExe = Join-Path $InstallDir "drive9.exe"
$oldVersion = Get-BinaryVersion $targetExe

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$artifactName = "drive9-windows-$arch.exe"
$tempDir = $env:TEMP
if ([string]::IsNullOrWhiteSpace($tempDir)) {
    $tempDir = [System.IO.Path]::GetTempPath()
}
$tempFile = Join-Path $tempDir ("drive9-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
$downloadUrl = "$BaseUrl/$artifactName"
$checksums = Get-ReleaseChecksums

if ($latestVersion) {
    Write-Info "Downloading drive9 v$latestVersion..."
} else {
    Write-Info "Downloading drive9..."
}

if (-not (Invoke-Download $downloadUrl $tempFile)) {
    Fail "No pre-built binary available for windows/$arch. Expected release: $downloadUrl"
}

Assert-Checksum $tempFile $artifactName $checksums

try {
    try {
        Move-Item -Force -LiteralPath $tempFile -Destination $targetExe
    } catch {
        Fail "Could not install drive9.exe to $targetExe. Close any running drive9 processes and try again. If the target directory needs elevation, re-run in an elevated PowerShell session."
    }
} finally {
    if (Test-Path $tempFile) {
        Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
    }
}

$pathUpdated = Add-ToUserPath $InstallDir
if ($pathUpdated) {
    Write-Info "Added $InstallDir to user PATH"
}

Refresh-SessionPath

Write-Host ""
$newVersion = Get-BinaryVersion $targetExe
if ($oldVersion -and $newVersion -and $oldVersion -ne $newVersion) {
    Write-Success "drive9 upgraded successfully! (v$oldVersion -> v$newVersion)"
} elseif ($newVersion) {
    Write-Success "drive9 installed successfully! (v$newVersion)"
} else {
    Write-Success "drive9 installed successfully!"
}

Bootstrap-Config
Report-PathStatus

Write-Host ""
Write-Host "  Get started:"
Write-Host ""
Write-Host "    1. Create an owner context"
Write-Host "       drive9 create" -ForegroundColor DarkGray
Write-Host "       drive9 ctx show" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    2. Try filesystem commands"
Write-Host "       drive9 fs ls :/" -ForegroundColor DarkGray
Write-Host "       drive9 fs cp .\file.txt :/data/file.txt" -ForegroundColor DarkGray
Write-Host '       drive9 fs grep "search term" /' -ForegroundColor DarkGray
Write-Host "       drive9 fs find /data -name `"*.txt`"" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    3. Mount locally"
Write-Host '       mkdir "$HOME\drive9"' -ForegroundColor DarkGray
Write-Host '       drive9 mount :/data "$HOME\drive9"' -ForegroundColor DarkGray
Write-Host '       drive9 umount "$HOME\drive9"' -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Help: drive9 --help  drive9 fs --help" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Docs: https://drive9.ai/skill.md" -ForegroundColor DarkGray
Write-Host ""
