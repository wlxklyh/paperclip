param(
    [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '../../../..'),
    [ValidateRange(1024,65535)][int]$Port = 3100,
    [ValidateRange(1024,65535)][int]$DatabasePort = 54329
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This initializer is for the Windows workbench.' }
$workbenchRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$dataRoot = Join-Path $workbenchRoot 'runtime/paperclip'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$tsxLoader = Join-Path $repoRoot 'cli/node_modules/tsx/dist/loader.mjs'
if (-not (Test-Path -LiteralPath $tsxLoader)) { throw 'Install this checkout dependencies before initializing.' }
$tsxLoaderUri = ([Uri]$tsxLoader).AbsoluteUri

# A process-owned mutex has no stale lock file after an interrupted initializer.
$hasher = [Security.Cryptography.SHA256]::Create()
try { $identity = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hasher.Dispose() }
$mutex = [Threading.Mutex]::new($false, "Local\PaperclipWorkbenchInitialize-$identity")
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another initializer is already working on this instance.' }

    # Keep all environment changes inside this short-lived child, never the user profile.
    $source = @'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

class SetupError extends Error {}
let stage = "loading upstream configuration helpers";
try {
  const [repoRoot, dataRoot, portText, dbPortText] = process.argv.slice(2);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 11)) throw new SetupError("Node.js 24.11 or newer is required.");
  for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
    "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "DATABASE_URL", "DATABASE_MIGRATION_URL"]) {
    delete process.env[key];
  }
  process.env.PAPERCLIP_HOME = dataRoot;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  const upstream = (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);
  const { describeLocalInstancePaths } = await upstream("cli/src/config/home.ts");
  const { paperclipConfigSchema } = await upstream("cli/src/config/schema.ts");
  const { writeConfig } = await upstream("cli/src/config/store.ts");
  const envHelpers = await upstream("cli/src/config/env.ts");
  const { ensureLocalSecretsKeyFile } = await upstream("cli/src/config/secrets-key.ts");
  const paths = describeLocalInstancePaths("default");
  process.env.PAPERCLIP_CONFIG = paths.configPath;
  const envPath = envHelpers.resolvePaperclipEnvFile(paths.configPath);
  const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const withinInstance = (value) => {
    if (!path.isAbsolute(value)) return false;
    const relative = path.relative(paths.instanceRoot, value);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  stage = "validating the existing instance configuration";
  const existing = fs.existsSync(paths.configPath);
  let config;
  if (existing) {
    let parsed;
    try { parsed = paperclipConfigSchema.safeParse(JSON.parse(fs.readFileSync(paths.configPath, "utf8"))); }
    catch { throw new SetupError("Existing config.json is not valid JSON; it was left unchanged."); }
    if (!parsed.success) throw new SetupError("Existing config.json does not match the upstream schema; it was left unchanged.");
    config = parsed.data;
  } else {
    config = paperclipConfigSchema.parse({
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
      database: { mode: "embedded-postgres", embeddedPostgresDataDir: paths.embeddedPostgresDataDir,
        embeddedPostgresPort: Number(dbPortText), backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: paths.backupDir } },
      logging: { mode: "file", logDir: paths.logDir },
      server: { deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1",
        port: Number(portText), allowedHostnames: [], serveUi: true },
      auth: { baseUrlMode: "auto", disableSignUp: false },
      telemetry: { enabled: false },
      storage: { provider: "local_disk", localDisk: { baseDir: paths.storageDir } },
      secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: paths.secretsKeyFilePath } },
    });
  }
  if (config.database.mode !== "embedded-postgres" || !samePath(config.database.embeddedPostgresDataDir, paths.embeddedPostgresDataDir)
    || config.storage.provider !== "local_disk" || config.secrets.provider !== "local_encrypted"
    || ![config.logging.logDir, config.database.backup.dir, config.storage.localDisk.baseDir, config.secrets.localEncrypted.keyFilePath].every(withinInstance)
    || !["local_trusted", "authenticated"].includes(config.server.deploymentMode) || config.server.exposure !== "private"
    || !["127.0.0.1", "localhost", "::1"].includes(config.server.host)
    || (config.server.bind && config.server.bind !== "loopback")) {
    throw new SetupError("Existing settings are outside this isolated local workbench profile; review them without overwriting them.");
  }
  if (config.server.port !== Number(portText) || config.database.embeddedPostgresPort !== Number(dbPortText)) {
    throw new SetupError("Existing ports differ. Rerun with matching -Port and -DatabasePort; settings were not changed.");
  }
  const entries = envHelpers.readPaperclipEnvEntries(envPath);
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL"]) {
    if (entries[key]?.trim()) throw new SetupError(`The instance .env contains ${key}; this initializer only supports its dedicated embedded database.`);
  }
  for (const [key, expected] of [["PAPERCLIP_HOME", dataRoot], ["PAPERCLIP_CONFIG", paths.configPath],
    ["PAPERCLIP_SECRETS_MASTER_KEY_FILE", config.secrets.localEncrypted.keyFilePath]]) {
    if (entries[key]?.trim() && !samePath(entries[key], expected)) throw new SetupError(`The instance .env redirects ${key}; review it before initialization.`);
  }
  if (entries.PAPERCLIP_INSTANCE_ID && entries.PAPERCLIP_INSTANCE_ID !== "default") {
    throw new SetupError("The instance .env selects another instance; it was left unchanged.");
  }
  // A fresh key cannot decrypt an existing database's stored secrets. Fail before
  // creating any instance files instead of hiding a lost-key recovery problem.
  if (fs.existsSync(path.join(config.database.embeddedPostgresDataDir, "PG_VERSION"))
    && !fs.existsSync(config.secrets.localEncrypted.keyFilePath)
    && !entries.PAPERCLIP_SECRETS_MASTER_KEY?.trim()) {
    throw new SetupError("Existing database is missing its local encryption master key. Restore the original key or instance master-key source; no replacement was created.");
  }
  stage = "creating missing instance files";
  fs.mkdirSync(paths.instanceRoot, { recursive: true });
  if (!existing) {
    // Upstream validates and durably writes a staging file. Linking publishes it
    // without overwriting a config created concurrently by another tool.
    const staged = path.join(paths.instanceRoot, `.workbench-config-${randomUUID()}.json`);
    try {
      writeConfig(config, staged);
      try { fs.linkSync(staged, paths.configPath); }
      catch (error) {
        if (error.code === "EEXIST") throw new SetupError("Another tool created config.json. Rerun to validate it; nothing was overwritten.");
        throw error;
      }
    } finally {
      if (fs.existsSync(staged)) fs.unlinkSync(staged);
    }
  }
  const jwt = envHelpers.ensureAgentJwtSecret(paths.configPath);
  const action = envHelpers.ensureToolActionSigningSecret(paths.configPath);
  const master = ensureLocalSecretsKeyFile(config, paths.configPath);
  console.log(JSON.stringify({ configPath: paths.configPath, configCreated: !existing,
    agentJwtCreated: jwt.created, toolActionSecretCreated: action.created, masterKeyStatus: master.status,
    serverStarted: false, databaseChanged: false }, null, 2));
} catch (error) {
  console.error(error instanceof SetupError ? error.message : `Initialization failed while ${stage}. Check local permissions and installed dependencies; configuration values are not printed.`);
  process.exitCode = 1;
}
'@
    $source | & $nodeExecutable --import $tsxLoaderUri --input-type=module - $repoRoot $dataRoot ([string]$Port) ([string]$DatabasePort)
    if ($LASTEXITCODE -ne 0) { throw 'Workbench initialization did not complete; see the safe diagnostic above.' }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
