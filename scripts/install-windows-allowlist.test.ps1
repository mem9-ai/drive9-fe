# Exercises the install-directory allowlist and PATH guard of site/install.ps1
# without downloading anything, installing a program, or touching user config.
$ErrorActionPreference = "Stop"

$installer = Join-Path $PSScriptRoot "../site/install.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "Installer parse failed: $parseErrors" }

$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$DefaultInstallDir = Join-Path $localAppData "drive9"

foreach ($name in @(
        "Get-AllowedInstallDirs", "Get-TrustedInstallRoots", "Resolve-PhysicalDir",
        "Resolve-PhysicalDirOnce", "ConvertTo-NormalizedDir", "ConvertTo-NormalizedDirOrNull",
        "Test-AllowedInstallDir", "Resolve-SafeInstallDir", "Resolve-InstallDir", "Add-ToUserPath")) {
    $function = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -eq $name }
    if (@($function).Count -ne 1) { throw "Missing or ambiguous $name function" }
    . ([scriptblock]::Create($function.Extent.Text))
}

$script:warnings = @()
$script:info = @()
function Fail($Message) { throw "installer rejected: $Message" }
function Write-WarnMessage($Message) { $script:warnings += $Message }
function Write-Info($Message) { $script:info += $Message }
# Deterministic default-branch selection regardless of what is on PATH.
function Get-ActiveDrive9Command { return $null }

$sep = [System.IO.Path]::DirectorySeparatorChar
$failures = @()
function Check($Name, [scriptblock]$Body) {
    try { & $Body }
    catch { $script:failures += "$Name`: $($_.Exception.Message)" }
}

function Assert-True($Name, $Value) {
    if (-not $Value) { throw "$Name should be true" }
}

function Assert-False($Name, $Value) {
    if ($Value) { throw "$Name should be false" }
}

function Assert-Rejects($Name, [scriptblock]$Body, $ExpectedPattern) {
    try {
        & $Body
    } catch {
        if ($_.Exception.Message -notmatch $ExpectedPattern) {
            throw "$Name rejected with unexpected message: $($_.Exception.Message)"
        }
        return
    }
    throw "$Name should have been rejected"
}

Check "allowed default directory" { Assert-True "default dir" (Test-AllowedInstallDir $DefaultInstallDir) }
Check "allowed HOME\bin" { Assert-True "HOME\bin" (Test-AllowedInstallDir (Join-Path $HOME "bin")) }
Check "allowed HOME\bin with trailing separator" {
    Assert-True "HOME\bin trailing separator" (Test-AllowedInstallDir ((Join-Path $HOME "bin") + $sep))
}
Check "allowed programs directory" {
    Assert-True "programs dir" (Test-AllowedInstallDir (Join-Path $localAppData "Programs\drive9"))
}
Check "empty path" { Assert-False "empty" (Test-AllowedInstallDir "") }
Check "non-allowlisted temp directory" {
    Assert-False "temp dir" (Test-AllowedInstallDir ([System.IO.Path]::GetTempPath()))
}

Check "resolve allowlisted directory" {
    $resolved = Resolve-SafeInstallDir (Join-Path $HOME "bin")
    if ($resolved -ine (ConvertTo-NormalizedDir (Join-Path $HOME "bin"))) {
        throw "resolved to $resolved"
    }
}
Check "reject relative path" { Assert-Rejects "relative" { Resolve-SafeInstallDir "bin" } "absolute path" }
Check "reject UNC path" { Assert-Rejects "unc" { Resolve-SafeInstallDir '\\server\share' } "UNC path" }
Check "reject PATH separator injection" { Assert-Rejects "semicolon" { Resolve-SafeInstallDir ((Join-Path $HOME "bin") + ';C:\Windows\System32') } "unsupported characters" }
Check "reject quote injection" { Assert-Rejects "quote" { Resolve-SafeInstallDir ((Join-Path $HOME "bin") + '"') } "unsupported characters" }
Check "reject environment expansion" { Assert-Rejects "percent" { Resolve-SafeInstallDir ((Join-Path $HOME "bin") + '%PATH%') } "unsupported characters" }
Check "reject alternate data stream" { Assert-Rejects "ads" { Resolve-SafeInstallDir ((Join-Path $HOME "bin") + ':evil') } "':' beyond the drive letter" }
Check "reject non-allowlisted absolute directory" {
    Assert-Rejects "non-allowlisted" { Resolve-SafeInstallDir ([System.IO.Path]::GetTempPath()) } "not an allowed install directory"
}
Check "reject traversal into non-allowlisted directory" {
    Assert-Rejects "traversal" { Resolve-SafeInstallDir ((Join-Path $HOME "bin") + "$sep..$sep..$sep") } "not an allowed install directory|unsupported characters"
}

Check "accepts a home path with spaces and shell characters" {
    $originalHome = $HOME
    try {
        # $HOME is read-only; -Force is required to point the allowlist at a
        # profile directory whose name contains spaces, an ampersand and a quote.
        Set-Variable -Name HOME -Value (Join-Path ([System.IO.Path]::GetTempPath()) "drive9 home & it's mine") -Force
        $resolved = Resolve-SafeInstallDir (Join-Path $HOME "bin")
        Assert-True "HOME with spaces" ((Join-Path $HOME "bin") -ieq $resolved)
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
    }
}

function New-ReparseLink($LinkPath, $TargetPath) {
    try {
        New-Item -ItemType SymbolicLink -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function New-ProfileSandbox {
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("drive9-link-" + [guid]::NewGuid().ToString("N"))
    $inside = Join-Path $sandbox "home"
    $outside = Join-Path $sandbox "outside"
    New-Item -ItemType Directory -Path $inside -Force | Out-Null
    New-Item -ItemType Directory -Path $outside -Force | Out-Null
    return @{ Sandbox = $sandbox; Inside = $inside; Outside = $outside }
}

function Remove-ProfileSandbox($sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Check "rejects an allowlisted directory that links outside the profile" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    try {
        Set-Variable -Name HOME -Value $box.Inside -Force
        $bin = Join-Path $HOME "bin"
        if (-not (New-ReparseLink $bin $box.Outside)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        Assert-False "escaping link" (Test-AllowedInstallDir $bin)
        Assert-Rejects "escaping link" { Resolve-SafeInstallDir $bin } "not an allowed install directory"
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "accepts an allowlisted directory that links inside the profile" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    try {
        Set-Variable -Name HOME -Value $box.Inside -Force
        $bin = Join-Path $HOME "bin"
        $dotfiles = Join-Path $HOME "dotfiles"
        New-Item -ItemType Directory -Path $dotfiles -Force | Out-Null
        if (-not (New-ReparseLink $bin $dotfiles)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        Assert-True "in-profile link" (Test-AllowedInstallDir $bin)
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "accepts an allowlisted directory under a redirected profile" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    try {
        $link = Join-Path $box.Sandbox "home-link"
        if (-not (New-ReparseLink $link $box.Inside)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        Set-Variable -Name HOME -Value $link -Force
        $bin = Join-Path $HOME "bin"
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        Assert-True "redirected profile" (Test-AllowedInstallDir $bin)
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "validates the default destination before probing or installing" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    $originalLocalAppData = $localAppData
    $originalDefault = $DefaultInstallDir
    $originalEnv = $env:DRIVE9_INSTALL_DIR
    try {
        $localAppData = Join-Path $box.Sandbox "localappdata"
        New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
        $DefaultInstallDir = Join-Path $localAppData "drive9"
        Set-Variable -Name HOME -Value $box.Inside -Force
        Remove-Item Env:DRIVE9_INSTALL_DIR -ErrorAction SilentlyContinue

        Resolve-InstallDir
        if ($script:InstallDir -ine (ConvertTo-NormalizedDir $DefaultInstallDir)) {
            throw "default branch selected $($script:InstallDir)"
        }
        Assert-True "default destination" (Test-AllowedInstallDir $script:InstallDir)
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        $localAppData = $originalLocalAppData
        $DefaultInstallDir = $originalDefault
        if ($null -ne $originalEnv) { $env:DRIVE9_INSTALL_DIR = $originalEnv }
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "rejects a default destination that links outside the profile" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    $originalLocalAppData = $localAppData
    $originalDefault = $DefaultInstallDir
    $originalEnv = $env:DRIVE9_INSTALL_DIR
    try {
        $localAppData = Join-Path $box.Sandbox "localappdata"
        New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
        $DefaultInstallDir = Join-Path $localAppData "drive9"
        Set-Variable -Name HOME -Value $box.Inside -Force
        Remove-Item Env:DRIVE9_INSTALL_DIR -ErrorAction SilentlyContinue
        if (-not (New-ReparseLink $DefaultInstallDir $box.Outside)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        Assert-Rejects "escaping default" { Resolve-InstallDir } "default install directory"
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        $localAppData = $originalLocalAppData
        $DefaultInstallDir = $originalDefault
        if ($null -ne $originalEnv) { $env:DRIVE9_INSTALL_DIR = $originalEnv }
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "rejects a link chain that ends outside the profile" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    $links = @()
    try {
        Set-Variable -Name HOME -Value $box.Inside -Force
        $previous = $box.Outside
        for ($i = 1; $i -le 8; $i++) {
            $link = Join-Path $HOME ("l" + $i)
            if (-not (New-ReparseLink $link $previous)) {
                Write-Host "skip: directory symlinks are not permitted here"
                return
            }
            $links += $link
            $previous = $link
        }
        $bin = Join-Path $HOME "bin"
        if (-not (New-ReparseLink $bin $previous)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        $links += $bin
        # $HOME/bin -> l8 -> ... -> l1 -> outside
        Assert-False "chain" (Test-AllowedInstallDir $bin)
        Assert-Rejects "chain" { Resolve-SafeInstallDir $bin } "not an allowed install directory"
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        foreach ($link in $links) { Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue }
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "fails closed when a link chain exceeds the traversal bound" {
    $box = New-ProfileSandbox
    $originalHome = $HOME
    $links = @()
    try {
        Set-Variable -Name HOME -Value $box.Inside -Force
        $previous = $box.Inside
        for ($i = 1; $i -le 40; $i++) {
            $link = Join-Path $box.Inside ("deep" + $i)
            if (-not (New-ReparseLink $link $previous)) {
                Write-Host "skip: directory symlinks are not permitted here"
                return
            }
            $links += $link
            $previous = $link
        }
        $bin = Join-Path $HOME "bin"
        if (-not (New-ReparseLink $bin $previous)) {
            Write-Host "skip: directory symlinks are not permitted here"
            return
        }
        $links += $bin
        Assert-False "over-long chain" (Test-AllowedInstallDir $bin)
        Assert-Rejects "over-long chain" { Resolve-SafeInstallDir $bin } "not an allowed install directory"
        # The bound itself must fail closed rather than return the last hop.
        $resolverThrew = $false
        try {
            Resolve-PhysicalDir $bin | Out-Null
        } catch {
            if ($_.Exception.Message -notmatch "did not resolve after 32 passes") { throw }
            $resolverThrew = $true
        }
        if (-not $resolverThrew) { throw "resolver returned an intermediate hop instead of failing" }
    } finally {
        Set-Variable -Name HOME -Value $originalHome -Force
        foreach ($link in $links) { Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue }
        Remove-ProfileSandbox $box.Sandbox
    }
}

Check "PATH guard rejects non-allowlisted directory" {
    $added = Add-ToUserPath ([System.IO.Path]::GetTempPath())
    Assert-False "Add-ToUserPath" $added
    if ($script:warnings.Count -eq 0) { throw "expected a warning for the refused PATH entry" }
}

if ($script:failures.Count -ne 0) {
    $script:failures | ForEach-Object { Write-Host "FAILED: $_" }
    throw "$($script:failures.Count) install-directory case(s) failed"
}

Write-Output "Windows installer install-directory cases passed (allowlist, traversal, metacharacters, UNC, PATH guard)."
