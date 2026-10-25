param(
    [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '../../../..'),
    [ValidateRange(1024,65535)][int]$Port = 3100,
    [ValidateRange(1024,65535)][int]$DatabasePort = 54329,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$workbenchRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$dataRoot = Join-Path $workbenchRoot 'runtime/paperclip'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$tsxLoader = Join-Path $repoRoot 'server/node_modules/tsx/dist/loader.mjs'
if (-not (Test-Path -LiteralPath $tsxLoader)) { throw 'Install this checkout dependencies before starting.' }
$tsxLoaderUri = ([Uri]$tsxLoader).AbsoluteUri
$entryPoint = Join-Path $repoRoot 'server/scripts/workbench-server.ts'
& $nodeExecutable --import $tsxLoaderUri $entryPoint status $dataRoot ([string]$Port)
if ($LASTEXITCODE -eq 0) { Write-Output 'The owned workbench is already running; no second service was started.'; return }
if ($LASTEXITCODE -ne 3) { throw 'Existing lifecycle state could not be verified; no service was started.' }
& (Join-Path $PSScriptRoot 'initialize-workbench.ps1') -WorkspaceRoot $workbenchRoot -Port $Port -DatabasePort $DatabasePort
$toolRoot = Join-Path $workbenchRoot 'runtime/bin'
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
& corepack enable --install-directory $toolRoot pnpm
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the local pnpm shim.' }
# Nested upstream scripts invoke pnpm by name; keep them on packageManager's version.
$previousPath = $env:PATH
$previousScriptShell = $env:npm_config_script_shell
# Upstream build scripts use POSIX mkdir/cp. Git Bash runs those build commands;
# Node, PostgreSQL and the official Codex executable still run natively on Windows.
$gitExecutable = (Get-Command git.exe -ErrorAction Stop).Source
$gitBashCandidates = @(
    (Join-Path (Split-Path $gitExecutable) '../bin/bash.exe'),
    (Join-Path (Split-Path $gitExecutable) 'bash.exe')
)
$gitBash = $gitBashCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $gitBash) { throw 'Git for Windows Bash is required by the upstream build scripts.' }
Push-Location $repoRoot
try {
    $env:PATH = "$toolRoot;$previousPath"
    $env:npm_config_script_shell = [IO.Path]::GetFullPath($gitBash)
    if (-not $SkipBuild) {
        # The same TypeScript/runtime preparation used by the upstream dev runner.
        # Native Runner is disabled in this Windows CLI workbench instance.
        & corepack pnpm --filter '@paperclipai/paperclip-runner' build:typescript
        if ($LASTEXITCODE -ne 0) { throw 'Paperclip Runner TypeScript preparation failed.' }
        & corepack pnpm --filter '@paperclipai/plugin-sdk' build
        if ($LASTEXITCODE -ne 0) { throw 'Plugin SDK preparation failed.' }
    }
    # Run the lifecycle owner itself, without an intermediary pnpm server process.
    & $nodeExecutable --import $tsxLoaderUri $entryPoint start $dataRoot ([string]$Port)
    if ($LASTEXITCODE -ne 0) { throw 'Paperclip lifecycle owner exited with an error.' }
} finally {
    $env:PATH = $previousPath
    if ($null -eq $previousScriptShell) { Remove-Item Env:npm_config_script_shell -ErrorAction SilentlyContinue }
    else { $env:npm_config_script_shell = $previousScriptShell }
    Pop-Location
}
