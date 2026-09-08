<#
.SYNOPSIS
  The alarm: scan the IIS log for any request to a canary token, or to a token
  that is not a station.

.DESCRIPTION
  A canary is a screen id that exists in stations.json but was never given to
  any screen. Nothing should ever ask for it. This reads the site's W3C logs
  for the last -Days days and prints every request to a canary token and every
  request to /drawings/<something> that is not a mapped station, with the
  client address and time. Exit 1 if anything was found — schedule it (Task
  Scheduler, hourly) with an email or SIEM action on failure, or point your
  SIEM at the log directory and use the query in README.md instead.

.EXAMPLE
  .\Find-CanaryHits.ps1 -Stations D:\Drawings\stations.json -CanaryTokens scr_canary000000000000000 -Days 1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Stations,
  [string]   $SiteName = "BrixEdge",
  [string[]] $CanaryTokens = @(),
  [int]      $Days = 1
)
$ErrorActionPreference = "Stop"
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot "BrixEdge.Common.psm1") -Force
$site = Get-Website -Name $SiteName
if (-not $site) { throw "site $SiteName not found" }
$logDir = Join-Path ((Get-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.directory).Value -replace '%SystemDrive%', $env:SystemDrive) "W3SVC$($site.id)"
# The station list is the "known" set; anything else under /drawings/ is a typo
# or a probe. Only the NAMES matter here — the paths are the installer's business.
$raw = Get-Content -LiteralPath $Stations -Raw | ConvertFrom-Json
if ($null -eq $raw -or $raw -isnot [System.Management.Automation.PSCustomObject]) { throw "stations file must be a JSON object of token -> path" }
$known = @($raw.PSObject.Properties | Where-Object { -not $_.Name.StartsWith("_") } | ForEach-Object { $_.Name })

$since = (Get-Date).AddDays(-$Days)
$hits = New-Object System.Collections.Generic.List[object]
Get-ChildItem -LiteralPath $logDir -Filter *.log -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $since } | ForEach-Object {
  $name = $_.Name
  $records = ConvertFrom-W3CLog -Lines ([IO.File]::ReadAllLines($_.FullName))
  foreach ($h in (Find-BrixEdgeAlarms -Records $records -KnownTokens $known -CanaryTokens $CanaryTokens)) {
    $hits.Add(([pscustomobject]@{ kind = $h.kind; when = $h.when; client = $h.client; token = $h.token; status = $h.status; agent = $h.agent; log = $name }))
  }
}
if ($hits.Count -eq 0) {
  Write-Host "No canary or unknown-token requests in the last $Days day(s). Log: $logDir" -ForegroundColor Green
  exit 0
}
$hits | Sort-Object when | Format-Table kind, when, client, token, status, agent -AutoSize | Out-String | Write-Host
Write-Host "$($hits.Count) request(s) that no screen should have made. Log: $logDir" -ForegroundColor Red
exit 1
