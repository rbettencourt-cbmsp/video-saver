<#
.SYNOPSIS
  Registers the Video Saver yt-dlp helper (native messaging host) for the current user.

.DESCRIPTION
  * Writes native-host\config.json with the path to your yt-dlp.exe
  * Writes native-host\host.bat, which starts host.js with your Node.js
  * Writes the host manifest native-host\com.videosaver.ytdlp.json, allowing only this
    extension's ID (computed from the "key" in manifest.json)
  * Points HKCU\Software\<Chrome|Edge>\NativeMessagingHosts\com.videosaver.ytdlp at it
  No admin rights are needed; nothing outside your user profile and this folder changes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1
  powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1 -YtDlpPath "D:\tools\yt-dlp.exe"
#>
param(
  [string]$YtDlpPath = "",
  [string]$FfmpegPath = "",
  [string]$DefaultFolder = ""
)
$ErrorActionPreference = "Stop"
$HostName = "com.videosaver.ytdlp"
$HostDir = $PSScriptRoot
$ExtDir = Split-Path $HostDir -Parent

# --- Extension ID from manifest.json "key" (Chrome's rule: SHA-256 of the key, first 32 hex digits mapped 0-f -> a-p)
$manifest = Get-Content (Join-Path $ExtDir "manifest.json") -Raw | ConvertFrom-Json
if (-not $manifest.key) { throw "manifest.json has no 'key', so the extension ID isn't fixed." }
$der = [Convert]::FromBase64String($manifest.key)
$hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
$hex = -join ($hash[0..15] | ForEach-Object { $_.ToString("x2") })
$ExtId = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) })
$Origin = "chrome-extension://$ExtId/"

# Windows PowerShell's "UTF8" adds a byte-order mark; write plain UTF-8 instead.
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# --- yt-dlp.exe
if (-not $YtDlpPath) {
  $existing = Join-Path $HostDir "config.json"
  if (Test-Path $existing) { $YtDlpPath = (Get-Content $existing -Raw | ConvertFrom-Json).ytDlpPath }
}
if (-not $YtDlpPath) { $YtDlpPath = Join-Path $ExtDir "yt-dlp.exe" }
$YtDlpPath = [System.IO.Path]::GetFullPath($YtDlpPath)
if (-not (Test-Path $YtDlpPath -PathType Leaf)) { throw "yt-dlp.exe not found at $YtDlpPath. Pass -YtDlpPath ""C:\path\to\yt-dlp.exe""." }

# --- Node.js
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js (node.exe) wasn't found on PATH. Install it from https://nodejs.org and run this again." }

# --- config.json
if (-not $DefaultFolder) { $DefaultFolder = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\Video Saver" }
$config = [ordered]@{
  ytDlpPath      = $YtDlpPath
  ffmpegPath     = $FfmpegPath
  defaultFolder  = $DefaultFolder
  allowedOrigins = @($Origin)
}
Write-Utf8NoBom (Join-Path $HostDir "config.json") ($config | ConvertTo-Json)

# --- host.bat (Chrome runs this; it must not print anything itself)
$bat = "@echo off`r`n""$node"" ""%~dp0host.js"" %*`r`n"
[System.IO.File]::WriteAllText((Join-Path $HostDir "host.bat"), $bat, [System.Text.Encoding]::ASCII)

# --- Host manifest
$hostManifestPath = Join-Path $HostDir "$HostName.json"
$hostManifest = [ordered]@{
  name            = $HostName
  description     = "Video Saver yt-dlp helper"
  path            = (Join-Path $HostDir "host.bat")
  type            = "stdio"
  allowed_origins = @($Origin)
}
Write-Utf8NoBom $hostManifestPath ($hostManifest | ConvertTo-Json)

# --- Registry (current user only)
foreach ($browser in @("Google\Chrome", "Microsoft\Edge", "BraveSoftware\Brave-Browser")) {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $hostManifestPath
}

Write-Host "Installed the Video Saver yt-dlp helper."
Write-Host "  Extension ID : $ExtId"
Write-Host "  yt-dlp.exe   : $YtDlpPath  (version $(& $YtDlpPath --version))"
Write-Host "  Node.js      : $node"
Write-Host "  Host manifest: $hostManifestPath"
Write-Host "Reload the extension in chrome://extensions, then open a YouTube video."
