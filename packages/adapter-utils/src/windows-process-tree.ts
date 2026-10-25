import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type OwnedProcess = {
  child: ChildProcess;
  beforeSpawnMs: number;
  afterSpawnMs: number;
  stop?: Promise<void>;
  failure?: Error;
};
const owned = new Map<number, OwnedProcess>();
const unverified = new Set<OwnedProcess>();

/** Register the actual provider child, not a PID recovered from a database or port. */
export function registerWindowsProviderProcess(child: ChildProcess, beforeSpawnMs: number) {
  if (process.platform !== "win32" || !child.pid) return;
  const entry: OwnedProcess = { child, beforeSpawnMs, afterSpawnMs: Date.now() };
  owned.set(child.pid, entry);
  child.once("close", () => {
    // Failed/uncertain cleanup remains visible to the lifecycle owner.
    if (!entry.stop && owned.get(child.pid!) === entry) owned.delete(child.pid!);
  });
}

export function hasWindowsProviderProcess(pid: number): boolean {
  return owned.has(pid);
}

/** The explicit Stop path can start cleanup outside runChildProcess's timers. */
export function waitForWindowsProviderCleanup(child: ChildProcess): Promise<void> | undefined {
  const entry = child.pid ? owned.get(child.pid) : undefined;
  return entry?.child === child ? entry.stop : undefined;
}

export function assertWindowsProviderProcessesStopped() {
  if (process.platform !== "win32") return;
  const unsettled = new Set([...owned.values(), ...unverified]).size;
  if (!unsettled) return;
  throw new Error(`Windows provider cleanup is unverified for ${unsettled} registered process tree(s); shutdown is not confirmed.`);
}

/**
 * Windows has no POSIX process-group signal. Stop a still-owned live root with
 * taskkill /T /F, retaining OS handles while checking the observed descendants.
 * A root that already exited before capture cannot prove its descendants gone.
 * This is bounded cleanup, not a Job Object or a guarantee against process escape.
 */
export function terminateWindowsProviderTree(pid: number): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows process-tree cleanup requires Windows."));
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return Promise.reject(new Error("Refusing an invalid or current process as a provider tree root."));
  }
  const entry = owned.get(pid);
  if (!entry) return Promise.reject(new Error("Windows provider launch ownership is unavailable; no process was signalled."));
  if (entry.stop) return entry.stop;
  entry.stop = (async () => {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error("Windows provider root exited before tree capture; descendant cleanup cannot be verified.");
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable; no process was signalled.");
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // Only validated integers are substituted; process arguments/environment are never serialized.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootId = ${pid}
$ownerId = ${process.pid}
$beforeMs = ${entry.beforeSpawnMs}
$afterMs = ${entry.afterSpawnMs}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$handles = @{}
$taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
function Read-ProcessRows {
  @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 5 -ErrorAction Stop)
}
function Capture-Process($row) {
  $id = [int]$row.ProcessId
  if ($id -le 1 -or $id -eq $ownerId -or $id -eq $PID) { throw 'Unsafe process-tree member; refusing cleanup.' }
  $process = [Diagnostics.Process]::GetProcessById($id)
  try {
    $null = $process.Handle # Hold the OS generation through taskkill and verification.
    $created = $process.StartTime.ToUniversalTime()
    if ([Math]::Abs(($created - $row.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) {
      throw 'Process generation changed during tree capture.'
    }
    $handles[$id] = @{ Process = $process; Created = $created }
  } catch { $process.Dispose(); throw }
}
function Capture-Descendants($rows) {
  do {
    $added = $false
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      $parentId = [int]$row.ParentProcessId
      if ($handles.ContainsKey($id) -or -not $handles.ContainsKey($parentId)) { continue }
      if ($row.CreationDate.ToUniversalTime() -lt $handles[$parentId].Created) { continue }
      Capture-Process $row
      $added = $true
    }
  } while ($added)
}
function Stop-Captured($id) {
  $process = $handles[[int]$id].Process
  if ($process.HasExited) { return }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $taskkillPath
  $start.Arguments = '/PID ' + [int]$id + ' /T /F'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $killer = [Diagnostics.Process]::Start($start)
  try {
    $stdout = $killer.StandardOutput.ReadToEndAsync()
    $stderr = $killer.StandardError.ReadToEndAsync()
    if (-not $killer.WaitForExit(5000)) {
      $killer.Kill()
      throw 'Windows taskkill timed out; cleanup is unverified.'
    }
    $null = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    if ($killer.ExitCode -ne 0) { throw 'Windows taskkill failed; cleanup is unverified.' }
  } finally { $killer.Dispose() }
}
try {
  $rows = Read-ProcessRows
  $root = $rows | Where-Object { [int]$_.ProcessId -eq $rootId } | Select-Object -First 1
  if ($null -eq $root -or [int]$root.ParentProcessId -ne $ownerId) { throw 'Provider root ownership changed or exited before capture.' }
  Capture-Process $root
  $createdMs = ([DateTimeOffset]$handles[$rootId].Created).ToUnixTimeMilliseconds()
  if ($createdMs -lt $beforeMs -or $createdMs -gt $afterMs) { throw 'Provider root launch generation does not match.' }
  Capture-Descendants $rows
  if ($handles[$rootId].Process.HasExited) { throw 'Provider root exited before tree termination.' }
  Stop-Captured $rootId
  # A bounded post-stop scan catches observed descendants created during capture.
  for ($pass = 0; $pass -lt 2; $pass++) {
    Capture-Descendants (Read-ProcessRows)
    foreach ($id in @($handles.Keys)) { Stop-Captured $id }
    foreach ($item in @($handles.Values)) {
      $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      if (-not $item.Process.WaitForExit($remaining)) { throw 'A captured provider descendant is still running.' }
    }
  }
  @{ stopped = $true; rootPid = $rootId; observedProcesses = $handles.Count } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  foreach ($item in @($handles.Values)) { $item.Process.Dispose() }
}
`;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024, encoding: "utf8",
      }));
    } catch (error) {
      const detail = typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim().slice(0, 500) : "process capture or cleanup timed out/failed";
      throw new Error(`Windows provider tree ${pid} was not verified stopped: ${detail}`);
    }
    const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as { stopped?: boolean; rootPid?: number };
    if (result.stopped !== true || result.rootPid !== pid) throw new Error("Windows cleanup did not confirm the owned provider tree.");
    if (owned.get(pid) === entry) owned.delete(pid);
  })().catch((error: unknown) => {
    entry.failure = error instanceof Error ? error : new Error("Windows provider cleanup failed.");
    // A later PID reuse must not erase uncertainty about the previous generation.
    unverified.add(entry);
    throw entry.failure;
  });
  return entry.stop;
}
