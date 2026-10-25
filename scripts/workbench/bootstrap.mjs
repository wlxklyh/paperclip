#!/usr/bin/env node
// Local installation data lives outside this public source checkout.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
  return args[index + 1];
}
const root = path.resolve(option("--root", path.join(here, "../../../..")));
const base = new URL(option("--url", "http://127.0.0.1:3100"));
if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(base.hostname) || base.protocol !== "http:") {
  throw new Error("This bootstrap only supports a local loopback Paperclip instance.");
}
const codex = option("--codex", process.env.WORKBENCH_CODEX_COMMAND);
if (!codex || !path.isAbsolute(codex) || !existsSync(codex) || !/\.(exe|cmd)$/i.test(codex)) {
  throw new Error("Pass --codex with an existing absolute official Codex .exe or .cmd path.");
}
const model = option("--model", process.env.WORKBENCH_CODEX_MODEL);
const windowsSandbox = option("--windows-sandbox", undefined);
if (windowsSandbox && !["elevated", "unelevated"].includes(windowsSandbox)) {
  throw new Error("--windows-sandbox must be elevated or unelevated.");
}
const configDir = path.join(root, "config");
const statePath = path.join(configDir, "workbench.json");
await mkdir(configDir, { recursive: true });
let state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : {
  version: 1, baseUrl: base.origin, agents: {}, projects: {}, createdAt: new Date().toISOString(),
};
if (state.baseUrl !== base.origin) throw new Error("The saved workbench belongs to another URL.");
async function save() {
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}
async function api(method, route, body) {
  const response = await fetch(new URL(`/api${route}`, base), {
    method, headers: { "Content-Type": "application/json", Origin: base.origin },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 1500)}`);
  return text ? JSON.parse(text) : null;
}
const health = await api("GET", "/health");
if (health.status !== "ok" || health.deploymentMode !== "local_trusted") {
  throw new Error("Bootstrap requires the healthy dedicated local-trusted workbench.");
}
const marker = "[workbench:four-roles-v1]";
if (!state.companyId) {
  const matches = (await api("GET", "/companies")).filter(c => c.description?.includes(marker));
  if (matches.length > 1) throw new Error("Multiple matching companies; select an installation explicitly.");
  const company = matches[0] ?? await api("POST", "/companies", {
    name: "AI 工作台", description: `${marker} 跨项目四岗位协作；本机开发与测试。`,
    defaultResponsibleUserId: "local-board",
  });
  state.companyId = company.id;
  state.companyPrefix = company.issuePrefix;
  await save();
}
const company = await api("GET", `/companies/${state.companyId}`);
if (!company.description?.includes(marker)) throw new Error("Saved company does not belong to this bootstrap.");
const common = await readFile(path.join(here, "roles/common.md"), "utf8");
const roles = [
  { key: "product-manager", name: "产品经理", role: "ceo", capabilities: "明确目标与验收标准，拆解、分派和跟进跨岗位任务" },
  { key: "developer", name: "开发工程师", role: "engineer", capabilities: "软件、接口、插件和工具开发，测试、修复与交付" },
  { key: "it-steward", name: "IT 管家", role: "devops", capabilities: "本机只读盘点、环境诊断、整理和维护方案；具体设备变更另按任务授权" },
  { key: "workflow-engineer", name: "AI 工作流工程师", role: "engineer", capabilities: "模型、技能、工具、人工节点编排，可重复流程与效果评估" },
];
const existing = await api("GET", `/companies/${state.companyId}/agents`);
for (const role of roles) {
  const matches = existing.filter(a => a.metadata?.workbenchRole === role.key);
  if (matches.length > 1) throw new Error(`Ambiguous role: ${role.key}`);
  let agent = matches[0];
  if (agent && (agent.adapterType !== "codex_local"
      || agent.adapterConfig?.engine !== "cli" || agent.adapterConfig?.command !== codex
      || (model && agent.adapterConfig?.model !== model))) {
    throw new Error(`Role ${role.key} has different runtime settings. Review/update that agent in Paperclip before rerunning; bootstrap will not overwrite customizations.`);
  }
  if (!agent) {
    const cwd = path.join(root, "runtime", "agent-homes", role.key);
    await mkdir(cwd, { recursive: true });
    agent = await api("POST", `/companies/${state.companyId}/agents`, {
      name: role.name, title: role.name, role: role.role, capabilities: role.capabilities,
      reportsTo: role.key === "product-manager" ? null : state.agents["product-manager"],
      adapterType: "codex_local", runner: "legacy",
      adapterConfig: {
        engine: "cli", command: codex, cwd, ...(model ? { model } : {}),
        dangerouslyBypassApprovalsAndSandbox: false,
        extraArgs: ["-c", 'approval_policy="never"', "--sandbox", "workspace-write",
          ...(windowsSandbox ? ["-c", `windows.sandbox="${windowsSandbox}"`] : []),
          "--skip-git-repo-check"],
        timeoutSec: 1200,
      },
      instructionsBundle: { entryFile: "AGENTS.md", files: {
        "AGENTS.md": await readFile(path.join(here, `roles/${role.key}.md`), "utf8"),
        "COMMON.md": common,
      } },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: { canCreateAgents: false },
      metadata: { workbenchRole: role.key },
    });
  }
  state.agents[role.key] = agent.id;
  await save();
  console.log(`岗位就绪：${role.name}`);
}
const projectDefinitions = [
  { key: "software-pilot", name: "软件交付验证", description: "独立测试项目：任务摘要工具、代码交付与独立复核。" },
  { key: "operations-pilot", name: "IT 与工作流验证", description: "独立测试项目：本机只读盘点、报告与可重复工作流。" },
];
for (const definition of projectDefinitions) {
  if (state.projects[definition.key]) {
    await api("GET", `/projects/${state.projects[definition.key].id}`);
    continue;
  }
  const cwd = path.join(root, "projects", definition.key);
  await mkdir(cwd, { recursive: true });
  const project = await api("POST", `/companies/${state.companyId}/projects`, {
    name: definition.name, description: definition.description, status: "in_progress",
    leadAgentId: state.agents["product-manager"],
    idempotencyKey: `workbench-v1:${definition.key}`,
    workspace: { name: definition.name, sourceType: "non_git_path", cwd, isPrimary: true },
    executionWorkspacePolicy: {
      enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize",
      workspaceStrategy: { type: "project_primary" },
    },
  });
  const detailed = await api("GET", `/projects/${project.id}`);
  const workspace = detailed.workspaces?.find(w => w.isPrimary) ?? detailed.workspaces?.[0];
  if (!workspace) throw new Error(`Project ${project.id} has no confirmed workspace`);
  state.projects[definition.key] = { id: project.id, workspaceId: workspace.id, cwd };
  await save();
  console.log(`项目就绪：${definition.name}`);
}
console.log(`配置已保存：${statePath}`);
console.log(`管理界面：${base.origin}/${state.companyPrefix}/dashboard`);
console.log("尚未创建或启动任务；下一步进行真实运行验证。");
