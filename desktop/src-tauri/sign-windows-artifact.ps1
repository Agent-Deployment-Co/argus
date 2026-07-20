param(
  [Parameter(Mandatory = $true)]
  [string]$Artifact
)

$ErrorActionPreference = "Stop"

if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "`nArtifact signer invoked for: $Artifact"
}

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

$output = @(& $signingCli @arguments 2>&1)
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  $details = ($output | Out-String).Trim()
  foreach ($secret in @(
    $env:AZURE_CLIENT_ID,
    $env:AZURE_CLIENT_SECRET,
    $env:AZURE_TENANT_ID,
    $env:AZURE_ARTIFACT_SIGNING_ENDPOINT,
    $env:AZURE_ARTIFACT_SIGNING_ACCOUNT,
    $env:AZURE_ARTIFACT_SIGNING_PROFILE
  )) {
    if ($secret) {
      $details = $details.Replace($secret, "***")
    }
  }

  if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "`n### Azure Artifact Signing failure"
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "Artifact: $Artifact"
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "Exit code: $exitCode"
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "````text"
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $details
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "````"
  }

  throw "Azure Artifact Signing failed for $Artifact (exit code $exitCode)."
}
