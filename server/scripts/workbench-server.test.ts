import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { controlPaths, requestWorkbenchControl, serveWorkbench } from "./workbench-server.js";

test("Windows control authenticates, rejects duplicate startup, and awaits application teardown", { skip: process.platform !== "win32" }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-workbench-control-test-"));
  const api = net.createServer();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const port = (api.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => api.close(() => resolve()));
  const options = { repoRoot: path.resolve("."), dataRoot, port };
  let shutdownCalls = 0;
  let releaseShutdown!: () => void;
  const shutdownBarrier = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const lifecycle = await serveWorkbench(options, async () => {
    await new Promise<void>((resolve) => api.listen(port, "127.0.0.1", resolve));
    return { listenPort: port, shutdown: async () => {
      shutdownCalls++;
      await shutdownBarrier;
      await new Promise<void>((resolve) => api.close(() => resolve()));
    } };
  });
  try {
    const status = await requestWorkbenchControl(options, "status");
    assert.equal(status?.phase, "running");
    assert.equal(status?.token, undefined);
    await assert.rejects(serveWorkbench(options, async () => { throw new Error("must not start"); }), /still alive/);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(controlPaths(options).pipe);
      socket.once("connect", () => socket.write(JSON.stringify({ action: "stop", token: "wrong-test-token" }) + "\n"));
      socket.once("data", () => reject(new Error("Unauthorized request received a response.")));
      socket.once("error", reject);
      socket.once("close", resolve);
    });
    assert.equal(shutdownCalls, 0);
    let completed = false;
    const stop = requestWorkbenchControl(options, "stop").then((result) => { completed = true; return result; });
    await delay(50);
    assert.equal(shutdownCalls, 1);
    assert.equal(completed, false);
    assert.equal(fs.existsSync(controlPaths(options).record), true);
    releaseShutdown();
    const result = await stop;
    await lifecycle.stopped;
    assert.equal(result?.phase, "stopped");
    assert.equal(api.listening, false);
    assert.equal(fs.existsSync(controlPaths(options).record), false);
  } finally {
    releaseShutdown();
    if (fs.existsSync(controlPaths(options).record)) await requestWorkbenchControl(options, "stop");
    await lifecycle.stopped;
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("paperclip-workbench-control-test-"));
    fs.rmSync(dataRoot, { recursive: true });
  }
});

test("an occupied API port is never silently replaced with another", { skip: process.platform !== "win32" }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-workbench-control-test-"));
  const unrelated = net.createServer();
  await new Promise<void>((resolve) => unrelated.listen(0, "127.0.0.1", resolve));
  const options = { repoRoot: path.resolve("."), dataRoot, port: (unrelated.address() as net.AddressInfo).port };
  try {
    await assert.rejects(serveWorkbench(options, async () => { throw new Error("must not start"); }), /already occupied/);
    assert.equal(fs.existsSync(controlPaths(options).record), false);
    assert.equal(unrelated.listening, true);
  } finally {
    await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("paperclip-workbench-control-test-"));
    fs.rmSync(dataRoot, { recursive: true });
  }
});
