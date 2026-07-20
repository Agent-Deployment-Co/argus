param(
  [Parameter(Mandatory = $true)]
  [string]$Artifact
)

$ErrorActionPreference = "Stop"

$signingCli = $env:ARTIFACT_SIGNING_CLI
if (-not $signingCli) {
  $signingCli = Join-Path $env:CARGO_HOME "bin\artifact-signing-cli.exe"
}

$arguments = @(
  "-e", $env:AZURE_ARTIFACT_SIGNING_ENDPOINT,
  "-a", $env:AZURE_ARTIFACT_SIGNING_ACCOUNT,
  "-c", $env:AZURE_ARTIFACT_SIGNING_PROFILE,
  "-d", "Argus",
  "--azure-cli-path", $env:AZURE_CLI_PATH,
  "--sign-tool-path", $env:SIGNTOOL_PATH,
  $Artifact
)

& $signingCli @arguments

if ($LASTEXITCODE -ne 0) {
  throw "Azure Artifact Signing failed for $Artifact."
}
