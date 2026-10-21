[CmdletBinding()]
param(
  [string]$SessionPoolerConnectionString,
  [string]$SslCaFile
)

$ErrorActionPreference = 'Stop'
$projectRef = 'bgwsxoeseyqwwcupzeoo'
$environmentNames = @(
  'DB_TARGET', 'DB_SCHEMA', 'DB_EXTENSION_SCHEMA', 'DB_SSL_MODE',
  'DB_SSL_REJECT_UNAUTHORIZED', 'DB_SSL_CA_FILE', 'DB_POOL_MODE', 'PERSISTENCE', 'APP_MODE',
  'LINE_LIVE_ENABLED', 'LINE_WEBHOOK_ENABLED', 'CLOUD_STAGING_DATABASE_URL', 'SUPABASE_POOLER_HOST'
)
$connectionString = $null
$databasePassword = $null
$passwordBstr = [IntPtr]::Zero

function Get-ConnectionTemplate {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    $Value = Read-Host 'Paste the Supabase Session Pooler connection string with its password placeholder'
  }

  $Value.Trim()
}

function New-ConnectionString {
  param([string]$Template, [string]$Password)

  $match = [regex]::Match(
    $Template,
    '^postgres(?:ql)?://(?<user>[^:/@]+)(?::(?<templatePassword>[^@]*))?@(?<host>[^:/?]+):(?<port>[0-9]+)/(?<database>[^?]+)(?:\?(?<query>.*))?$',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $match.Success) {
    throw 'The Session Pooler connection string format is invalid.'
  }

  $poolerHost = $match.Groups['host'].Value
  $port = [int]$match.Groups['port'].Value
  $user = $match.Groups['user'].Value
  $database = $match.Groups['database'].Value
  $templatePassword = $match.Groups['templatePassword'].Value

  if ($poolerHost -notmatch '(?i)\.pooler\.supabase\.com$') {
    throw 'The connection string must use the Supabase Session Pooler host.'
  }
  if ($port -ne 5432) {
    throw 'The connection string must use Session Pooler port 5432, not transaction pooler port 6543.'
  }
  if ($user -ne "postgres.$projectRef") {
    throw 'The connection string user does not match the requested Supabase project.'
  }
  if ($database -ne 'postgres') {
    throw 'The connection string database must be postgres.'
  }
  if ($templatePassword -and $templatePassword -notmatch '(?i)^(\[YOUR-PASSWORD\]|<password>|YOUR_PASSWORD|\{password\})$') {
    throw 'Do not pass a connection string containing a real password. Use the dashboard placeholder only.'
  }

  $escapedUser = [Uri]::EscapeDataString($user)
  $escapedPassword = [Uri]::EscapeDataString($Password)
  # Rebuild without SSL query parameters so node-postgres uses the Pool SSL object below.
  "postgresql://$escapedUser`:$escapedPassword@$poolerHost`:$port/$database"
}

function Get-SessionPoolerHost {
  param([string]$Template)

  $match = [regex]::Match(
    $Template,
    '^postgres(?:ql)?://(?<user>[^:/@]+)(?::(?<templatePassword>[^@]*))?@(?<host>[^:/?]+):(?<port>[0-9]+)/(?<database>[^?]+)(?:\?(?<query>.*))?$',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $match.Success) { throw 'The Session Pooler connection string format is invalid.' }
  $poolerHost = $match.Groups['host'].Value
  if ($poolerHost -notmatch '(?i)^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$') {
    throw 'The connection string must use the Supabase AWS Session Pooler host.'
  }
  $poolerHost
}

function Invoke-ConnectionCheck {
  param([string]$NpmScript)

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $env:ComSpec
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  [void]$startInfo.ArgumentList.Add('/d')
  [void]$startInfo.ArgumentList.Add('/s')
  [void]$startInfo.ArgumentList.Add('/c')
  [void]$startInfo.ArgumentList.Add("npm.cmd run $NpmScript --silent")

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'The connection checker process could not start.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [pscustomobject]@{
      ExitCode = $process.ExitCode
      Stdout = $stdoutTask.GetAwaiter().GetResult()
      Stderr = $stderrTask.GetAwaiter().GetResult()
    }
  } finally {
    $process.Dispose()
  }
}

function ConvertFrom-CheckerJson {
  param([string]$Stdout, [string]$ExpectedChecker)

  foreach ($line in ($Stdout -split "`r?`n")) {
    $candidate = $line.Trim()
    if ($candidate -notmatch '^\{.*\}$') { continue }
    try {
      $parsed = $candidate | ConvertFrom-Json
      if ($parsed.schemaVersion -eq 1 -and $parsed.checker -eq $ExpectedChecker) {
        return $parsed
      }
    } catch {
      continue
    }
  }
  return $null
}

function New-CheckerFailureResult {
  param([string]$Message, [string]$Checker = 'supabase-readonly-connection')

  [pscustomobject]@{
    schemaVersion = 1
    checker = $Checker
    ok = $false
    configured = $false
    connected = $false
    readOnlySelect = $false
    target = 'CLOUD_STAGING'
    expectedSchema = 'line_ccc'
    currentSchema = $null
    searchPath = $null
    ssl = $null
    uuidFunction = $false
    poolMode = 'session'
    errorType = 'Query'
    errorCode = $null
    sslCategory = $null
    certificateReason = $null
    message = $Message
  }
}

function Resolve-CheckerResult {
  param(
    [int]$ExitCode,
    [string]$Stdout,
    [string]$Stderr,
    [string]$ExpectedChecker
  )

  if ($ExitCode -notin @(0, 1)) {
    return New-CheckerFailureResult 'Connection checker process failed before producing a valid result.' $ExpectedChecker
  }
  $parsed = ConvertFrom-CheckerJson $Stdout $ExpectedChecker
  if ($null -eq $parsed) {
    return New-CheckerFailureResult 'Connection checker returned no valid JSON result.' $ExpectedChecker
  }
  return $parsed
}

try {
  $template = Get-ConnectionTemplate $SessionPoolerConnectionString
  $poolerHost = Get-SessionPoolerHost $template
  if ($SslCaFile) {
    $resolvedCaFile = (Resolve-Path -LiteralPath $SslCaFile -ErrorAction Stop).Path
    $env:DB_SSL_CA_FILE = $resolvedCaFile
  }
  $env:SUPABASE_POOLER_HOST = $poolerHost

  $certificateProcess = Invoke-ConnectionCheck -NpmScript 'test:ssl-certificate'
  $certificateExitCode = [int]$certificateProcess.ExitCode
  $certificateResult = Resolve-CheckerResult -ExitCode $certificateExitCode -Stdout $certificateProcess.Stdout -Stderr $certificateProcess.Stderr -ExpectedChecker 'supabase-ssl-certificate'
  $certificateResult | ConvertTo-Json -Compress
  if ($certificateExitCode -ne 0 -or -not $certificateResult.ok) {
    throw "FAIL: $($certificateResult.sslCategory) - $($certificateResult.message)"
  }

  $databasePasswordSecure = Read-Host 'กรอกรหัส Database Password ของ Supabase ได้เลยครับ' -AsSecureString
  $passwordBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($databasePasswordSecure)
  $databasePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordBstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr)
  $passwordBstr = [IntPtr]::Zero

  $connectionString = New-ConnectionString $template $databasePassword
  $env:DB_TARGET = 'CLOUD_STAGING'
  $env:DB_SCHEMA = 'line_ccc'
  $env:DB_EXTENSION_SCHEMA = 'extensions'
  $env:DB_SSL_MODE = 'verify-full'
  $env:DB_SSL_REJECT_UNAUTHORIZED = 'true'
  $env:DB_POOL_MODE = 'session'
  $env:PERSISTENCE = 'postgres'
  $env:APP_MODE = 'DRY_RUN'
  $env:LINE_LIVE_ENABLED = 'false'
  $env:LINE_WEBHOOK_ENABLED = 'false'
  $env:CLOUD_STAGING_DATABASE_URL = $connectionString

  $checkerProcess = Invoke-ConnectionCheck -NpmScript 'test:db-connection'
  $checkerExitCode = [int]$checkerProcess.ExitCode
  $connectionResult = Resolve-CheckerResult -ExitCode $checkerExitCode -Stdout $checkerProcess.Stdout -Stderr $checkerProcess.Stderr -ExpectedChecker 'supabase-readonly-connection'
  $connectionResult | ConvertTo-Json -Compress
  if ($checkerExitCode -ne 0 -or -not $connectionResult.ok) {
    throw "FAIL: $($connectionResult.errorType) - $($connectionResult.message)"
  }

  Write-Host 'Connection test: PASS'
  npm run test
  if ($LASTEXITCODE -ne 0) {
    throw 'FAIL: npm run test failed.'
  }
  Write-Host 'npm run test: PASS'
} catch {
  Write-Error ('Connection test: FAIL - ' + $_.Exception.Message)
  exit 1
} finally {
  if ($passwordBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr)
  }
  $databasePassword = $null
  $databasePasswordSecure = $null
  $connectionString = $null
  foreach ($name in $environmentNames) {
    Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
