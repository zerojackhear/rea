param([Parameter(Mandatory=$true)][string]$Apk,[Parameter(Mandatory=$true)][string]$DesktopPath,[Parameter(Mandatory=$true)][string]$JadxJar,[Parameter(Mandatory=$true)][string]$WabtRoot,[Parameter(Mandatory=$true)][string]$ToolLicenses,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputDirectory){throw '交付目录必须是新目录'}
if((Get-FileHash -LiteralPath $JadxJar -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75'){throw 'JADX 校验失败'}
$repoRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$service=Join-Path $OutputDirectory 'REA-PC-Connector'
foreach($p in @($OutputDirectory,$service,(Join-Path $service 'apps\android\remote'),(Join-Path $service 'apps\desktop'),(Join-Path $service 'resources'),(Join-Path $service 'tools\jadx'),(Join-Path $service 'tools\wabt'))){New-Item -ItemType Directory -Path $p -Force|Out-Null}
Copy-Item -LiteralPath $Apk -Destination (Join-Path $OutputDirectory 'REA-Android-0.1.0.apk')
foreach($name in @('protocol.mjs','server.mjs','setup.mjs','start.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot "remote\$name") -Destination (Join-Path $service 'apps\android\remote')}
# Windows PowerShell 5 reads scripts reliably with a UTF-8 BOM.
$start=Join-Path $service 'apps\android\remote\start.ps1';[IO.File]::WriteAllText($start,[IO.File]::ReadAllText($start),[Text.UTF8Encoding]::new($true))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'remote\Start-REA-Server.cmd') -Destination $service
foreach($name in @('engine.mjs','bridge.mjs')){Copy-Item -LiteralPath (Join-Path $repoRoot "apps\desktop\$name") -Destination (Join-Path $service 'apps\desktop')}
foreach($name in @('core','runtime')){Copy-Item -LiteralPath (Join-Path $DesktopPath "resources\$name") -Destination (Join-Path $service 'resources') -Recurse}
Copy-Item -LiteralPath $JadxJar -Destination (Join-Path $service 'tools\jadx')
Copy-Item -LiteralPath (Join-Path $WabtRoot 'bin') -Destination (Join-Path $service 'tools\wabt') -Recurse
Copy-Item -LiteralPath (Join-Path $ToolLicenses 'jadx-headless-mcp-LICENSE') -Destination (Join-Path $service 'tools\jadx\LICENSE')
Copy-Item -LiteralPath (Join-Path $ToolLicenses 'wabt-LICENSE') -Destination (Join-Path $service 'tools\wabt\LICENSE')
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $service
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $OutputDirectory 'README.md')
$manifest=@(Get-ChildItem -LiteralPath $OutputDirectory -File -Recurse | ForEach-Object {[pscustomobject]@{path=[IO.Path]::GetRelativePath($OutputDirectory,$_.FullName);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$manifest|ConvertTo-Json -Depth 3|Set-Content -LiteralPath (Join-Path $OutputDirectory 'file-manifest.json') -Encoding utf8
Write-Output $OutputDirectory
