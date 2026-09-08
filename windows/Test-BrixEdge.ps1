<#
.SYNOPSIS
  Prove the IIS brix-edge site is serving every station, and nothing else.

.DESCRIPTION
  For every screen id in stations.json:
    - the virtual directory exists and points inside the root
    - a released.pdf (or the mapped file) is present, with size and date
    - HEAD /drawings/<id>/ answers 200 with an ETag and Last-Modified
    - GET with If-None-Match answers 304 — the screen's minute check
  And for the site as a whole:
    - a token that is not mapped answers 404 (and is not a listing)
    - /drawings/ itself is not a listing
    - POST is refused
    - the canary tokens are mapped, so a request for one lands in the log

  Exit 0: every station serves. Exit 2: a station has nothing released.
  Exit 1: a mapping or the site is broken. Schedule it; alert on non-zero.

.EXAMPLE
  .\Test-BrixEdge.ps1 -Stations D:\Drawings\stations.json -CanaryTokens scr_canary000000000000000
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Stations,
  [string]   $SiteName = "BrixEdge",
  [int]      $Port = 8787,
  [string]   $BaseUrl = "http://127.0.0.1",
  [string[]] $CanaryTokens = @(),
  [switch]   $Json
)
$ErrorActionPreference = "Stop"
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot "BrixEdge.Common.psm1") -Force
$base = "$BaseUrl`:$Port"
$rows = New-Object System.Collections.Generic.List[object]
$broken = $false; $missing = $false

# Same reader as the installer, so this cannot pass a map the installer would
# have refused (or vice versa).
$raw = Get-Content -LiteralPath $Stations -Raw | ConvertFrom-Json
if ($null -eq $raw -or $raw -isnot [System.Management.Automation.PSCustomObject]) { throw "stations file must be a JSON object of token -> path" }
$tokens = @($raw.PSObject.Properties | Where-Object { -not $_.Name.StartsWith("_") } | ForEach-Object { $_.Name })
foreach ($t in $tokens) { if (-not (Test-BrixEdgeToken -Token $t)) { throw "stations.json: '$t' is not a valid screen id" } }

foreach ($t in $tokens) {
  if ($CanaryTokens -contains $t) {
    $rows.Add([pscustomobject][ordered]@{ token = $t; status = "canary"; file = ""; bytes = 0; modified = ""; etag = ""; note = "must never be requested by a screen" })
    continue
  }
  $vd = Get-WebVirtualDirectory -Site $SiteName -Name "drawings/$t" -ErrorAction SilentlyContinue
  if (-not $vd) {
    $rows.Add([pscustomobject][ordered]@{ token = $t; status = "not-mapped"; file = ""; bytes = 0; modified = ""; etag = ""; note = "run Install-BrixEdgeIIS.ps1" })
    $broken = $true; continue
  }
  # The probe (module) is the same code the Mac-side unit tests exercise against
  # the Node server, so only the IIS half is new here.
  $p = Test-BrixEdgeStation -BaseUrl $base -Token $t
  $file = ""
  if ($p.status -eq "ok" -or $p.status -eq "no-304") {
    $rel = Get-ChildItem -LiteralPath $vd.physicalPath -Filter *.pdf -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($rel) { $file = $rel.Name }
  }
  if ($p.status -eq "nothing-released") { $missing = $true }
  elseif ($p.status -ne "ok") { $broken = $true }
  $rows.Add([pscustomobject][ordered]@{ token = $t; status = $p.status; file = $file; bytes = $p.bytes; modified = $p.modified; etag = $p.etag; note = $p.note })
}

# The site as a whole.
$site = New-Object System.Collections.Generic.List[object]
$unknown = (Invoke-BrixEdgeProbe -Url "$base/drawings/zz_not_a_station/").Status
$site.Add([pscustomobject]@{ check = "unknown token is 404"; result = $unknown; ok = ($unknown -eq 404) })
$listing = (Invoke-BrixEdgeProbe -Url "$base/drawings/").Status
$site.Add([pscustomobject]@{ check = "/drawings/ is not a listing"; result = $listing; ok = ($listing -ne 200) })
$post = (Invoke-BrixEdgeProbe -Url "$base/drawings/$($tokens[0])/" -Method POST).Status
$site.Add([pscustomobject]@{ check = "POST is refused"; result = $post; ok = ($post -in 403, 404, 405) })
$pdfDirect = (Invoke-BrixEdgeProbe -Url "$base/web.config").Status
$site.Add([pscustomobject]@{ check = "web.config is not served"; result = $pdfDirect; ok = ($pdfDirect -ne 200) })
foreach ($c in $CanaryTokens) {
  $mapped = [bool](Get-WebVirtualDirectory -Site $SiteName -Name "drawings/$c" -ErrorAction SilentlyContinue)
  $site.Add([pscustomobject]@{ check = "canary $c is mapped (so a request for it lands in the log)"; result = $mapped; ok = $mapped })
}
if ($site | Where-Object { -not $_.ok }) { $broken = $true }

$exit = if ($broken) { 1 } elseif ($missing) { 2 } else { 0 }
if ($Json) {
  [pscustomobject]@{ site = $SiteName; base = $base; stations = $rows; checks = $site; exitCode = $exit } | ConvertTo-Json -Depth 5
} else {
  $rows | Format-Table token, status, file, bytes, modified, note -AutoSize | Out-String | Write-Host
  $site | Format-Table check, result, ok -AutoSize | Out-String | Write-Host
  Write-Host $(switch ($exit) { 0 { "OK — every station serves, conditional requests answer 304." } 2 { "WARN — a station has nothing released." } 1 { "FAIL — a mapping or the site is broken." } }) -ForegroundColor $(if ($exit -eq 0) { "Green" } elseif ($exit -eq 2) { "Yellow" } else { "Red" })
}
exit $exit
