# Pull the newest nightly staging dump off the VM, verify its sha256 here, and keep a
# bounded set of copies. This is the off-host half of the backup story: deploy/nightly-
# backup.sh protects against a bad deploy or a dropped table, this protects against a
# lost VM.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\offsite-backup.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so a
# single non-ASCII character breaks every string after it.
#
# The dump contains the real customer tables, so the destination directory is inside the
# same secrets folder as the key pair - never a synced or shared folder.
[CmdletBinding()]
param(
  [string]$Target = 'ubuntu@13.212.244.219',
  [string]$KeyPair = "$env:USERPROFILE\.line-ccc-secrets\lightsail-staging.pem",
  [string]$RemoteDir = '/srv/line-ccc-staging/backups',
  [string]$Dest = "$env:USERPROFILE\.line-ccc-secrets\backups",
  [int]$Keep = 7
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $KeyPair)) { throw "key pair not found: $KeyPair" }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Invoke-Remote {
  param([string]$Command)
  ssh -i $KeyPair -o BatchMode=yes -o ConnectTimeout=15 $Target $Command
}

function Test-Dump {
  param([string]$DumpPath, [string]$SidecarPath)
  if (-not (Test-Path -LiteralPath $SidecarPath)) { return $false }
  $expected = (Get-Content -LiteralPath $SidecarPath -Raw).Trim().Split(' ')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $DumpPath).Hash.ToLowerInvariant()
  return ($expected.Length -eq 64) -and ($expected -eq $actual)
}

# verify-backup.sh cannot see this machine, so the host carries a marker proving an
# off-VM copy exists. It must name the newest dump: a marker left over from last week
# says nothing about tonight's file.
function Set-OffsiteMarker {
  param([string]$Name)
  $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  Invoke-Remote "printf '%s %s\n' '$stamp' '$Name' > $RemoteDir/.offsite-verified"
  if ($LASTEXITCODE -ne 0) { throw "could not write $RemoteDir/.offsite-verified - verify-backup.sh will keep alerting" }
  Write-Output "off-host marker recorded on ${Target}: $stamp $Name"
}

$listing = Invoke-Remote "ls -1t $RemoteDir/nightly-*.dump 2>/dev/null | head -1"
$remotePath = (@($listing) | Where-Object { $_ -match 'nightly-.*\.dump$' } | Select-Object -First 1)
if (-not $remotePath) {
  throw "no nightly-*.dump found in $RemoteDir on $Target - did the cron job run? check $RemoteDir/backup.log"
}
$name = $remotePath.Substring($remotePath.LastIndexOf('/') + 1)
$local = Join-Path $Dest $name
$sidecar = "$local.sha256"

if (Test-Path -LiteralPath $local) {
  if (Test-Dump $local $sidecar) {
    Write-Output "already held locally and verified: $local"
    Set-OffsiteMarker $name
    exit 0
  }
  Write-Output "local copy of $name does not verify - re-downloading"
}

scp -i $KeyPair -o BatchMode=yes "${Target}:${remotePath}" $Dest
scp -i $KeyPair -o BatchMode=yes "${Target}:${remotePath}.sha256" $Dest

if (-not (Test-Dump $local $sidecar)) { throw "checksum mismatch for $name - the downloaded dump is NOT usable" }
Write-Output "verified: $((Get-Item -LiteralPath $local).Length) bytes, sha256 matches the host sidecar"
Set-OffsiteMarker $name

# Rotation matches only nightly-* pairs; manual dumps already in this folder are kept.
$held = @(Get-ChildItem -LiteralPath $Dest -Filter 'nightly-*.dump' | Sort-Object Name -Descending)
if ($held.Count -gt $Keep) {
  $held | Select-Object -Skip $Keep | ForEach-Object {
    $pair = "$($_.FullName).sha256"
    Remove-Item -LiteralPath $_.FullName -Force
    if (Test-Path -LiteralPath $pair) { Remove-Item -LiteralPath $pair -Force }
    Write-Output "pruned old local copy: $($_.Name)"
  }
}

Write-Output ''
Write-Output "last lines of $RemoteDir/backup.log on the host:"
Invoke-Remote "tail -5 $RemoteDir/backup.log"
