<#
.SYNOPSIS
  Removes the Video Saver yt-dlp helper's registry entries and generated files.
  Your yt-dlp.exe and downloaded videos are not touched.
#>
$ErrorActionPreference = "Stop"
$HostName = "com.videosaver.ytdlp"
foreach ($browser in @("Google\Chrome", "Microsoft\Edge", "BraveSoftware\Brave-Browser")) {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
  if (Test-Path $key) { Remove-Item -Path $key -Force }
}
foreach ($f in @("$HostName.json", "host.bat", "config.json", "host.log")) {
  $p = Join-Path $PSScriptRoot $f
  if (Test-Path $p) { Remove-Item $p -Force }
}
Write-Host "Removed the Video Saver yt-dlp helper."
