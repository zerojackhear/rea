param(
  [Parameter(Mandatory=$true)][string]$AndroidJar,
  [Parameter(Mandatory=$true)][string]$BuildTools,
  [string]$JavaHome=$env:JAVA_HOME,
  [string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$androidSource=$PSScriptRoot
$repoRoot=Split-Path -Parent (Split-Path -Parent $androidSource)
if(-not $JavaHome){throw '请指定 JavaHome（JDK 17 或更新版本）'}
foreach($required in @($AndroidJar,(Join-Path $BuildTools 'aapt2.exe'),(Join-Path $JavaHome 'bin\javac.exe'))){if(-not(Test-Path -LiteralPath $required)){throw "构建依赖不存在：$required"}}
if(-not $OutputDirectory){$OutputDirectory=Join-Path $repoRoot ('.cache\android-build\'+[guid]::NewGuid().ToString())}
if(Test-Path -LiteralPath $OutputDirectory){throw '输出目录必须是全新目录，避免覆盖已有交付物'}
foreach($name in @('','classes','dex','generated')){New-Item -ItemType Directory -Path (Join-Path $OutputDirectory $name) -Force|Out-Null}
$androidBuild=[IO.Path]::GetFullPath($OutputDirectory)
function Assert-Exit([string]$step){if($LASTEXITCODE -ne 0){throw "$step 失败，退出码 $LASTEXITCODE"}}
& (Join-Path $BuildTools 'aapt2.exe') compile --dir (Join-Path $androidSource 'res') -o (Join-Path $androidBuild 'res.zip'); Assert-Exit '资源编译'
& (Join-Path $BuildTools 'aapt2.exe') link -o (Join-Path $androidBuild 'unsigned.apk') -I $AndroidJar --manifest (Join-Path $androidSource 'AndroidManifest.xml') --java (Join-Path $androidBuild 'generated') --min-sdk-version 26 --target-sdk-version 36 (Join-Path $androidBuild 'res.zip'); Assert-Exit '资源链接'
$sources=@(Get-ChildItem (Join-Path $androidSource 'src'),(Join-Path $androidBuild 'generated') -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
& (Join-Path $JavaHome 'bin\javac.exe') -encoding UTF-8 --release 8 -classpath $AndroidJar -d (Join-Path $androidBuild 'classes') @sources; Assert-Exit 'Java 编译'
$classes=@(Get-ChildItem (Join-Path $androidBuild 'classes') -Filter '*.class' -Recurse | Select-Object -ExpandProperty FullName)
& (Join-Path $JavaHome 'bin\java.exe') -cp (Join-Path $BuildTools 'lib\d8.jar') com.android.tools.r8.D8 --lib $AndroidJar --min-api 26 --output (Join-Path $androidBuild 'dex') @classes; Assert-Exit 'DEX 编译'
& (Join-Path $JavaHome 'bin\jar.exe') uf (Join-Path $androidBuild 'unsigned.apk') -C (Join-Path $androidBuild 'dex') classes.dex; Assert-Exit 'APK 组装'
& (Join-Path $BuildTools 'zipalign.exe') -p 4 (Join-Path $androidBuild 'unsigned.apk') (Join-Path $androidBuild 'aligned.apk'); Assert-Exit 'APK 对齐'
$signing=Join-Path $repoRoot '.cache\android-signing';New-Item -ItemType Directory -Path $signing -Force|Out-Null
$sid=([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
& icacls.exe $signing /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null; Assert-Exit '签名密钥目录保护'
$key=Join-Path $signing 'rea-android.p12';$password=Join-Path $signing 'password.txt'
if(-not(Test-Path -LiteralPath $key)){
  if(Test-Path -LiteralPath $password){throw '发现未完成的签名初始化，请检查保留的密码文件'}
  $random=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
  [IO.File]::WriteAllText($password,[Convert]::ToBase64String($random),[Text.UTF8Encoding]::new($false))
  & (Join-Path $JavaHome 'bin\keytool.exe') -genkeypair -alias rea-android -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=REA Android Local Release' -storetype PKCS12 -keystore $key -storepass:file $password -keypass:file $password; Assert-Exit '签名密钥生成'
}
$apk=Join-Path $androidBuild 'REA-Android-0.1.0.apk'
& (Join-Path $JavaHome 'bin\java.exe') -jar (Join-Path $BuildTools 'lib\apksigner.jar') sign --ks $key --ks-key-alias rea-android --ks-pass "file:$password" --out $apk (Join-Path $androidBuild 'aligned.apk'); Assert-Exit 'APK 签名'
& (Join-Path $JavaHome 'bin\java.exe') -jar (Join-Path $BuildTools 'lib\apksigner.jar') verify --verbose --print-certs $apk; Assert-Exit '签名验证'
& (Join-Path $BuildTools 'zipalign.exe') -c -p 4 $apk; Assert-Exit '对齐验证'
Get-FileHash -LiteralPath $apk -Algorithm SHA256 | Format-List
Write-Output $apk
