import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexRuntimeHome } from "./runtime-home.js";

describe("Codex runtime home", () => {
  const companyHome = path.join("E:/LAB/agent-workbench/runtime/paperclip/instances/default/companies",
    "11111111-1111-4111-8111-111111111111", "codex-home");
  const agent = "22222222-2222-4222-8222-222222222222";
  const digest = "a".repeat(64);

  it("leaves room for SQLite WAL/SHM names on the observed Windows installation", () => {
    const runtime = resolveCodexRuntimeHome(companyHome, "skill-runtimes", agent, digest, "win32");
    expect(path.join(runtime, "thread_history_1.sqlite-wal").length).toBeLessThan(260);
    expect(path.join(runtime, "thread_history_1.sqlite-shm").length).toBeLessThan(260);
    expect(path.relative(companyHome, runtime)).not.toMatch(/^\.\./);
    expect(path.basename(runtime)).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveCodexRuntimeHome(companyHome, "skill-runtimes", agent, digest, "win32")).toBe(runtime);
  });

  it("keeps agent, assignment/config identity and runtime kind isolated", () => {
    const homes = [
      resolveCodexRuntimeHome(companyHome, "skill-runtimes", agent, digest, "win32"),
      resolveCodexRuntimeHome(companyHome, "skill-runtimes", "other-agent", digest, "win32"),
      resolveCodexRuntimeHome(companyHome, "skill-runtimes", agent, "b".repeat(64), "win32"),
      resolveCodexRuntimeHome(companyHome, "connector-runtimes", agent, digest, "win32"),
      resolveCodexRuntimeHome(companyHome + "-other-company", "skill-runtimes", agent, digest, "win32"),
    ];
    expect(new Set(homes).size).toBe(homes.length);
  });

  it.each(["linux", "darwin"] as const)("preserves the existing %s layout", (platform) => {
    expect(resolveCodexRuntimeHome(companyHome, "skill-runtimes", agent, digest, platform))
      .toBe(path.join(companyHome, "skill-runtimes", agent, digest));
  });
});
