param(
    [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '../../../..'),
    [ValidateRange(1024,65535)][int]$Port = 3100
)
$ErrorActionPreference = 'Stop'
$workbenchRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$dataRoot = Join-Path $workbenchRoot 'runtime/paperclip'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$tsxLoader = Join-Path $repoRoot 'server/node_modules/tsx/dist/loader.mjs'
if (-not (Test-Path -LiteralPath $tsxLoader)) { throw 'This checkout is missing its tsx dependency.' }
$tsxLoaderUri = ([Uri]$tsxLoader).AbsoluteUri
# Authenticated local IPC asks the owning process to await core shutdown().
# A missing/broken control channel never falls back to killing a PID or a port.
& $nodeExecutable --import $tsxLoaderUri (Join-Path $repoRoot 'server/scripts/workbench-server.ts') stop $dataRoot ([string]$Port)
if ($LASTEXITCODE -ne 0) { throw 'Workbench shutdown was not confirmed; no fallback kill was attempted.' }
