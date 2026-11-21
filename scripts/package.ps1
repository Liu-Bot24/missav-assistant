#Requires -Version 7
<#
.SYNOPSIS
  Builds the extension from the last commit. Uncommitted changes are never included.

.DESCRIPTION
  pwsh scripts/package.ps1 zip <output-folder>
      Writes missav-assistant-v<version>.zip and its .sha256 file, then checks both.

  pwsh scripts/package.ps1 sync <extension-folder>
      Makes an installed extension folder match the package. The folder stays where
      it is, so the browser keeps treating it as the same extension and keeps its
      settings. Its previous contents are saved as a zip in a "backups" folder next
      to it; files the package no longer has go to the Recycle Bin.
#>
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('zip', 'sync')][string]$Command,
  [Parameter(Mandatory, Position = 1)][string]$Target
)

$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageName = 'missav-assistant'

function Invoke-Git {
  $output = & git -c core.quotepath=off -C $project @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" }
  $output
}

# Everything the browser loads, plus the notices and the source and script
# that rebuild the performer data.
function Get-PackageFiles {
  @(Invoke-Git ls-tree -r --name-only HEAD | Where-Object {
      ($_ -notmatch '/' -and $_ -match '\.(js|css|html)$') -or
      $_ -in @('manifest.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'scripts/build-actress-data.ps1') -or
      $_ -like 'icons/*' -or $_ -like 'third-party/*'
    } | Sort-Object)
}

function Get-FileHashes([string]$Root) {
  $hashes = @{}
  Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
    $hashes[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
  $hashes
}

function Assert-SameFiles([hashtable]$Expected, [hashtable]$Actual, [string]$Where) {
  $missing = @($Expected.Keys | Where-Object { -not $Actual.ContainsKey($_) })
  $extra = @($Actual.Keys | Where-Object { -not $Expected.ContainsKey($_) })
  $changed = @($Expected.Keys | Where-Object { $Actual.ContainsKey($_) -and $Actual[$_] -ne $Expected[$_] })
  if ($missing.Count + $extra.Count + $changed.Count -gt 0) {
    throw "$Where does not match the package. Missing: $($missing -join ', '); extra: $($extra -join ', '); different: $($changed -join ', ')"
  }
}

# Every file the manifest, the background worker and the popup refer to must be packaged.
function Assert-References([string]$Root, [string[]]$Files) {
  $manifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
  $referenced = [Collections.Generic.List[string]]::new()
  $referenced.Add($manifest.background.service_worker)
  $referenced.Add($manifest.action.default_popup)
  foreach ($script in $manifest.content_scripts) { $script.js + $script.css | Where-Object { $_ } | ForEach-Object { $referenced.Add($_) } }
  foreach ($icons in @($manifest.icons, $manifest.action.default_icon)) {
    if ($icons) { $icons.PSObject.Properties.Value | ForEach-Object { $referenced.Add($_) } }
  }
  $worker = Get-Content -LiteralPath (Join-Path $Root $manifest.background.service_worker) -Raw
  foreach ($call in [regex]::Matches($worker, 'importScripts\(([^)]*)\)')) {
    [regex]::Matches($call.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $referenced.Add($_.Groups[1].Value) }
  }
  $popup = Get-Content -LiteralPath (Join-Path $Root $manifest.action.default_popup) -Raw
  [regex]::Matches($popup, '(?:src|href)="([^":]+)"') | ForEach-Object { $referenced.Add($_.Groups[1].Value) }
  $absent = @($referenced | Sort-Object -Unique | Where-Object { $_ -notin $Files })
  if ($absent.Count -gt 0) { throw "Referenced but not packaged: $($absent -join ', ')" }
  $manifest
}

$files = Get-PackageFiles
$commit = (Invoke-Git rev-parse --short HEAD) | Select-Object -First 1
$uncommitted = @(Invoke-Git status --porcelain -- @files)
if ($uncommitted.Count -gt 0) {
  Write-Warning "These uncommitted changes are not included:`n$($uncommitted -join "`n")"
}

$work = Join-Path ([IO.Path]::GetTempPath()) "$packageName-package-$([guid]::NewGuid().ToString('N'))"
$staging = Join-Path $work $packageName
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $archive = Join-Path $work 'package.zip'
  Invoke-Git archive --format=zip "--prefix=$packageName/" -o $archive HEAD -- @files | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $work
  $manifest = Assert-References $staging $files
  $packageVersion = ((Invoke-Git show HEAD:package.json) -join "`n" | ConvertFrom-Json).version
  if ($manifest.version -ne $packageVersion) {
    throw "manifest.json version $($manifest.version) differs from package.json version $packageVersion"
  }
  $expected = Get-FileHashes $staging

  if ($Command -eq 'zip') {
    $outDir = [IO.Path]::GetFullPath($Target)
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $zipName = "$packageName-v$($manifest.version).zip"
    $zipPath = Join-Path $outDir $zipName
    $hashPath = Join-Path $outDir "$packageName-v$($manifest.version).sha256"
    foreach ($path in @($zipPath, $hashPath)) {
      if (Test-Path -LiteralPath $path) { throw "$path already exists; move it away first" }
    }
    Copy-Item -LiteralPath $archive -Destination $zipPath
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($hashPath, "$hash  $zipName`n")

    # Check the written files as a reader would receive them.
    $recorded = ((Get-Content -LiteralPath $hashPath -Raw).Trim() -split '\s+')[0]
    if ($recorded -ne (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
      throw "The checksum file does not match $zipName"
    }
    $check = Join-Path $work 'check'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $check
    Assert-SameFiles $expected (Get-FileHashes (Join-Path $check $packageName)) $zipName
    Write-Output "Packaged $($files.Count) files from $commit as $zipPath"
    Write-Output "SHA256 $hash"
    return
  }

  $destination = [IO.Path]::GetFullPath($Target).TrimEnd('\')
  $projectRoot = $project.TrimEnd('\')
  if ($destination -eq $projectRoot -or $destination.StartsWith("$projectRoot\", [StringComparison]::OrdinalIgnoreCase) -or
      $projectRoot.StartsWith("$destination\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The extension folder must be outside the project.'
  }
  $existing = @(if (Test-Path -LiteralPath $destination) { Get-ChildItem -LiteralPath $destination -Force })
  if ($existing.Count -gt 0) {
    $installedManifest = Join-Path $destination 'manifest.json'
    $installedName = if (Test-Path -LiteralPath $installedManifest) {
      (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).name
    }
    if ($installedName -ne $manifest.name) {
      throw "$destination is not empty and does not hold this extension; nothing was changed."
    }
    $backupDir = Join-Path (Split-Path -Parent $destination) 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $installedVersion = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
    $backup = Join-Path $backupDir "$(Split-Path -Leaf $destination)-v$installedVersion-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"
    Compress-Archive -Path (Join-Path $destination '*') -DestinationPath $backup
    Write-Output "Saved the previous contents to $backup"
  } else {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
  }

  Add-Type -AssemblyName Microsoft.VisualBasic
  $recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  $dialogs = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
  $installed = Get-FileHashes $destination
  foreach ($relative in @($installed.Keys | Where-Object { -not $expected.ContainsKey($_) } | Sort-Object)) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile((Join-Path $destination $relative), $dialogs, $recycle)
    Write-Output "Moved to the Recycle Bin: $relative"
  }
  Get-ChildItem -LiteralPath $destination -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
    ForEach-Object { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($_.FullName, $dialogs, $recycle) }
  foreach ($relative in $expected.Keys) {
    $to = Join-Path $destination $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath (Join-Path $staging $relative) -Destination $to -Force
  }
  Assert-SameFiles $expected (Get-FileHashes $destination) $destination
  Write-Output "Updated $destination to version $($manifest.version) ($commit, $($files.Count) files). Reload the extension in the browser."
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
