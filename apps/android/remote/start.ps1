param([string]$DesktopPath,[string]$DataDirectory=(Join-Path $env:LOCALAPPDATA 'REA-Mobile-Server'),[string]$PublicUrl,[string]$RevokeDevice)
$ErrorActionPreference='Stop'
if(-not $DesktopPath){
  $bundledRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  if(Test-Path -LiteralPath (Join-Path $bundledRoot 'resources\runtime\node.exe')){$DesktopPath=$bundledRoot}
  else{$DesktopPath=Read-Host '输入 REA 电脑版目录（包含 resources 的文件夹）'}
}
$node=Join-Path $DesktopPath 'resources\runtime\node.exe'
$core=Join-Path $DesktopPath 'resources\core'
if(-not(Test-Path -LiteralPath $node)){throw '找不到 REA 电脑版随附的 Node 运行时'}
$jadx=Join-Path $DesktopPath 'tools\jadx\jadx-headless-mcp-0.7.1-all.jar'
if(Test-Path -LiteralPath $jadx){
  if((Get-FileHash -LiteralPath $jadx -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75'){throw 'JADX 包校验失败'}
  $env:REA_JADX_MCP_JAR=$jadx
}
$wabt=Join-Path $DesktopPath 'tools\wabt\bin'
if(Test-Path -LiteralPath (Join-Path $wabt 'wasm-validate.exe')){$env:REA_WABT_BIN_DIRECTORY=$wabt}
$config=Join-Path $DataDirectory 'server.json'
if($RevokeDevice){& $node (Join-Path $PSScriptRoot 'setup.mjs') --root $DataDirectory --revoke $RevokeDevice;exit $LASTEXITCODE}
if(-not(Test-Path -LiteralPath $config)){
  if(-not $PublicUrl){$PublicUrl=Read-Host '输入手机可访问的 HTTPS 地址，例如 https://你的VPN地址:8443'}
  if(-not $env:JAVA_HOME){throw '首次生成 TLS 证书需要已有 JDK，请设置 JAVA_HOME'}
  $keytool=Join-Path $env:JAVA_HOME 'bin\keytool.exe'
  if(-not(Test-Path -LiteralPath $keytool)){throw '首次生成 TLS 证书需要已有 JDK，请设置 JAVA_HOME；服务不会安装或升级其他软件'}
  & $node (Join-Path $PSScriptRoot 'setup.mjs') --root $DataDirectory --core $core --node $node --keytool $keytool --url $PublicUrl
  if($LASTEXITCODE -ne 0){throw '连接服务初始化失败'}
}
& $node (Join-Path $PSScriptRoot 'server.mjs') $DataDirectory
exit $LASTEXITCODE
