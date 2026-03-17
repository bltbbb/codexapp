param(
  [Parameter(Mandatory = $true)]
  [string]$Url,

  [Parameter(Mandatory = $true)]
  [string]$ApiKey,

  [Parameter(Mandatory = $true)]
  [string]$JsonBase64,

  [int]$TimeoutSec = 90,

  [string]$ProxyUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($JsonBase64))
$headers = @{
  Authorization = "Bearer $ApiKey"
}

$params = @{
  Uri = $Url
  Method = 'Post'
  ContentType = 'application/json; charset=utf-8'
  Body = $json
  Headers = $headers
  TimeoutSec = $TimeoutSec
}

if ($ProxyUrl) {
  $params.Proxy = $ProxyUrl
}

$response = Invoke-RestMethod @params
$response | ConvertTo-Json -Depth 100 -Compress
