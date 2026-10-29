param([Parameter(Mandatory=$true)][string]$AppBuild,[Parameter(Mandatory=$true)][string]$ConnectionFile,[Parameter(Mandatory=$true)][string]$AndroidJar,[Parameter(Mandatory=$true)][string]$BuildTools,[string]$JavaHome=$env:JAVA_HOME)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$probeBuild=Join-Path $repoRoot ('.cache\android-probe\'+[guid]::NewGuid().ToString());foreach($p in @('','classes','dex','assets')){New-Item -ItemType Directory -Path (Join-Path $probeBuild $p) -Force|Out-Null}
$sid=([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
& icacls.exe $probeBuild /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect credential-bearing validation directory'}
# This credential-bearing test APK stays in ignored cache and must never be delivered.
Copy-Item -LiteralPath $ConnectionFile -Destination (Join-Path $probeBuild 'assets\connection.json')
function Check([string]$step){if($LASTEXITCODE -ne 0){throw "$step failed: $LASTEXITCODE"}}
& (Join-Path $BuildTools 'aapt2.exe') link -o (Join-Path $probeBuild 'unsigned.apk') -I $AndroidJar --manifest (Join-Path $PSScriptRoot 'AndroidManifest.xml') -A (Join-Path $probeBuild 'assets') --min-sdk-version 26 --target-sdk-version 36;Check 'link'
$sources=@(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.java'|Select-Object -ExpandProperty FullName)
& (Join-Path $JavaHome 'bin\javac.exe') -encoding UTF-8 --release 8 -classpath ($AndroidJar+';'+(Join-Path $AppBuild 'classes')) -d (Join-Path $probeBuild 'classes') @sources;Check 'javac'
$classes=@(Get-ChildItem (Join-Path $probeBuild 'classes') -Filter '*.class' -Recurse|Select-Object -ExpandProperty FullName)
& (Join-Path $JavaHome 'bin\java.exe') -cp (Join-Path $BuildTools 'lib\d8.jar') com.android.tools.r8.D8 --lib $AndroidJar --classpath (Join-Path $AppBuild 'classes') --min-api 26 --output (Join-Path $probeBuild 'dex') @classes;Check 'd8'
& (Join-Path $JavaHome 'bin\jar.exe') uf (Join-Path $probeBuild 'unsigned.apk') -C (Join-Path $probeBuild 'dex') classes.dex;Check 'jar'
& (Join-Path $BuildTools 'zipalign.exe') -p 4 (Join-Path $probeBuild 'unsigned.apk') (Join-Path $probeBuild 'aligned.apk');Check 'zipalign'
& (Join-Path $JavaHome 'bin\java.exe') -jar (Join-Path $BuildTools 'lib\apksigner.jar') sign --ks (Join-Path $repoRoot '.cache\android-signing\rea-android.p12') --ks-key-alias rea-android --ks-pass ('file:'+(Join-Path $repoRoot '.cache\android-signing\password.txt')) --out (Join-Path $probeBuild 'probe.apk') (Join-Path $probeBuild 'aligned.apk');Check 'sign'
Write-Output (Join-Path $probeBuild 'probe.apk')
