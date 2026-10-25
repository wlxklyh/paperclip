import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { assertWindowsProviderProcessesStopped, terminateWindowsProviderTree } from "@paperclipai/adapter-utils/windows-process-tree";
import * as windowsTree from "@paperclipai/adapter-utils/windows-process-tree";
import { terminateLocalService } from "./local-service-supervisor.js";

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const fixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
const root = process.argv[3];
if (mode === 'provider') {
  const command = '""' + process.execPath + '" "' + __filename + '" leaf "' + root + '""';
  const shell = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', command],
    { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  shell.on('error', error => { fs.writeFileSync(path.join(root, 'spawn-error.txt'), String(error)); process.exit(2); });
  fs.writeFileSync(path.join(root, 'provider.json'), JSON.stringify({ pid: process.pid, shellPid: shell.pid }));
  if (process.argv[4] === 'terminal completion') process.stdout.write('TEST_TERMINAL_RESULT\n');
} else {
  fs.writeFileSync(path.join(root, 'leaf.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
}
setInterval(() => fs.writeFileSync(path.join(root, mode + '.tick'), String(Date.now())), 100);
// A failed assertion must not leave a permanent test descendant behind.
setTimeout(() => process.exit(0), 20000);
`;

async function readReady(file: string) {
  const deadline = Date.now() + 7_000;
  do {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, number>; }
    catch { await delay(50); }
  } while (Date.now() < deadline);
  throw new Error(`Test fixture did not become ready: ${path.basename(file)}`);
}

describe.skipIf(process.platform !== "win32")("owned Windows provider trees", () => {
  it("refuses a mismatched launch generation and retains the failure without killing the child", async () => {
    // Keep intentionally failed ownership evidence in a separate test process.
    const moduleUrl = new URL("../../../packages/adapter-utils/src/windows-process-tree.ts", import.meta.url).href;
    const loaderUrl = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const code = `
      import { spawn } from 'node:child_process';
      import { registerWindowsProviderProcess, terminateWindowsProviderTree, assertWindowsProviderProcessesStopped } from ${JSON.stringify(moduleUrl)};
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {windowsHide:true,stdio:'ignore'});
      registerWindowsProviderProcess(child, Date.now() + 60000);
      let rejected=false, retained=false;
      try {
        await terminateWindowsProviderTree(child.pid).catch(error => { rejected=/generation does not match/.test(error.message); });
        try { assertWindowsProviderProcessesStopped(); } catch { retained=true; }
        process.kill(child.pid,0);
        console.log(JSON.stringify({rejected,retained,childStillAlive:child.exitCode===null && child.signalCode===null}));
      } finally { child.kill(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", loaderUrl, "--input-type=module", "-e", code], {
      windowsHide: true, timeout: 15_000, encoding: "utf8",
    });
    expect(JSON.parse(stdout.trim())).toEqual({ rejected: true, retained: true, childStillAlive: true });
  }, 20_000);

  it("waits for cleanup proof after child close and propagates a late cleanup failure", async () => {
    let rejectCleanup!: (error: Error) => void;
    let observedJoin!: () => void;
    const joined = new Promise<void>(resolve => { observedJoin = resolve; });
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    const proof = vi.spyOn(windowsTree, "waitForWindowsProviderCleanup").mockImplementation(() => {
      observedJoin();
      return cleanup;
    });
    let settled = false;
    try {
      const run = runChildProcess(randomUUID(), process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(), env: {}, timeoutSec: 0, graceSec: 1, onLog: async () => {},
      });
      void run.then(() => { settled = true; }, () => { settled = true; });
      await joined;
      await delay(30);
      expect(settled).toBe(false);
      rejectCleanup(new Error("TEST cleanup proof unavailable"));
      await expect(run).rejects.toThrow("TEST cleanup proof unavailable");
      expect(() => assertWindowsProviderProcessesStopped()).not.toThrow();
    } finally { proof.mockRestore(); }
  });

  it("refuses current and unregistered processes without signalling them", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { windowsHide: true, stdio: "ignore" });
    try {
      await expect(terminateWindowsProviderTree(process.pid)).rejects.toThrow(/current process/);
      await expect(terminateWindowsProviderTree(unrelated.pid!)).rejects.toThrow(/ownership is unavailable/);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally { unrelated.kill(); }
  });

  it.each(["timeout", "explicit stop", "terminal completion"] as const)("stops Node -> cmd -> Node on %s and preserves an unrelated process", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-windows-tree-test-"));
    const script = path.join(root, "fixture.cjs");
    await fs.writeFile(script, fixture);
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { windowsHide: true, stdio: "ignore" });
    const pids: number[] = [];
    const run = runChildProcess(randomUUID(), process.execPath, [script, "provider", root, mode], {
      cwd: root, env: {}, timeoutSec: mode === "timeout" ? 2 : 0, graceSec: 1,
      onLog: async () => {}, onLogError: () => {},
      onSpawn: async ({ pid }) => { pids.push(pid); },
      ...(mode === "terminal completion" ? { terminalResultCleanup: {
        graceMs: 1500, hasTerminalResult: ({ stdout }: { stdout: string }) => stdout.includes("TEST_TERMINAL_RESULT"),
      } } : {}),
    });
    // Observe rejection immediately even if fixture setup itself fails.
    void run.catch(() => {});
    try {
      const provider = await readReady(path.join(root, "provider.json"));
      const leaf = await readReady(path.join(root, "leaf.json"));
      pids.push(provider.shellPid, leaf.pid);
      expect(leaf.parentPid).toBe(provider.shellPid);
      expect(pids.every(alive)).toBe(true);
      const started = Date.now();
      if (mode === "explicit stop") {
        await terminateLocalService({ pid: provider.pid, processGroupId: null }, { requireProviderTree: true });
      }
      const result = await run;
      expect(result.timedOut).toBe(mode === "timeout");
      if (mode === "terminal completion") {
        expect(result.terminalResultCleanup).toMatchObject({ kind: "terminal_result_cleanup", forceKilled: true, signal: null });
      }
      // runChildProcess must join async tree cleanup, even when its root closed first.
      expect(pids.filter(alive)).toEqual([]);
      expect(alive(unrelated.pid!)).toBe(true);
      expect(() => assertWindowsProviderProcessesStopped()).not.toThrow();
      console.info(JSON.stringify({ testFixture: true, mode, elapsedMs: Date.now() - started, observedProcesses: pids.length }));
    } finally {
      unrelated.kill();
      // No cleanup by process name/PID guessing. Failed fixtures expire themselves.
      const deadline = Date.now() + 22_000;
      while (pids.some(alive) && Date.now() < deadline) await delay(100);
      expect(pids.filter(alive)).toEqual([]);
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^paperclip-windows-tree-test-/);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
