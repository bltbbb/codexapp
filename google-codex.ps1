param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$SearchUrl = 'https://www.google.com/search?q=codex',

  [int]$WaitMilliseconds = 8000,

  [string]$BrowserPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-BrowserPath {
  param(
    [string]$PreferredPath
  )

  if ($PreferredPath -and (Test-Path $PreferredPath)) {
    return $PreferredPath
  }

  $candidates = @(
    "$Env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${Env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$Env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${Env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $commands = @('msedge.exe', 'chrome.exe')
  foreach ($name in $commands) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw '未找到 Edge 或 Chrome，请在 .env 中配置 BROWSER_PATH。'
}

function Focus-ProcessWindow {
  param(
    [int]$ProcessId
  )

  $shell = New-Object -ComObject WScript.Shell
  $attempts = 0
  while ($attempts -lt 10) {
    if ($shell.AppActivate($ProcessId)) {
      Start-Sleep -Milliseconds 800
      return
    }

    $attempts++
    Start-Sleep -Milliseconds 500
  }
}

function Save-ScreenShot {
  param(
    [string]$TargetPath
  )

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $directory = Split-Path -Parent $TargetPath
  if (-not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($TargetPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$resolvedBrowser = Resolve-BrowserPath -PreferredPath $BrowserPath
$arguments = @('--new-window', $SearchUrl)
$process = Start-Process -FilePath $resolvedBrowser -ArgumentList $arguments -PassThru

Start-Sleep -Milliseconds $WaitMilliseconds
Focus-ProcessWindow -ProcessId $process.Id
Save-ScreenShot -TargetPath $OutputPath

Write-Output $OutputPath
