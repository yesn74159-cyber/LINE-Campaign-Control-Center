[CmdletBinding()]
param(
  [string]$WorkspaceRoot = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'
$script:Results = [System.Collections.Generic.List[object]]::new()
$script:SecretValues = [System.Collections.Generic.List[string]]::new()
$script:StartedProcesses = [System.Collections.Generic.List[int]]::new()
$script:LastStageResult = $null
$script:DatabaseUrl = $null
$script:AdminPassword = $null
$script:ViewerPassword = $null

function Write-Stage([string]$Message) {
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Redact([string]$Text) {
  if ($null -eq $Text) { return '' }
  $safe = $Text
  foreach ($secret in $script:SecretValues) {
    if (-not [string]::IsNullOrEmpty($secret)) { $safe = $safe.Replace($secret, '<redacted>') }
  }
  if (-not [string]::IsNullOrEmpty($script:DatabaseUrl)) { $safe = $safe.Replace($script:DatabaseUrl, '<redacted>') }
  return $safe -replace '(?i)(password|token|secret|authorization|cookie)=\S+', '$1=<redacted>'
}

function Read-HiddenValue([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plain)) { throw "$Prompt was empty" }
    return $plain
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
  }
}

function Set-ChildEnvironment([string]$Name, [string]$Value) {
  Set-Item -Path "Env:$Name" -Value $Value
}

function Invoke-TestStage([string]$Label, [string[]]$Arguments) {
  Write-Stage $Label
  $rawOutput = @(& npm.cmd @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $outputText = [string]::Join("`n", @($rawOutput | ForEach-Object { [string]$_ }))
  foreach ($line in ($outputText -split "`r?`n")) {
    if ($line.Length -gt 0) { Write-Host (Redact $line) }
  }

  $tests = 0
  $passed = 0
  $failed = 0
  $skipped = 0
  $match = [regex]::Match($outputText, '(?m)^ℹ tests (\d+)$')
  if ($match.Success) { $tests = [int]$match.Groups[1].Value }
  $match = [regex]::Match($outputText, '(?m)^ℹ pass (\d+)$')
  if ($match.Success) { $passed = [int]$match.Groups[1].Value }
  $match = [regex]::Match($outputText, '(?m)^ℹ fail (\d+)$')
  if ($match.Success) { $failed = [int]$match.Groups[1].Value }
  $match = [regex]::Match($outputText, '(?m)^ℹ skipped (\d+)$')
  if ($match.Success) { $skipped = [int]$match.Groups[1].Value }

  $status = if ($exitCode -ne 0) { 'FAIL' } elseif ($skipped -gt 0) { 'SKIP' } else { 'PASS' }
  $result = [pscustomobject]@{
    Stage = $Label
    Status = $status
    Tests = $tests
    Passed = $passed
    Failed = $failed
    Skipped = $skipped
    ExitCode = $exitCode
    Output = Redact $outputText
  }
  $script:Results.Add($result)
  $script:LastStageResult = $result
  Write-Host ("RESULT {0}: status={1}; tests={2}; pass={3}; fail={4}; skip={5}; exit={6}" -f $Label, $status, $tests, $passed, $failed, $skipped, $exitCode) -ForegroundColor $(if ($status -eq 'PASS') { 'Green' } elseif ($status -eq 'SKIP') { 'Yellow' } else { 'Red' })
  return $result
}

function Test-HttpEndpoint([string]$Uri, [string]$ExpectedText) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
    return ($response.StatusCode -eq 200 -and ($response.Content -match $ExpectedText))
  } catch {
    return $false
  }
}

function Wait-HttpEndpoint([string]$Uri, [string]$ExpectedText, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-HttpEndpoint $Uri $ExpectedText) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-StartedProcesses {
  foreach ($processId in $script:StartedProcesses) {
    try {
      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($process) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    } catch { }
  }
  $script:StartedProcesses.Clear()
}

$trackedEnvironment = @(
  'DATABASE_URL', 'PERSISTENCE', 'APP_MODE', 'LINE_LIVE_ENABLED', 'LINE_WEBHOOK_ENABLED',
  'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD', 'STAGING_VIEWER_EMAIL', 'STAGING_VIEWER_PASSWORD',
  'E2E_BASE_URL', 'NODE_OPTIONS'
)
$previousEnvironment = @{}
foreach ($name in $trackedEnvironment) {
  $existing = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  if ($null -eq $existing) { $previousEnvironment[$name] = $null }
  else { $previousEnvironment[$name] = $existing.Value }
}

$exitCode = 0
$stopReason = $null

try {
  Set-Location $WorkspaceRoot
  Write-Stage 'Docker, existing PostgreSQL container and volume'
  $context = ([string](& docker context show 2>&1)).Trim()
  if ($LASTEXITCODE -ne 0 -or $context -ne 'desktop-linux') { throw "Docker context must be desktop-linux; observed '$context'" }
  & docker info --format 'Docker Engine={{.ServerVersion}}' | ForEach-Object { Write-Host (Redact ([string]$_)) }
  if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not reachable' }

  $containerJson = [string](& docker inspect line-ccc-postgres-staging 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'line-ccc-postgres-staging was not inspectable' }
  $container = @($containerJson | ConvertFrom-Json)[0]
  if ($container.State.Status -ne 'running') { throw "line-ccc-postgres-staging is not running (status=$($container.State.Status))" }
  $mount = @($container.Mounts | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })[0]
  $expectedVolume = 'line_flex_templates_collection_v4_line-ccc-postgres-staging'
  if (-not $mount -or $mount.Name -ne $expectedVolume) { throw "existing PostgreSQL volume mismatch; expected $expectedVolume" }
  $port = @($container.HostConfig.PortBindings.'5432/tcp')[0]
  if (-not $port -or $port.HostIp -ne '127.0.0.1' -or $port.HostPort -ne '55433') { throw 'PostgreSQL is not bound to 127.0.0.1:55433' }
  $volumeJson = [string](& docker volume inspect $expectedVolume 2>&1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($volumeJson)) { throw 'existing PostgreSQL volume could not be inspected' }
  Write-Host "Container=running; Volume=$expectedVolume; Port=127.0.0.1:55433"

  Write-Stage 'Environment and hidden credentials'
  $script:DatabaseUrl = $env:DATABASE_URL
  if ([string]::IsNullOrWhiteSpace($script:DatabaseUrl)) { $script:DatabaseUrl = Read-HiddenValue 'DATABASE_URL (hidden)' }
  $script:AdminPassword = $env:STAGING_ADMIN_PASSWORD
  if ([string]::IsNullOrWhiteSpace($script:AdminPassword)) { $script:AdminPassword = Read-HiddenValue 'Staging Admin password (hidden)' }
  $script:ViewerPassword = $env:STAGING_VIEWER_PASSWORD
  if ([string]::IsNullOrWhiteSpace($script:ViewerPassword)) { $script:ViewerPassword = Read-HiddenValue 'Staging Viewer password (hidden)' }
  $script:SecretValues.Add($script:DatabaseUrl)
  $script:SecretValues.Add($script:AdminPassword)
  $script:SecretValues.Add($script:ViewerPassword)
  $databaseUri = [Uri]$script:DatabaseUrl
  if ($databaseUri.Host -ne '127.0.0.1' -or $databaseUri.Port -ne 55433) { throw 'DATABASE_URL must target 127.0.0.1:55433' }
  Write-Host 'DATABASE_URL=SET; STAGING_ADMIN_PASSWORD=SET; STAGING_VIEWER_PASSWORD=SET'

  Set-ChildEnvironment 'DATABASE_URL' $script:DatabaseUrl
  Set-ChildEnvironment 'PERSISTENCE' 'postgres'
  Set-ChildEnvironment 'APP_MODE' 'DRY_RUN'
  Set-ChildEnvironment 'LINE_LIVE_ENABLED' 'false'
  Set-ChildEnvironment 'LINE_WEBHOOK_ENABLED' 'false'
  Set-ChildEnvironment 'STAGING_ADMIN_PASSWORD' $script:AdminPassword
  Set-ChildEnvironment 'STAGING_VIEWER_PASSWORD' $script:ViewerPassword
  if (-not (Get-Item Env:STAGING_ADMIN_EMAIL -ErrorAction SilentlyContinue)) { Set-ChildEnvironment 'STAGING_ADMIN_EMAIL' 'admin@staging.local' }
  if (-not (Get-Item Env:STAGING_VIEWER_EMAIL -ErrorAction SilentlyContinue)) { Set-ChildEnvironment 'STAGING_VIEWER_EMAIL' 'viewer@staging.local' }
  Set-ChildEnvironment 'E2E_BASE_URL' 'http://127.0.0.1:5173'
  Set-ChildEnvironment 'NODE_OPTIONS' '--max-old-space-size=2048'

  Write-Stage 'Backup and migration ledger before integration tests'
  $backup = Get-ChildItem (Join-Path $WorkspaceRoot 'staging-backups') -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 -and $_.Extension -in '.dump', '.backup', '.sql' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $backup) { throw 'No non-empty staging backup was found; refusing integration tests' }
  $backupHash = Get-FileHash -LiteralPath $backup.FullName -Algorithm SHA256
  Write-Host "Backup=$($backup.Name); Size=$($backup.Length) bytes; SHA256 checked"
  $schemaOutput = [string](& docker exec line-ccc-postgres-staging psql -U line_ccc -d line_campaign_ccc -Atc "select version from schema_migrations order by version; select count(*) from outbox_deliveries;" 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL schema inspection failed' }
  if ($schemaOutput -notmatch '(?m)^007_phase4b_outbox_association_guard\.sql$') { throw 'Migration 007 is not recorded in schema_migrations' }
  $countMatch = [regex]::Match($schemaOutput, '(?m)^(\d+)$\s*$')
  if (-not $countMatch.Success) { throw 'Could not read the pre-test outbox count' }
  $preTestOutboxCount = [int]$countMatch.Groups[1].Value
  Write-Host "Migration 007=recorded; OutboxBefore=$preTestOutboxCount"

  $localStages = @(
    @{ Label = 'Core Tests'; Args = @('test') },
    @{ Label = 'Security Tests'; Args = @('run', 'test:security') },
    @{ Label = 'OA Mock Transport Tests'; Args = @('run', 'test:oa') }
  )
  foreach ($stage in $localStages) {
    $result = Invoke-TestStage $stage.Label $stage.Args
    if ($result.ExitCode -ne 0 -or $result.Skipped -gt 0) { throw "$($stage.Label) did not pass without skips; exit code $($result.ExitCode)" }
  }

  $integrationStages = @(
    @{ Label = 'Phase 2 PostgreSQL Integration'; Args = @('run', 'test:integration') },
    @{ Label = 'Phase 3 PostgreSQL Integration'; Args = @('run', 'test:phase3') },
    @{ Label = 'Phase 4A PostgreSQL Integration'; Args = @('run', 'test:phase4a') },
    @{ Label = 'Phase 4B PostgreSQL Integration'; Args = @('run', 'test:phase4b') }
  )
  foreach ($stage in $integrationStages) {
    $result = Invoke-TestStage $stage.Label $stage.Args
    if ($result.ExitCode -ne 0 -or $result.Skipped -gt 0) {
      if ($stage.Label -like 'Phase 2*' -and ($result.Output -match '401|invalid credentials|required')) {
        throw 'Phase 2 authentication failed; supplied staging credentials may be incorrect. No password or hash was changed.'
      }
      throw "$($stage.Label) did not pass without skips; exit code $($result.ExitCode)"
    }
  }

  Write-Stage 'E2E service readiness'
  $apiReady = Test-HttpEndpoint 'http://127.0.0.1:8787/health' '"persistence"\s*:\s*"postgres"'
  $adminReady = Test-HttpEndpoint 'http://127.0.0.1:5173/' 'LINE Campaign Control Center'
  if (-not $apiReady) {
    $apiProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev:staging') -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden -PassThru
    $script:StartedProcesses.Add($apiProcess.Id)
    if (-not (Wait-HttpEndpoint 'http://127.0.0.1:8787/health' '"persistence"\s*:\s*"postgres"' 45)) { throw 'Staging API did not become ready on 127.0.0.1:8787' }
  }
  if (-not $adminReady) {
    $adminProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev:admin') -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden -PassThru
    $script:StartedProcesses.Add($adminProcess.Id)
    if (-not (Wait-HttpEndpoint 'http://127.0.0.1:5173/' 'LINE Campaign Control Center' 45)) { throw 'Admin did not become ready on 127.0.0.1:5173' }
  }

  $e2e = Invoke-TestStage 'E2E PC 1280x720 + Mobile 390x844 (sequential)' @('run', 'test:e2e')
  if ($e2e.ExitCode -ne 0 -or $e2e.Skipped -gt 0) { throw 'E2E did not pass without skips' }

  $finalStages = @(
    @{ Label = 'Final Typecheck'; Args = @('run', 'typecheck') },
    @{ Label = 'Final Production Build'; Args = @('run', 'build') }
  )
  foreach ($stage in $finalStages) {
    $result = Invoke-TestStage $stage.Label $stage.Args
    if ($result.ExitCode -ne 0) { throw "$($stage.Label) failed with exit code $($result.ExitCode)" }
  }

  $postCountOutput = [string](& docker exec line-ccc-postgres-staging psql -U line_ccc -d line_campaign_ccc -Atc "select count(*) from outbox_deliveries;" 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'Post-test Outbox count could not be read' }
  $postTestOutboxCount = [int]$postCountOutput.Trim()
  Write-Host "OutboxAfter=$postTestOutboxCount; no reset or reseed performed"
  Write-Host 'FINAL RESULT: PASS' -ForegroundColor Green
} catch {
  if ($null -ne $script:LastStageResult -and $script:LastStageResult.ExitCode -ne 0) { $exitCode = [int]$script:LastStageResult.ExitCode }
  else { $exitCode = 2 }
  $stopReason = Redact $_.Exception.Message
  Write-Host "FINAL RESULT: BLOCKED/FAIL — $stopReason" -ForegroundColor Red
} finally {
  Stop-StartedProcesses
  foreach ($name in $trackedEnvironment) {
    $oldValue = $previousEnvironment[$name]
    if ($null -eq $oldValue) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item -Path "Env:$name" -Value $oldValue }
  }
  $script:DatabaseUrl = $null
  $script:AdminPassword = $null
  $script:ViewerPassword = $null
  $script:SecretValues.Clear()
}

Write-Host "`n=== Verification Summary ===" -ForegroundColor Cyan
$script:Results | Select-Object Stage, Status, Tests, Passed, Failed, Skipped, ExitCode | Format-Table -AutoSize
if ($exitCode -ne 0) { exit $exitCode }
exit 0
