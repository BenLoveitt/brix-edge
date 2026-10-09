<#
  The parts of the IIS kit that are pure logic, in one module, so they can be
  TESTED without an IIS host — which is the difference between "the script was
  written" and "the script works". Test-BrixEdge.Common.ps1 runs these on any
  machine with PowerShell 7, including a developer's Mac.

  Everything that needs IIS itself (New-Website, virtual directories, ipSecurity)
  stays in the scripts and still needs a Windows Server to prove.

  Path handling uses [IO.Path]::DirectorySeparatorChar deliberately: on Windows
  that is "\" and the containment check means what it says; on a Mac it is "/"
  so the same tests run and the same rule is exercised.
#>

$script:Sep = [IO.Path]::DirectorySeparatorChar

<#
.SYNOPSIS
  Is this a valid screen token (the id Brix stores, which is the only thing
  that reaches us)?
.DESCRIPTION
  Must start with a letter or digit, so "." and ".." can never be tokens, and
  may then hold letters, digits, dot, underscore and hyphen. Mirrors
  TOKEN_SHAPE in ../src/config.mjs and normalizeOnNetworkSuffix's sibling rule
  in the player — one address set, several languages.
#>
function Test-BrixEdgeToken {
  [OutputType([bool])]
  param([Parameter(Mandatory)][AllowEmptyString()][string] $Token)
  return $Token -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
}

<#
.SYNOPSIS
  A CIDR prefix length as a dotted subnet mask, which is the only form IIS's
  ipSecurity collection accepts.
.DESCRIPTION
  Built a byte at a time with integer arithmetic. The obvious one-liner
  (`[uint32]0xFFFFFFFF -shl (32 - $bits)`) is wrong in PowerShell: -shl
  operates on Int32, the result is -1, and casting that to [uint32] throws —
  so every -AllowFrom range failed. Proven by Test-BrixEdge.Common.ps1.
#>
function ConvertTo-SubnetMask {
  [OutputType([string])]
  param([Parameter(Mandatory)][int] $PrefixLength)
  if ($PrefixLength -lt 0 -or $PrefixLength -gt 32) { throw "prefix length must be 0-32, got $PrefixLength" }
  $bytes = @(0, 0, 0, 0)
  for ($i = 0; $i -lt 4; $i++) {
    $take = [Math]::Min(8, [Math]::Max(0, $PrefixLength - ($i * 8)))
    $bytes[$i] = ((0xFF -shl (8 - $take)) -band 0xFF)
  }
  return ($bytes -join '.')
}

<#
.SYNOPSIS
  Split "10.50.0.0/16" into the address and its dotted mask, or throw.
.DESCRIPTION
  A bare address (no "/") is a single host, /32. The address is validated as
  IPv4: IIS's ipSecurity is IPv4/IPv6 address plus mask, and a typo here would
  otherwise be stored as an allow rule nobody notices.
#>
function ConvertFrom-Cidr {
  param([Parameter(Mandatory)][string] $Cidr)
  $parts = $Cidr.Trim().Split('/')
  if ($parts.Count -gt 2) { throw "not a CIDR range: $Cidr" }
  $ip = $parts[0]
  $bits = if ($parts.Count -eq 2 -and $parts[1]) { $parts[1] } else { '32' }
  # FOUR octets, spelled out. [IPAddress]::TryParse accepts .NET's legacy
  # short forms: "10.50.0" parses as 10.50.0.0 and "10.50.8" as 10.50.0.8 —
  # so a typed range would become a DIFFERENT network, stored as an allow rule
  # that looks right in the panel. Proven in Test-BrixEdge.Common.ps1.
  $parsed = [IPAddress]::Any
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
      -not [IPAddress]::TryParse($ip, [ref]$parsed) -or
      $parsed.AddressFamily -ne 'InterNetwork' -or
      $parsed.ToString() -ne $ip) {
    throw "not an IPv4 address: $ip (in $Cidr). Write all four octets, e.g. 10.50.0.0/16"
  }
  $n = 0
  if (-not [int]::TryParse($bits, [ref]$n)) { throw "not a prefix length: $bits (in $Cidr)" }
  return [pscustomobject]@{ Address = $parsed.ToString(); PrefixLength = $n; SubnetMask = (ConvertTo-SubnetMask -PrefixLength $n) }
}

<#
.SYNOPSIS
  Where a station's drawing lives, or why it may not be served.
.DESCRIPTION
  The containment rule, and the whole of it: a mapped path must resolve inside
  the root. "..", an absolute path and a path that merely starts with the
  root's NAME ("D:\DrawingsEvil") are all refused. Returns the full path, or
  throws with the reason — the caller decides whether that is fatal.
#>
function Resolve-StationPath {
  [OutputType([string])]
  param(
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Relative
  )
  if ([string]::IsNullOrWhiteSpace($Relative)) { throw "empty path" }
  if ($Relative.Contains("`0")) { throw "path contains a null byte" }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd($script:Sep)
  if ([IO.Path]::IsPathRooted($Relative)) { throw "absolute paths are not allowed: $Relative" }
  $full = [IO.Path]::GetFullPath([IO.Path]::Combine($rootFull, $Relative))
  if ($full -ne $rootFull -and -not $full.StartsWith($rootFull + $script:Sep, [StringComparison]::OrdinalIgnoreCase)) {
    throw "path escapes the root: $Relative"
  }
  return $full
}

<#
.SYNOPSIS
  Read stations.json into an ordered token -> full path map, refusing anything
  that is not a station.
.DESCRIPTION
  Keys beginning "_" are comments. Every other key must be a valid token, every
  value a path that stays inside the root. One bad entry throws: a half-applied
  station map is worse than none, because the operator would believe the run
  succeeded.
#>
function Read-BrixEdgeStationMap {
  param(
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][string] $StationsFile
  )
  $raw = Get-Content -LiteralPath $StationsFile -Raw | ConvertFrom-Json
  # A JSON ARRAY is UNROLLED by the pipeline, so `-is [array]` never fires: the
  # variable holds a bare string whose .PSObject.Properties is "Length", and the
  # map would be built from that. Require the object form explicitly.
  if ($null -eq $raw -or $raw -isnot [System.Management.Automation.PSCustomObject]) {
    throw "stations file must be a JSON object of token -> path"
  }
  $map = [ordered]@{}
  foreach ($p in $raw.PSObject.Properties) {
    if ($p.Name.StartsWith("_")) { continue }
    if (-not (Test-BrixEdgeToken -Token $p.Name)) {
      throw "stations.json: '$($p.Name)' is not a valid screen id (letters, digits, . _ - ; must start with a letter or digit)"
    }
    if (-not ($p.Value -is [string]) -or [string]::IsNullOrWhiteSpace($p.Value)) {
      throw "stations.json: '$($p.Name)' must map to a path string"
    }
    try { $map[$p.Name] = Resolve-StationPath -Root $Root -Relative $p.Value }
    catch { throw "stations.json: '$($p.Name)' -> '$($p.Value)': $($_.Exception.Message)" }
  }
  return $map
}

<#
.SYNOPSIS
  Parse W3C (IIS) log lines into records, honouring the #Fields header.
.DESCRIPTION
  IIS writes the field list in a comment line, and it CHANGES when the log
  fields are reconfigured — including mid-file after an IIS restart. Reading
  positionally instead of by that header is the classic way a log parser
  silently reports the wrong column, so the header is re-read every time it
  appears.
#>
function ConvertFrom-W3CLog {
  param([Parameter(Mandatory)][string[]] $Lines)
  $fields = @()
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($line in $Lines) {
    if ($line.StartsWith("#Fields:")) { $fields = $line.Substring(8).Trim().Split(' ') | Where-Object { $_ }; continue }
    if ($line.StartsWith("#") -or $fields.Count -eq 0 -or [string]::IsNullOrWhiteSpace($line)) { continue }
    $v = $line.Split(' ')
    $rec = @{}
    for ($i = 0; $i -lt $fields.Count -and $i -lt $v.Count; $i++) { $rec[$fields[$i]] = $v[$i] }
    $out.Add([pscustomobject]$rec)
  }
  return $out
}

<#
.SYNOPSIS
  Which requests in a parsed log should raise an alarm.
.DESCRIPTION
  A CANARY token is one no screen was ever given: any request is an alarm,
  whoever made it and whatever the status. An UNKNOWN token is not a station at
  all: a typo in the map, or a probe. A request for a real station is normal
  traffic and is not returned.
#>
function Find-BrixEdgeAlarms {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]] $KnownTokens,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]] $CanaryTokens
  )
  $known = @{}; foreach ($k in $KnownTokens) { $known[$k] = $true }
  $canary = @{}; foreach ($c in $CanaryTokens) { $canary[$c] = $true }
  $hits = New-Object System.Collections.Generic.List[object]
  foreach ($r in $Records) {
    $uri = $r.'cs-uri-stem'
    # Classify on the FIRST segment, whatever follows it: IIS serves and logs
    # /drawings/<token>/released.pdf too, and a bare-folder-only pattern let a
    # prober append a file name to dodge both the canary and unknown-token alarm.
    if (-not $uri -or $uri -notmatch '^/drawings/([^/]+)(?:/.*)?$') { continue }
    $token = $Matches[1]
    $kind = if ($canary.ContainsKey($token)) { "CANARY" } elseif (-not $known.ContainsKey($token)) { "unknown-token" } else { $null }
    if (-not $kind) { continue }
    $hits.Add([pscustomobject]@{
        kind   = $kind
        when   = ("{0} {1}Z" -f $r.date, $r.time)
        client = $r.'c-ip'
        token  = $token
        status = $r.'sc-status'
        agent  = $r.'cs(User-Agent)'
      })
  }
  return $hits
}

<#
.SYNOPSIS
  One HTTP request, as a status code plus headers, with no exceptions for 4xx.
.DESCRIPTION
  Deliberately System.Net.Http.HttpClient rather than Invoke-WebRequest.
  Invoke-WebRequest THROWS on a 4xx, and what it throws differs between Windows
  PowerShell 5.1 (WebException/HttpWebResponse) and PowerShell 7
  (HttpResponseException/HttpResponseMessage) — and its handling of a 304 is
  version-dependent too. A verifier whose own error handling depends on the
  host's PowerShell version is not a verifier. HttpClient returns every status
  as data, on both.
#>
function Invoke-BrixEdgeProbe {
  param(
    [Parameter(Mandatory)][string] $Url,
    [ValidateSet("GET", "HEAD", "POST")][string] $Method = "HEAD",
    [hashtable] $Headers = @{},
    [int] $TimeoutSec = 10
  )
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false          # a 301 to the trailing slash is a FINDING, not a detail to hide
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
    foreach ($k in $Headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
    $res = $client.SendAsync($req).GetAwaiter().GetResult()
    try {
      $h = @{}
      foreach ($pair in $res.Headers) { $h[$pair.Key] = ($pair.Value -join ", ") }
      if ($res.Content) { foreach ($pair in $res.Content.Headers) { $h[$pair.Key] = ($pair.Value -join ", ") } }
      $len = if ($res.Content -and $res.Content.Headers.ContentLength) { [int64]$res.Content.Headers.ContentLength } else { 0 }
      return [pscustomobject]@{
        Status       = [int]$res.StatusCode
        Headers      = $h
        ETag         = $h["ETag"]
        LastModified = $h["Last-Modified"]
        ContentType  = $h["Content-Type"]
        Length       = $len
        Error        = $null
      }
    } finally { $res.Dispose() }
  } catch {
    return [pscustomobject]@{ Status = -1; Headers = @{}; ETag = $null; LastModified = $null; ContentType = $null; Length = 0; Error = $_.Exception.Message }
  } finally { $client.Dispose(); $handler.Dispose() }
}

<#
.SYNOPSIS
  Does this station serve its drawing, and does the screen's minute check work?
.DESCRIPTION
  The two questions that matter, in the order a screen asks them: fetch the
  drawing, then ask again with the ETag it was given. A server that answers 200
  the second time is not broken, but every screen re-downloads the whole drawing
  every minute — which on a hundred stations is the difference between a
  quiet LAN and a busy one. Reported as `no-304` rather than passed over.
#>
function Test-BrixEdgeStation {
  param(
    [Parameter(Mandatory)][string] $BaseUrl,
    [Parameter(Mandatory)][string] $Token
  )
  $url = "$($BaseUrl.TrimEnd('/'))/drawings/$Token/"
  $first = Invoke-BrixEdgeProbe -Url $url -Method HEAD
  $out = [ordered]@{ token = $Token; status = ""; note = ""; http = $first.Status; etag = $first.ETag; contentType = $first.ContentType; bytes = $first.Length; modified = $first.LastModified }
  switch ($first.Status) {
    200 {
      if (-not $first.ETag) { $out.status = "no-etag"; $out.note = "no ETag, so the screen cannot ask 'has it changed?' — it re-downloads every minute"; break }
      $again = Invoke-BrixEdgeProbe -Url $url -Method HEAD -Headers @{ "If-None-Match" = $first.ETag }
      if ($again.Status -eq 304) { $out.status = "ok" }
      else { $out.status = "no-304"; $out.note = "conditional request answered $($again.Status); the minute check will re-download every time" }
    }
    404 { $out.status = "nothing-released"; $out.note = "no released drawing at this station" }
    301 { $out.status = "redirect"; $out.note = "answered 301 to $($first.Headers['Location']) — save the address WITH the trailing slash" }
    302 { $out.status = "redirect"; $out.note = "answered 302 to $($first.Headers['Location'])" }
    -1  { $out.status = "unreachable"; $out.note = $first.Error }
    default { $out.status = "http-$($first.Status)" }
  }
  return [pscustomobject]$out
}

Export-ModuleMember -Function Test-BrixEdgeToken, ConvertTo-SubnetMask, ConvertFrom-Cidr, Resolve-StationPath, Read-BrixEdgeStationMap, ConvertFrom-W3CLog, Find-BrixEdgeAlarms, Invoke-BrixEdgeProbe, Test-BrixEdgeStation
