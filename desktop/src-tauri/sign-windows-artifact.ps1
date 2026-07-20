param(
  [Parameter(Mandatory = $true)]
  [string]$Artifact
)

$ErrorActionPreference = "Stop"

& artifact-signing-cli `
  --endpoint $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
  --account $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
  --certificate $env:AZURE_ARTIFACT_SIGNING_PROFILE `
  --description Argus `
  $Artifact

if ($LASTEXITCODE -ne 0) {
  throw "Azure Artifact Signing failed for $Artifact."
}
