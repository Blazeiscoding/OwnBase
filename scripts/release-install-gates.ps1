# The release gates a Windows installer passes before it is published (IMP-08):
# it installs silently for the current user and says what version it
# installed, the installed app starts and registers ownbase:// links,
# installing over the previous release keeps that release's data, and
# uninstalling removes the app but keeps the person's data.
#
#   ./scripts/release-install-gates.ps1 -Installer <new Setup.exe> -Version <x.y.z> [-Previous <old Setup.exe>]
#
# Run on a disposable Windows machine (a CI runner): it installs, launches and
# uninstalls the real app for the current user.
#
# The installed app is asked which profile it is using (F05): started with
# OWNBASE_RELEASE_GATE_REPORT, it writes its data folder, version, revision
# and what it read there. An upgrade passes only when the new process is
# using the previous release's folder and reads the marker left in it; a
# folder that merely exists, or a registry entry, proves neither.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $Version,
  [string] $Previous,
  # The commit this installer was built from, when the caller knows it.
  [string] $Revision
)
$ErrorActionPreference = "Stop"
$Marker = "release-gate-marker.txt"

function SamePath([string] $A, [string] $B) {
  return [System.IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($B).TrimEnd('\')
}

function Fail([string] $Message) {
  Write-Host "::error::$Message"
  throw $Message
}

# The uninstall entry the installer writes, which also says where it put the app.
function Installed {
  $keys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue
  foreach ($key in $keys) {
    $entry = Get-ItemProperty $key.PSPath
    if ($entry.DisplayName -like "OwnBase*") { return $entry }
  }
  return $null
}

# Where the app is installed. The per-user entry may carry no InstallLocation,
# so fall back to the folder of the uninstaller it names, then of its icon.
function InstallDirectory($Entry) {
  if ($Entry.InstallLocation) { return $Entry.InstallLocation.Trim('"') }
  foreach ($value in @($Entry.UninstallString, $Entry.DisplayIcon)) {
    if ($value -and $value -match '^"?([^",]+\.exe)') { return Split-Path -Parent $Matches[1] }
  }
  Fail "the uninstall entry names no install folder:$($Entry | Format-List | Out-String)"
}

function Install([string] $Path, [string] $Expected) {
  Write-Host "Installing $Path"
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "$Path exited with $($process.ExitCode)" }
  $entry = Installed
  if (-not $entry) { Fail "$Path left no uninstall entry" }
  if ($Expected -and $entry.DisplayVersion -ne $Expected) {
    Fail "installed version is $($entry.DisplayVersion), expected $Expected"
  }
  $folder = InstallDirectory $entry
  $exe = Join-Path $folder "OwnBase.exe"
  if (-not (Test-Path $exe)) { Fail "no OwnBase.exe in $folder" }
  Write-Host "Installed $($entry.DisplayVersion) at $folder"
  return $exe
}

# Starts the installed app, waits for it to register its links and say which
# data folder it is using, then stops it. Returns its report.
function Launch([string] $Exe) {
  Write-Host "Starting $Exe"
  $report = Join-Path ([System.IO.Path]::GetTempPath()) "ownbase-release-gate-$PID.json"
  Remove-Item $report -ErrorAction SilentlyContinue
  $env:OWNBASE_RELEASE_GATE_REPORT = $report
  try { $process = Start-Process -FilePath $Exe -PassThru } finally {
    Remove-Item Env:OWNBASE_RELEASE_GATE_REPORT
  }
  $schemes = @("ownbase")
  $said = $null
  $registered = $false
  for ($i = 0; $i -lt 60 -and -not ($said -and $registered); $i++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { Fail "the app exited on its own with $($process.ExitCode)" }
    if (Test-Path $report) {
      # Taken once Chromium has written the profile there too, which can be
      # a moment after the app says where it is.
      try { $told = Get-Content $report -Raw | ConvertFrom-Json } catch { $told = $null }
      if ($told -and $told.userData -and (Test-Path (Join-Path $told.userData "Local State"))) { $said = $told }
    }
    $registered = $true
    foreach ($scheme in $schemes) {
      $command = (Get-ItemProperty "HKCU:\Software\Classes\$scheme\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
      if (-not $command -or $command -notlike "*$Exe*") { $registered = $false }
    }
  }
  Get-Process -Name "OwnBase" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Remove-Item $report -ErrorAction SilentlyContinue
  if (-not $registered) { Fail "the app did not register $(($schemes | ForEach-Object { "$($_)://" }) -join ', ') to $Exe" }
  if (-not $said) { Fail "the app did not say which data folder it uses (OWNBASE_RELEASE_GATE_REPORT)" }
  if (-not (Test-Path (Join-Path $said.userData "Local State"))) { Fail "the app's data folder $($said.userData) holds no profile" }
  Write-Host "Links registered; data in $($said.userData)"
  return $said
}

if ($Previous) {
  # Upgrading: the new release starts in the previous release's profile and
  # reads what is there, not merely leaves it alone.
  $oldExe = Install $Previous $null
  $old = Launch $oldExe
  Set-Content -Path (Join-Path $old.userData $Marker) -Value "kept across upgrade"
  $exe = Install $Installer $Version
  if (-not (Test-Path (Join-Path $old.userData $Marker))) { Fail "installing over the previous release removed its data" }
  $now = Launch $exe
  if (-not (SamePath $now.userData $old.userData)) {
    Fail "the upgraded app uses $($now.userData), not the previous release's data in $($old.userData)"
  }
  if ($now.marker -ne "kept across upgrade") { Fail "the upgraded app did not read what the previous release left in $($old.userData)" }
  if (-not $now.settingsReadable) { Fail "the upgraded app could not read the previous release's settings" }
  Write-Host "Upgrade uses and reads the previous release's data"
} else {
  Write-Host "No previous release to upgrade from; installing fresh"
  $exe = Install $Installer $Version
  $now = Launch $exe
}
if ($now.version -ne $Version) { Fail "the running app is version $($now.version), expected $Version" }
if ($Revision -and $now.revision -ne $Revision) { Fail "the running app was built from $($now.revision), expected $Revision" }

$data = $now.userData
Set-Content -Path (Join-Path $data $Marker) -Value "kept across uninstall"

$entry = Installed
# The silent command the installer recorded, or its ordinary one made silent;
# either may carry arguments of its own (a per-user install's /currentuser).
$command = if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { "$($entry.UninstallString) /S" }
if ($command -notmatch '^"?([^"]+?\.exe)"?\s*(.*)$') { Fail "cannot read the uninstall command: $command" }
$uninstaller = $Matches[1]
$arguments = @($Matches[2] -split '\s+' | Where-Object { $_ })
if ($arguments -notcontains "/S") { $arguments += "/S" }
Write-Host "Uninstalling with $uninstaller $($arguments -join ' ')"
# The uninstaller copies itself elsewhere and returns at once, so wait for the
# app itself to go.
Start-Process -FilePath $uninstaller -ArgumentList $arguments -Wait | Out-Null
for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $exe) { Fail "uninstalling left $exe behind" }
if (Installed) { Fail "uninstalling left the uninstall entry behind" }
if (-not (Test-Path (Join-Path $data $Marker))) { Fail "uninstalling removed the person's data in $data" }
Write-Host "Uninstall removed the app and kept the data in $data"
