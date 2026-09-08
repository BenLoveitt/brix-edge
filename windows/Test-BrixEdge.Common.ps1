<#
.SYNOPSIS
  Unit tests for the IIS kit's pure logic. Runs anywhere PowerShell 7 runs —
  including a Mac — so the parts that do not need IIS are actually proven.

.DESCRIPTION
  What this covers: token validation, CIDR to subnet mask, the root-containment
  rule, stations.json reading, W3C log parsing and canary classification.

  What it does NOT cover, and what still needs a Windows Server: the IIS
  cmdlets themselves (New-Website, virtual directories, ipSecurity, the
  firewall rule) and the HTTP behaviour that comes from web.config. Run
  Test-BrixEdge.ps1 on the host for those.

  No Pester, no modules to install: `pwsh -File Test-BrixEdge.Common.ps1`.
  Exit 0 all passed, 1 something failed.
#>
[CmdletBinding()]
param()

Import-Module (Join-Path $PSScriptRoot "BrixEdge.Common.psm1") -Force

$script:Pass = 0
$script:Fail = 0

function It($name, [scriptblock] $body) {
  try { & $body; $script:Pass++; Write-Host "  ok   $name" -ForegroundColor DarkGray }
  catch { $script:Fail++; Write-Host "  FAIL $name" -ForegroundColor Red; Write-Host "       $($_.Exception.Message)" -ForegroundColor Red }
}
function Expect($actual, $expected, $because = "") {
  $a = if ($null -eq $actual) { "<null>" } else { $actual.ToString() }
  $e = if ($null -eq $expected) { "<null>" } else { $expected.ToString() }
  if ($a -cne $e) { throw "expected '$e', got '$a'. $because" }
}
function ExpectThrows([scriptblock] $body, $matching = "") {
  try { & $body } catch { if ($matching -and $_.Exception.Message -notlike "*$matching*") { throw "threw, but not with '$matching': $($_.Exception.Message)" }; return }
  throw "expected a throw$(if ($matching) { " matching '$matching'" }), but it succeeded"
}

$sep = [IO.Path]::DirectorySeparatorChar

Write-Host "`nToken shape — what Brix stores, and the only thing that reaches us"
It "accepts a screen id" { Expect (Test-BrixEdgeToken "scr_9f2c1e0d4b7a4c1e8f2a") $true }
It "accepts dots and hyphens inside" { Expect (Test-BrixEdgeToken "a.b-c_1") $true }
It "refuses '..' and '.', so a token can never climb" {
  Expect (Test-BrixEdgeToken "..") $false
  Expect (Test-BrixEdgeToken ".") $false
  Expect (Test-BrixEdgeToken ".hidden") $false
}
It "refuses a path, a space, an empty string and anything over 128" {
  Expect (Test-BrixEdgeToken "parts/44-1187") $false
  Expect (Test-BrixEdgeToken "scr 1") $false
  Expect (Test-BrixEdgeToken "") $false
  Expect (Test-BrixEdgeToken ("a" * 129)) $false
  Expect (Test-BrixEdgeToken ("a" * 128)) $true
}

Write-Host "`nCIDR to subnet mask — the -AllowFrom ranges IIS needs"
It "converts the ranges a plant actually uses" {
  Expect (ConvertTo-SubnetMask 16) "255.255.0.0"
  Expect (ConvertTo-SubnetMask 8)  "255.0.0.0"
  Expect (ConvertTo-SubnetMask 24) "255.255.255.0"
  Expect (ConvertTo-SubnetMask 23) "255.255.254.0"
  Expect (ConvertTo-SubnetMask 32) "255.255.255.255"
  Expect (ConvertTo-SubnetMask 0)  "0.0.0.0"
}
It "covers every prefix length without throwing (the old one-liner threw on all but 0)" {
  for ($i = 0; $i -le 32; $i++) { $m = ConvertTo-SubnetMask $i; if (-not [IPAddress]::Parse($m)) { throw "bad mask at /$i" } }
}
It "refuses a prefix that is not 0-32" {
  ExpectThrows { ConvertTo-SubnetMask 33 } "0-32"
  ExpectThrows { ConvertTo-SubnetMask -1 } "0-32"
}
It "splits a CIDR into address and mask" {
  $r = ConvertFrom-Cidr "10.50.0.0/16"
  Expect $r.Address "10.50.0.0"; Expect $r.SubnetMask "255.255.0.0"
}
It "treats a bare address as a single host" {
  $r = ConvertFrom-Cidr "10.50.8.22"
  Expect $r.PrefixLength 32; Expect $r.SubnetMask "255.255.255.255"
}
It "refuses a typo rather than storing an allow rule nobody notices" {
  ExpectThrows { ConvertFrom-Cidr "10.50.0/16" } "not an IPv4 address"    # .NET would read this as 10.50.0.0
  ExpectThrows { ConvertFrom-Cidr "10.50.8/24" } "not an IPv4 address"    # …and this as 10.50.0.8, a different network
  ExpectThrows { ConvertFrom-Cidr "10.50.0.0.0/16" } "not an IPv4 address"
  ExpectThrows { ConvertFrom-Cidr "not-an-ip/16" } "not an IPv4 address"
  ExpectThrows { ConvertFrom-Cidr "10.50.0.0/sixteen" } "not a prefix length"
  ExpectThrows { ConvertFrom-Cidr "10.50.0.0/16/8" } "not a CIDR"
}

Write-Host "`nRoot containment — a mapped path may never leave the drawings tree"
$root = Join-Path ([IO.Path]::GetTempPath()) ("brix-edge-ps-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$null = New-Item -ItemType Directory -Force -Path (Join-Path $root "parts$($sep)44-1187")
It "resolves a station folder inside the root" {
  Expect (Resolve-StationPath -Root $root -Relative "parts$($sep)44-1187") ([IO.Path]::GetFullPath((Join-Path $root "parts$($sep)44-1187")))
}
It "refuses a climb, an absolute path and an empty one" {
  ExpectThrows { Resolve-StationPath -Root $root -Relative ".." } "escapes the root"
  ExpectThrows { Resolve-StationPath -Root $root -Relative "parts$($sep)..$($sep)..$($sep)elsewhere" } "escapes the root"
  ExpectThrows { Resolve-StationPath -Root $root -Relative ([IO.Path]::GetTempPath()) } "absolute"
  ExpectThrows { Resolve-StationPath -Root $root -Relative "" } "empty"
}
It "refuses a sibling that merely starts with the root's name" {
  # D:\Drawings vs D:\DrawingsEvil — StartsWith without the separator is the bug.
  ExpectThrows { Resolve-StationPath -Root $root -Relative "..$($sep)$(Split-Path $root -Leaf)Evil$($sep)x" } "escapes the root"
}

Write-Host "`nstations.json — one bad entry stops the whole run"
$stations = Join-Path $root "stations.json"
It "reads the stations and skips _comment keys" {
  '{ "_comment": "hi", "scr_a": "parts/44-1187" }' | Set-Content -LiteralPath $stations
  $map = Read-BrixEdgeStationMap -Root $root -StationsFile $stations
  Expect $map.Count 1
  Expect $map["scr_a"] ([IO.Path]::GetFullPath((Join-Path $root "parts$($sep)44-1187")))
}
It "refuses a bad token, a non-string value, an escaping path and a JSON array" {
  '{ "scr a": "parts/44-1187" }' | Set-Content -LiteralPath $stations
  ExpectThrows { Read-BrixEdgeStationMap -Root $root -StationsFile $stations } "not a valid screen id"
  '{ "scr_a": 42 }' | Set-Content -LiteralPath $stations
  ExpectThrows { Read-BrixEdgeStationMap -Root $root -StationsFile $stations } "must map to a path string"
  '{ "scr_a": "../outside" }' | Set-Content -LiteralPath $stations
  ExpectThrows { Read-BrixEdgeStationMap -Root $root -StationsFile $stations } "escapes the root"
  '["scr_a"]' | Set-Content -LiteralPath $stations
  ExpectThrows { Read-BrixEdgeStationMap -Root $root -StationsFile $stations } "JSON object"
}

Write-Host "`nW3C log parsing and the canary alarm"
$log = @(
  '#Software: Microsoft Internet Information Services 10.0',
  '#Fields: date time c-ip cs-method cs-uri-stem sc-status sc-bytes cs(User-Agent)',
  '2026-09-08 09:15:02 10.50.8.22 GET /drawings/scr_a/ 200 581 BrixPlayer-LanCapture',
  '2026-09-08 09:16:02 10.50.8.22 GET /drawings/scr_a/ 304 0 BrixPlayer-LanCapture',
  '2026-09-08 09:17:44 10.50.9.7 GET /drawings/scr_canary/ 404 0 curl/8.4.0',
  '2026-09-08 09:18:00 10.50.9.7 GET /drawings/scr_typo/ 404 0 curl/8.4.0',
  '2026-09-08 09:19:00 10.50.8.22 GET /healthz 200 40 kube-probe',
  '#Fields: date time c-ip cs-uri-stem sc-status',
  '2026-09-08 09:20:00 10.50.9.9 /drawings/scr_canary/ 404'
)
It "reads records by the #Fields header, and re-reads it when it changes mid-file" {
  $recs = ConvertFrom-W3CLog -Lines $log
  Expect $recs.Count 6   # six data lines; the two #Fields and the #Software line are not records
  Expect $recs[0].'cs-uri-stem' "/drawings/scr_a/"
  # The last record came after a SECOND #Fields line with FEWER columns, and is
  # still read correctly — positional parsing would have put the status in c-ip.
  Expect $recs[5].'cs-uri-stem' "/drawings/scr_canary/"
  Expect $recs[5].'sc-status' "404"
  Expect $recs[5].'c-ip' "10.50.9.9"
}
It "raises the canary and the unknown token, and stays quiet about real stations" {
  $recs = ConvertFrom-W3CLog -Lines $log
  $hits = Find-BrixEdgeAlarms -Records $recs -KnownTokens @("scr_a", "scr_canary") -CanaryTokens @("scr_canary")
  Expect $hits.Count 3
  Expect (@($hits | Where-Object kind -eq "CANARY").Count) 2
  Expect (@($hits | Where-Object kind -eq "unknown-token").Count) 1
  Expect (@($hits | Where-Object token -eq "scr_typo")[0].client) "10.50.9.7"
  Expect (@($hits | Where-Object { $_.token -eq "scr_a" }).Count) 0
}
It "a canary hit is an alarm whatever the status — a 200 would be worse, not quieter" {
  $recs = ConvertFrom-W3CLog -Lines @(
    '#Fields: date time c-ip cs-uri-stem sc-status',
    '2026-09-08 10:00:00 10.0.0.9 /drawings/scr_canary/ 200'
  )
  $hits = Find-BrixEdgeAlarms -Records $recs -KnownTokens @("scr_canary") -CanaryTokens @("scr_canary")
  Expect $hits.Count 1
  Expect $hits[0].kind "CANARY"
}
It "ignores /healthz, /metrics and anything that is not a drawing request" {
  $recs = ConvertFrom-W3CLog -Lines @(
    '#Fields: date time c-ip cs-uri-stem sc-status',
    '2026-09-08 10:00:00 10.0.0.9 /healthz 200',
    '2026-09-08 10:00:01 10.0.0.9 /drawings/ 404',
    '2026-09-08 10:00:02 10.0.0.9 /drawings/scr_a/deeper/path 404'
  )
  Expect (Find-BrixEdgeAlarms -Records $recs -KnownTokens @("scr_a") -CanaryTokens @()).Count 0
}

Write-Host "`nThe HTTP probe, against a real server"
# Test-BrixEdge.ps1's probe is the same code on IIS and here. IIS's own
# default-document/ETag/304 behaviour still needs a Windows host, but the
# PROBE — which is the part I wrote — is proven against the Node brix-edge
# server, which answers the same contract.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  skip (no node on PATH — the probe tests need the reference server)" -ForegroundColor Yellow
} else {
  $probeRoot = Join-Path ([IO.Path]::GetTempPath()) ("brix-edge-probe-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $probeRoot "parts$($sep)44-1187"), (Join-Path $probeRoot "parts$($sep)44-1200")
  # A real, minimal PDF: the server sniffs %PDF before it serves anything.
  $pdf = "%PDF-1.4`n1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`nendobj`ntrailer`n<< /Size 4 /Root 1 0 R >>`n%%EOF`n"
  [IO.File]::WriteAllText((Join-Path $probeRoot "parts$($sep)44-1187$($sep)released.pdf"), $pdf)
  $probeStations = Join-Path $probeRoot "stations.json"
  '{ "scr_a": "parts/44-1187", "scr_empty": "parts/44-1200", "scr_canary": "parts/44-1187" }' | Set-Content -LiteralPath $probeStations
  $port = Get-Random -Minimum 41000 -Maximum 44000
  $server = Join-Path (Split-Path $PSScriptRoot -Parent) "src$($sep)edge.mjs"
  $psi = [System.Diagnostics.ProcessStartInfo]::new($node.Source, "`"$server`" start")
  $psi.EnvironmentVariables["BRIX_EDGE_ROOT"] = $probeRoot
  $psi.EnvironmentVariables["BRIX_EDGE_MAP"] = $probeStations
  $psi.EnvironmentVariables["BRIX_EDGE_BIND"] = "127.0.0.1"
  $psi.EnvironmentVariables["BRIX_EDGE_PORT"] = "$port"
  $psi.EnvironmentVariables["BRIX_EDGE_CANARY_TOKENS"] = "scr_canary"
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $base = "http://127.0.0.1:$port"
  $up = $false
  foreach ($i in 1..50) { Start-Sleep -Milliseconds 100; if ((Invoke-BrixEdgeProbe -Url "$base/healthz" -Method GET -TimeoutSec 2).Status -eq 200) { $up = $true; break } }
  try {
    if (-not $up) { throw "the reference server did not come up on $base" }

    It "a station serves its drawing as a PDF, with an ETag" {
      $p = Invoke-BrixEdgeProbe -Url "$base/drawings/scr_a" -Method GET
      Expect $p.Status 200
      Expect $p.ContentType "application/pdf"
      if (-not $p.ETag) { throw "no ETag" }
      if ($p.Length -le 0) { throw "no Content-Length" }
    }
    It "the minute check: the same ETag comes back 304" {
      $first = Invoke-BrixEdgeProbe -Url "$base/drawings/scr_a"
      $again = Invoke-BrixEdgeProbe -Url "$base/drawings/scr_a" -Headers @{ "If-None-Match" = $first.ETag }
      Expect $again.Status 304
    }
    It "Test-BrixEdgeStation reads that as 'ok'" {
      Expect (Test-BrixEdgeStation -BaseUrl $base -Token "scr_a").status "ok"
    }
    It "a station with nothing released reads as 'nothing-released', not a failure" {
      Expect (Test-BrixEdgeStation -BaseUrl $base -Token "scr_empty").status "nothing-released"
    }
    It "an unmapped token is 404 and a canary token is 404 — neither serves bytes" {
      Expect (Invoke-BrixEdgeProbe -Url "$base/drawings/zz_not_a_station").Status 404
      Expect (Invoke-BrixEdgeProbe -Url "$base/drawings/scr_canary").Status 404
    }
    It "POST is refused" {
      Expect (Invoke-BrixEdgeProbe -Url "$base/drawings/scr_a" -Method POST).Status 405
    }
    It "an unreachable host is reported, not thrown" {
      $p = Invoke-BrixEdgeProbe -Url "http://127.0.0.1:1/drawings/scr_a" -Method GET -TimeoutSec 2
      Expect $p.Status -1
      if (-not $p.Error) { throw "no error message to show the operator" }
      Expect (Test-BrixEdgeStation -BaseUrl "http://127.0.0.1:1" -Token "scr_a").status "unreachable"
    }
  } finally {
    if ($proc -and -not $proc.HasExited) { $proc.Kill() }
    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($script:Fail -eq 0) { Write-Host "$script:Pass passed, 0 failed" -ForegroundColor Green; exit 0 }
Write-Host "$script:Pass passed, $script:Fail FAILED" -ForegroundColor Red
exit 1
