param([string]$MetaEditor = 'C:\Program Files\MetaTrader 5\MetaEditor64.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'ea\ROCKET1000_EA.mq5'
$binary = Join-Path $projectRoot 'ea\ROCKET1000_EA.ex5'
$manifest = Join-Path $projectRoot 'ea\build-manifest.json'
$log = Join-Path $projectRoot 'work\ea-build.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
if (!(Test-Path -LiteralPath $MetaEditor)) { throw 'MetaEditor is required to produce the real MT5 binary.' }
# Verify that a new binary was produced, rather than accepting a stale artifact.
$started = [DateTime]::UtcNow
$process = Start-Process -FilePath $MetaEditor -ArgumentList @("/compile:`"$source`"", "/log:`"$log`"") -PassThru -WindowStyle Hidden
if (!$process.WaitForExit(60000)) { throw 'MetaEditor compilation timed out; inspect work/ea-build.log.' }
if (!(Test-Path -LiteralPath $log)) { throw 'MetaEditor did not write a build log.' }
$result = Get-Content -LiteralPath $log -Raw
if ($result -notmatch '0 errors, 0 warnings' -or !(Test-Path -LiteralPath $binary)) { throw "Compilation failed: $result" }
if ((Get-Item -LiteralPath $binary).LastWriteTimeUtc -lt $started.AddSeconds(-2)) { throw 'No fresh binary was produced.' }
$manifestJson = [ordered]@{
  name = 'ROCKET1000 EA'; version = ([regex]::Match((Get-Content -LiteralPath $source -Raw),'#property version\s+"([^"]+)"')).Groups[1].Value; errors = 0; warnings = 0;
  builtAt = [DateTime]::UtcNow.ToString('o');
  sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLower();
  binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLower()
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $manifestJson.Replace([string][char]13 + [char]10, [string][char]10) + [char]10, [Text.UTF8Encoding]::new($false))
Write-Output $result
