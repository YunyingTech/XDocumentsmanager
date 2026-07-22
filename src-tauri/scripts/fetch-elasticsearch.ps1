$ErrorActionPreference = 'Stop'

$version = '8.17.0'
$archiveName = "elasticsearch-$version-windows-x86_64.zip"
$baseUrl = "https://artifacts.elastic.co/downloads/elasticsearch/$archiveName"
$resourcesDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resources'))
$distributionDir = Join-Path $resourcesDir 'elasticsearch'
$runtimeDir = Join-Path $distributionDir 'runtime'
$launcher = Join-Path $runtimeDir 'bin\elasticsearch.bat'

if (Test-Path -LiteralPath $launcher) {
    Write-Host "Elasticsearch $version runtime is already available."
    exit 0
}

New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
New-Item -ItemType Directory -Force -Path $distributionDir | Out-Null
$archivePath = Join-Path $resourcesDir $archiveName
$checksumPath = "$archivePath.sha512"

& curl.exe --ssl-no-revoke -L --fail --retry 10 --retry-delay 3 --connect-timeout 30 --max-time 7200 -C - -o $archivePath $baseUrl
if ($LASTEXITCODE -ne 0) { throw "Elasticsearch download failed with exit code $LASTEXITCODE" }
& curl.exe --ssl-no-revoke -L --fail --retry 5 --connect-timeout 30 --max-time 120 -o $checksumPath "$baseUrl.sha512"
if ($LASTEXITCODE -ne 0) { throw "Elasticsearch checksum download failed with exit code $LASTEXITCODE" }

$expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA512).Hash.ToUpperInvariant()
if ($actual -ne $expected) {
    throw "Elasticsearch archive checksum mismatch. Expected $expected, got $actual."
}

$extractDir = [IO.Path]::GetFullPath((Join-Path $resourcesDir '.elasticsearch-extract'))
if (-not $extractDir.StartsWith($resourcesDir, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe Elasticsearch extraction path.'
}
if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
$expanded = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
if (-not $expanded -or -not (Test-Path -LiteralPath (Join-Path $expanded.FullName 'bin\elasticsearch.bat'))) {
    throw 'Downloaded archive does not contain a valid Elasticsearch Windows distribution.'
}
if (Test-Path -LiteralPath $runtimeDir) {
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force
}
Move-Item -LiteralPath $expanded.FullName -Destination $runtimeDir
Remove-Item -LiteralPath $extractDir -Recurse -Force
Remove-Item -LiteralPath $archivePath, $checksumPath -Force
Write-Host "Elasticsearch $version runtime prepared at $distributionDir"
