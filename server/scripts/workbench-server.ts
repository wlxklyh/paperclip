// Windows workbench lifecycle owner. The core server owns all application/DB teardown.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertWindowsProviderProcessesStopped } from "@paperclipai/adapter-utils/windows-process-tree";

type Phase = "starting" | "running" | "stopping" | "stopped" | "failed";
interface ControlRecord {
  version: 1;
  pid: number;
  startedAt: string;
  repoRoot: string;
  dataRoot: string;
  port: number;
  pipe: string;
  token: string;
  phase: Phase;
}
export interface WorkbenchServer {
  listenPort: number;
  shutdown: () => Promise<void>;
}
export interface WorkbenchOptions {
  repoRoot: string;
  dataRoot: string;
  port: number;
}

export function controlPaths(options: WorkbenchOptions) {
  const identity = createHash("sha256").update(path.resolve(options.dataRoot).toLowerCase()).digest("hex").slice(0, 32);
  return {
    directory: path.join(options.dataRoot, "instances", "default"),
    record: path.join(options.dataRoot, "instances", "default", "workbench-control.json"),
    pipe: `\\\\.\\pipe\\paperclip-workbench-${identity}`,
  };
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function readRecord(options: WorkbenchOptions): ControlRecord | null {
  const paths = controlPaths(options);
  if (!fs.existsSync(paths.record)) return null;
  const record = JSON.parse(fs.readFileSync(paths.record, "utf8")) as ControlRecord;
  if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || record.pipe !== paths.pipe || record.dataRoot !== options.dataRoot || record.repoRoot !== options.repoRoot
    || !Number.isSafeInteger(record.port) || record.port < 1024 || record.port > 65535
    || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new Error("Invalid workbench control record; no process was changed.");
  }
  return record;
}

function publicState(record: ControlRecord) {
  return { pid: record.pid, port: record.port, phase: record.phase, startedAt: record.startedAt };
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export async function requestWorkbenchControl(options: WorkbenchOptions, action: "status" | "stop") {
  const record = readRecord(options);
  if (!record) return null;
  if (!isAlive(record.pid)) return null;
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(record.pipe);
    let output = "";
    const timer = setTimeout(() => socket.destroy(new Error("Workbench control timed out; shutdown is not confirmed.")), action === "stop" ? 120_000 : 5_000);
    socket.once("connect", () => socket.write(JSON.stringify({ token: record.token, action }) + "\n"));
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 8192) socket.destroy(new Error("Invalid control response."));
      if (!output.includes("\n")) return;
      try { resolve(JSON.parse(output.slice(0, output.indexOf("\n")))); }
      catch { reject(new Error("Invalid control response.")); }
      socket.destroy();
    });
    socket.once("error", () => reject(new Error("The recorded process is alive but its authenticated control channel is unavailable; no process was killed.")));
    socket.once("close", () => {
      clearTimeout(timer);
      if (!output.includes("\n")) reject(new Error("Control channel closed before a confirmed result."));
    });
  });
  if (response.ok !== true || response.pid !== record.pid || response.startedAt !== record.startedAt) {
    throw new Error("The workbench control response did not confirm this instance.");
  }
  return response;
}

export async function serveWorkbench(options: WorkbenchOptions, start: () => Promise<WorkbenchServer>) {
  const paths = controlPaths(options);
  fs.mkdirSync(paths.directory, { recursive: true });
  const previous = readRecord(options);
  if (previous && isAlive(previous.pid)) throw new Error("A recorded workbench process is still alive; use its control channel before starting another.");
  if (!(await portIsAvailable(options.port))) throw new Error("Requested API port is already occupied; refusing to start on another port.");

  const record: ControlRecord = { version: 1, pid: process.pid, startedAt: new Date().toISOString(),
    repoRoot: options.repoRoot, dataRoot: options.dataRoot, port: options.port,
    pipe: paths.pipe, token: randomBytes(32).toString("hex"), phase: "starting" };
  const writeRecord = () => {
    const temporary = `${paths.record}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, paths.record);
  };
  const removeRecord = () => {
    const current = readRecord(options);
    if (current?.token === record.token) fs.unlinkSync(paths.record);
  };
  let running: WorkbenchServer | undefined;
  let stopping: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let ready: Promise<WorkbenchServer>;
  const stop = () => stopping ??= (async () => {
    record.phase = "stopping";
    writeRecord();
    running = await ready;
    await running.shutdown();
    record.phase = "stopped";
    removeRecord();
  })();
  const control = net.createServer((socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    let input = "";
    socket.on("error", () => { /* A disconnected caller cannot cancel shutdown. */ });
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 4096) { socket.destroy(); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      let message: { token?: string; action?: string };
      try { message = JSON.parse(input.slice(0, newline)); }
      catch { socket.destroy(); return; }
      const candidate = typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
      const expected = Buffer.from(record.token);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) { socket.destroy(); return; }
      if (message.action === "status") {
        socket.end(JSON.stringify({ ok: true, ...publicState(record) }) + "\n");
      } else if (message.action === "stop") {
        socket.setTimeout(120_000);
        void stop().then(() => {
          socket.end(JSON.stringify({ ok: true, ...publicState(record) }) + "\n");
          control.close(() => resolveStopped());
        }).catch(() => {
          record.phase = "failed";
          writeRecord();
          socket.end(JSON.stringify({ ok: false, ...publicState(record) }) + "\n");
        });
      } else { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(paths.pipe, () => { control.removeListener("error", reject); resolve(); });
  });
  try {
    writeRecord();
    ready = start();
    running = await ready;
    if (running.listenPort !== options.port) {
      await running.shutdown();
      throw new Error("The server changed API ports; it has been stopped instead of publishing a misleading URL.");
    }
    if (!stopping) { record.phase = "running"; writeRecord(); }
    console.log(JSON.stringify({ workbench: "ready", ...publicState(record) }));
    return { stopped, stop, state: () => publicState(record) };
  } catch (error) {
    control.close();
    removeRecord();
    throw error;
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("This lifecycle entry point is for Windows.");
  const [command, dataRootArg, portArg = "3100"] = process.argv.slice(2);
  if (!["start", "stop", "status"].includes(command) || !dataRootArg || !path.isAbsolute(dataRootArg)) {
    throw new Error("Usage: workbench-server.ts <start|stop|status> <absolute-data-root> [port]");
  }
  const options = { repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    dataRoot: path.resolve(dataRootArg), port: Number(portArg) };
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error("Invalid API port.");
  if (command !== "start") {
    const response = await requestWorkbenchControl(options, command as "stop" | "status");
    if (!response) {
      if (command === "status") { process.exitCode = 3; return; }
      if (!(await portIsAvailable(options.port))) throw new Error("No owned workbench process was found, but the API port is occupied; no process was changed.");
      console.log("No running workbench process was found.");
      return;
    }
    if (command === "stop" && !(await portIsAvailable(Number(response.port)))) throw new Error("Shutdown returned but the API port is still occupied; shutdown is not verified.");
    console.log(JSON.stringify(response));
    return;
  }
  const paths = controlPaths(options);
  if (!fs.existsSync(path.join(paths.directory, "config.json"))) throw new Error("Run initialize-workbench.ps1 first.");
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
    "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_DEPLOYMENT_MODE", "PAPERCLIP_DEPLOYMENT_EXPOSURE",
    "PAPERCLIP_AUTH_BASE_URL_MODE", "PAPERCLIP_AUTH_PUBLIC_BASE_URL", "PAPERCLIP_PUBLIC_URL", "BETTER_AUTH_URL", "BETTER_AUTH_BASE_URL"]) delete process.env[key];
  Object.assign(process.env, {
    PAPERCLIP_HOME: options.dataRoot, PAPERCLIP_INSTANCE_ID: "default", PAPERCLIP_CONFIG: path.join(paths.directory, "config.json"),
    PAPERCLIP_CONTEXT: path.join(options.dataRoot, "context.json"), PAPERCLIP_TELEMETRY_DISABLED: "1",
    PAPERCLIP_BIND: "loopback", PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
    HOST: "127.0.0.1", PORT: String(options.port), SERVE_UI: "true", PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_NO_BROWSER: "true",
  });
  // Avoid loading a checkout-level .env in addition to the explicit instance .env.
  process.chdir(path.join(options.repoRoot, "server"));
  const lifecycle = await serveWorkbench(options, async () => {
    const { startServer } = await import("../src/index.js");
    const server = await startServer();
    return { listenPort: server.listenPort, shutdown: async () => {
      await server.shutdown();
      // Core shutdown logs bounded drain failures and continues closing the DB.
      // Do not publish "stopped" or exit while provider tree cleanup is uncertain.
      assertWindowsProviderProcessesStopped();
    } };
  });
  await lifecycle.stopped;
  // shutdown() already drained the application, closed pools and stopped its DB.
  // Exit this owner, never an intermediary pnpm process.
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Workbench lifecycle failed.");
    process.exit(1);
  });
}
