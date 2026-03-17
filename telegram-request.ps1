param(
  [Parameter(Mandatory = $true)]
  [string]$Method,

  [Parameter(Mandatory = $true)]
  [string]$Token,

  [string]$JsonBase64 = '',

  [string]$ProxyUrl = '',

  [string]$PhotoPath = '',

  [string]$DocumentPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$url = "https://api.telegram.org/bot$Token/$Method"
$params = @{
  Uri = $url
  Method = 'Post'
  TimeoutSec = 60
}

if ($ProxyUrl) {
  $params.Proxy = $ProxyUrl
}

if ($PhotoPath -or $DocumentPath) {
  $form = @{}

  if ($JsonBase64) {
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($JsonBase64))
    $payload = $json | ConvertFrom-Json -AsHashtable
    foreach ($entry in $payload.GetEnumerator()) {
      if ([string]::IsNullOrEmpty([string]$entry.Value)) {
        continue
      }
      if ($entry.Key -in @('photo', 'document')) {
        continue
      }
      $form[$entry.Key] = [string]$entry.Value
    }
  }

  if ($PhotoPath) {
    $form.photo = Get-Item -LiteralPath $PhotoPath
  }
  if ($DocumentPath) {
    $form.document = Get-Item -LiteralPath $DocumentPath
  }

  $params.Form = $form
} else {
  $json = if ($JsonBase64) {
    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($JsonBase64))
  } else {
    '{}'
  }

  $params.ContentType = 'application/json; charset=utf-8'
  $params.Body = $json

  try {
    $bodyHash = $json | ConvertFrom-Json -AsHashtable
    if ($bodyHash.ContainsKey('timeout')) {
      $params.TimeoutSec = [Math]::Max([int]$bodyHash.timeout + 30, 60)
    }
  } catch {
  }
}

$response = Invoke-RestMethod @params
$response | ConvertTo-Json -Depth 100 -Compress
