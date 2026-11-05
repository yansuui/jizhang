param(
    [Parameter(Mandatory = $true)][long]$RunId,
    [string]$Repository = 'yansuui/jizhang',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../build/downloads')
)

$ErrorActionPreference = 'Stop'
$runJson = & gh run view $RunId --repo $Repository --json conclusion,headSha,number,status,url
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the requested GitHub run.' }
$run = $runJson | ConvertFrom-Json
if ($run.status -ne 'completed' -or $run.conclusion -ne 'success') {
    throw 'The requested iOS run has not completed successfully.'
}

$destination = Join-Path $OutputDirectory ([string]$RunId)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$destination = (Resolve-Path -LiteralPath $destination).Path
& gh run download $RunId --repo $Repository --name "Jizhang-ios-$($run.number)" --dir $destination
if ($LASTEXITCODE -ne 0) { throw 'GitHub artifact download failed.' }

$ipa = Join-Path $destination 'Jizhang-unsigned.ipa'
$checksumFile = Join-Path $destination 'SHA256SUMS.txt'
$metadataFile = Join-Path $destination 'build-metadata.json'
if (-not (Test-Path -LiteralPath $ipa) -or -not (Test-Path -LiteralPath $checksumFile)) {
    throw 'The artifact does not contain the IPA and checksum.'
}
$checksum = (Get-Content -LiteralPath $checksumFile -Raw).Trim()
if ($checksum -notmatch '^([0-9a-fA-F]{64})\s+\*?Jizhang-unsigned\.ipa$') {
    throw 'Unexpected checksum manifest.'
}
$expected = $Matches[1]
$actual = (Get-FileHash -LiteralPath $ipa -Algorithm SHA256).Hash
if ($expected -ne $actual) { throw 'IPA SHA-256 does not match the build artifact.' }
$metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
if ($metadata.commit -ne $run.headSha) { throw 'Artifact commit does not match the requested build.' }

[PSCustomObject]@{
    IPA = $ipa
    SHA256 = $actual.ToLowerInvariant()
    Commit = $run.headSha
    BuildURL = $run.url
    Signing = 'Unsigned; use local Sideloadly to sign and install.'
}
