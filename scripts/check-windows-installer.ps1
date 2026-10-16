$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json | ConvertFrom-Json).version
$installer = Join-Path $PWD "release/Scene-Finder-$version-windows-x64-setup.exe"
$destination = Join-Path $env:RUNNER_TEMP 'scene-finder-install-check'
$process = Start-Process $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$destination`"" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
foreach ($file in @('Scene Finder.exe', 'resources/app.asar', 'resources/media/ffmpeg.exe', 'resources/media/ffprobe.exe', 'unins000.exe')) {
  if (!(Test-Path (Join-Path $destination $file))) { throw "Installer is missing $file" }
}
$shortcut = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/Scene Finder.lnk'
if (!(Test-Path $shortcut)) { throw 'The Start menu shortcut is missing.' }
# Exercise the installed runtime and its actual rendered page without a Jev key.
$app = Start-Process (Join-Path $destination 'Scene Finder.exe') -ArgumentList '--remote-debugging-port=9227' -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    if ($app.HasExited) { throw "Installed app exited $($app.ExitCode)" }
    try {
      $pages = Invoke-RestMethod 'http://127.0.0.1:9227/json/list'
      $page = $pages | Where-Object { $_.type -eq 'page' -and $_.title -eq 'Scene Finder' -and $_.url -match '^http://127\.0\.0\.1:' }
      if ($page) { $ready = $true; break }
    } catch { }
  }
  if (!$ready) { throw 'The installed app did not open its local UI.' }
} finally {
  if (!$app.HasExited) {
    $null = $app.CloseMainWindow()
    if (!$app.WaitForExit(15000)) { & taskkill /PID $app.Id /T /F }
  }
}
$uninstaller = Start-Process (Join-Path $destination 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller exited $($uninstaller.ExitCode)" }
if (Test-Path (Join-Path $destination 'Scene Finder.exe')) { throw 'Uninstall left the app executable behind.' }
if (Test-Path $shortcut) { throw 'Uninstall left the Start menu shortcut behind.' }
Write-Host 'Windows install, app launch, and uninstall passed.'
