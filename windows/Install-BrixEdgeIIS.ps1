<#
.SYNOPSIS
  brix-edge on IIS: serve each screen's released drawing from a folder you
  control, with nothing from Brix running on your server.

.DESCRIPTION
  Creates (or reconciles) an IIS website that serves
      http://<this server>:<Port>/drawings/<screen id>/
  for every screen id in your stations JSON, as an IIS virtual directory that
  points at that station's folder under -Root. IIS's own default-document,
  ETag/Last-Modified/304, request filtering, IP restrictions and W3C logging do
  the rest — see web.config next to this script for the whole configuration.

  Idempotent: run it again after you change stations.json. Virtual directories
  that are no longer in the file are removed; new ones are added.

.PARAMETER Root
  The folder that holds the drawings, e.g. D:\Drawings. Station paths in the
  JSON are relative to it. A path that escapes it is refused.

.PARAMETER Stations
  JSON file: { "<screen id>": "<folder or released.pdf under Root>" }.
  Keys starting with "_" are comments. See ..\stations.example.json.

.PARAMETER AllowFrom
  CIDR ranges the screens live in, e.g. "10.50.0.0/16","10.51.8.0/24".
  Everything else is refused at the IIS level (IP and Domain Restrictions)
  and at the Windows Firewall. Omit to allow any address.

.PARAMETER InstallIIS
  Also install the IIS role and the five features this needs.

.EXAMPLE
  .\Install-BrixEdgeIIS.ps1 -Root D:\Drawings -Stations D:\Drawings\stations.json -AllowFrom "10.50.0.0/16" -InstallIIS

.NOTES
  Run in an ELEVATED **Windows PowerShell 5.1** (`powershell.exe`) on the IIS
  host, not `pwsh` 7: WebAdministration and its IIS: drive are Windows-only and
  behave badly under PowerShell 7's compatibility shim.

  The pure logic (the station map, the CIDR maths, the containment rule) lives
  in BrixEdge.Common.psm1 and is unit-tested by Test-BrixEdge.Common.ps1, which
  runs on any machine. Everything below that touches IIS needs this host.
#>
#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)] [string] $Root,
  [Parameter(Mandatory)] [string] $Stations,
  [string]   $SiteName = "BrixEdge",
  [int]      $Port = 8787,
  [string[]] $AllowFrom = @(),
  [switch]   $InstallIIS
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "BrixEdge.Common.psm1") -Force

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ── 0. IIS role ────────────────────────────────────────────────────────────
if ($InstallIIS) {
  Write-Step "Installing the IIS role and the features brix-edge needs"
  Install-WindowsFeature -Name Web-Server, Web-Static-Content, Web-Default-Doc, Web-Http-Logging, Web-Filtering, Web-IP-Security, Web-Mgmt-Console | Out-Null
}
Import-Module WebAdministration

# ── 1. Inputs ──────────────────────────────────────────────────────────────
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Root is not a folder: $Root" }
# Validated + containment-checked in the module, so one bad entry stops the run
# rather than half-applying a station map the operator believes succeeded.
$map = Read-BrixEdgeStationMap -Root $Root -StationsFile $Stations
Write-Step "$($map.Count) station(s) in $Stations"
# Parse every range BEFORE touching IIS: a typo must fail the run, not leave the
# site half-restricted.
$allow = @($AllowFrom | ForEach-Object { ConvertFrom-Cidr $_ })

# ── 2. The site root: an EMPTY folder holding only web.config ─────────────
# The site's own root exposes nothing. Every drawing is reached through a
# virtual directory under /drawings/, never through the root.
$SiteRoot = Join-Path $Root "_brix-edge-site"
$null = New-Item -ItemType Directory -Force -Path $SiteRoot, (Join-Path $SiteRoot "drawings")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "web.config") -Destination (Join-Path $SiteRoot "web.config") -Force
if (-not (Test-Path (Join-Path $SiteRoot "empty.txt"))) { New-Item -ItemType File -Path (Join-Path $SiteRoot "empty.txt") | Out-Null }

# ── 3. The website ────────────────────────────────────────────────────────
if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) {
  Write-Step "Creating website $SiteName on port $Port"
  New-Website -Name $SiteName -Port $Port -PhysicalPath $SiteRoot -Force | Out-Null
} else {
  Write-Step "Website $SiteName exists; reconciling"
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $SiteRoot
}
# W3C log with the fields that make the log the record: who, what, when, how much.
Set-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.logFormat -Value "W3C"
Set-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.period -Value "Daily"
Set-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.logExtFileFlags -Value "Date,Time,ClientIP,Method,UriStem,HttpStatus,HttpSubStatus,BytesSent,TimeTaken,UserAgent"
$logDir = (Get-ItemProperty "IIS:\Sites\$SiteName" -Name logFile.directory).Value
$siteId = (Get-Website -Name $SiteName).id

# ── 4. Virtual directories: one per screen id, under /drawings/ ───────────
$existing = @{}
Get-WebVirtualDirectory -Site $SiteName -ErrorAction SilentlyContinue | ForEach-Object {
  # Paths come back like "/drawings/scr_xxx"
  if ($_.path -match '^/drawings/([^/]+)$') { $existing[$Matches[1]] = $_.physicalPath }
}
foreach ($token in $map.Keys) {
  $target = $map[$token]
  $isFile = $target.ToLower().EndsWith(".pdf")
  $physical = if ($isFile) { Split-Path $target -Parent } else { $target }
  if (-not (Test-Path -LiteralPath $physical -PathType Container)) {
    Write-Warning "$token -> $physical does not exist yet (nothing released). The virtual directory is created anyway; it serves once the folder appears."
    $null = New-Item -ItemType Directory -Force -Path $physical
  }
  if ($existing.ContainsKey($token)) {
    if ($existing[$token] -ne $physical) {
      if ($PSCmdlet.ShouldProcess("$token", "repoint to $physical")) {
        Set-ItemProperty "IIS:\Sites\$SiteName\drawings\$token" -Name physicalPath -Value $physical
      }
    }
  } elseif ($PSCmdlet.ShouldProcess("$token", "map to $physical")) {
    New-WebVirtualDirectory -Site $SiteName -Name "drawings/$token" -PhysicalPath $physical | Out-Null
  }
  # A station mapped to a FILE serves that file as its default document; a
  # folder serves released.pdf (the site-wide default). Set per virtual
  # directory in applicationHost so nothing is written into your drawings tree.
  $loc = "$SiteName/drawings/$token"
  Clear-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $loc -Filter "system.webServer/defaultDocument/files" -ErrorAction SilentlyContinue
  if ($isFile) {
    Add-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $loc -Filter "system.webServer/defaultDocument/files" -Name "." -Value @{ value = (Split-Path $target -Leaf) }
  }
}
# Remove stations that left the file.
foreach ($stale in @($existing.Keys | Where-Object { -not $map.Contains($_) })) {
  if ($PSCmdlet.ShouldProcess("$stale", "remove (no longer in stations.json)")) {
    Remove-WebVirtualDirectory -Site $SiteName -Application "/" -Name "drawings/$stale" -Confirm:$false
    Clear-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location "$SiteName/drawings/$stale" -Filter "system.webServer/defaultDocument/files" -ErrorAction SilentlyContinue
  }
}

# ── 5. Who may ask: the screens' subnets and nobody else ──────────────────
$ipFilter = "system.webServer/security/ipSecurity"
Clear-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter $ipFilter -ErrorAction SilentlyContinue
if ($AllowFrom.Count -gt 0) {
  Write-Step "Restricting the site to: $($AllowFrom -join ', ')"
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter $ipFilter -Name allowUnlisted -Value $false
  foreach ($r in $allow) {
    Add-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter $ipFilter -Name "." -Value @{ ipAddress = $r.Address; subnetMask = $r.SubnetMask; allowed = $true }
  }
}
# Windows Firewall: the same rule at the host boundary.
$fwName = "brix-edge $Port"
if (-not (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue)) {
  $fw = @{ DisplayName = $fwName; Direction = "Inbound"; Protocol = "TCP"; LocalPort = $Port; Action = "Allow"; Profile = "Domain,Private" }
  if ($AllowFrom.Count -gt 0) { $fw.RemoteAddress = $AllowFrom }
  New-NetFirewallRule @fw | Out-Null
}

Start-Website -Name $SiteName -ErrorAction SilentlyContinue

# ── 6. Say what was done, and the one line the operator types into Brix ───
$hostIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "brix-edge on IIS is configured." -ForegroundColor Green
Write-Host "  Site:        $SiteName (id $siteId), port $Port, root $SiteRoot"
Write-Host "  Stations:    $($map.Count) virtual directories under /drawings/"
Write-Host "  IIS log:     $logDir\W3SVC$siteId\   (your record of every read)"
Write-Host "  Allowed from: $(if ($AllowFrom) { $AllowFrom -join ', ' } else { 'any address (pass -AllowFrom to restrict)' })"
Write-Host ""
Write-Host "Address to save in Brix for the drawing (one link serves every station):" -ForegroundColor Yellow
Write-Host "  http://$hostIp`:$Port/drawings/{{screen.id}}/"
Write-Host "  Use the IP address or a name ending .internal or .local: the screen refuses other names."
Write-Host "  Keep the trailing slash: it is the folder whose default document is released.pdf."
Write-Host ""
Write-Host "Now run .\Test-BrixEdge.ps1 -Stations `"$Stations`" -Port $Port to prove it."
