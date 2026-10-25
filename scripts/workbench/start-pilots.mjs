#!/usr/bin/env node
// Starts real local model work. The manifest and receipts stay outside this repo.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = path.resolve(rootIndex < 0
  ? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
  : args[rootIndex + 1] ?? "");
if (!args.includes("--start")) throw new Error("Pass --start to create assignments and run the official Codex CLI.");
const state = JSON.parse(await readFile(path.join(root, "config/workbench.json"), "utf8"));
const base = new URL(state.baseUrl);
if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
  throw new Error("Pilot setup is restricted to the local workbench.");
}
async function api(method, route, body) {
  const response = await fetch(new URL(`/api${route}`, base), {
    method, headers: { "Content-Type": "application/json", Origin: base.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${(await response.text()).slice(0, 1200)}`);
  return response.json();
}
const health = await api("GET", "/health");
if (health.status !== "ok" || health.deploymentMode !== "local_trusted") {
  throw new Error("Expected the healthy dedicated local-trusted workbench.");
}
const company = await api("GET", `/companies/${state.companyId}`);
if (!company.description?.includes("[workbench:four-roles-v1]")) throw new Error("Company ownership marker is missing.");
const definitions = [
  {
    key: "software-v1", project: "software-pilot", role: "product-manager",
    title: "[真实试点] 交付离线任务汇总工具与重复验证流程",
    description: `这是已授权的本机开发与测试，请实际分派并交付，不只提供方案。你是产品经理，先保存简短 plan 文档，再创建有 parentId、同一 projectId/projectWorkspaceId、唯一 idempotencyKey 的子任务。

目标：在本项目工作区交付 Node.js 内置模块实现的离线 CLI，从 JSON 任务列表生成中文 Markdown 报告。仅处理显式传入的本地输入与输出文件，无网络、无安装新依赖、无全局设置修改。

验收：
1. 输入是任务数组，字段 id、title、status、assignee（可缺省），status 支持 todo/in_progress/blocked/done。统计总数与各状态数，列出阻塞任务和负责人；空数组产生有效空报告。
2. 无效 JSON、未知状态、重复 id、缺失必填字段必须以非零退出码给出可读错误，失败不覆盖已有输出。标题和负责人含 Markdown 特殊字符时报告仍可读。
3. 交付实现、至少两组示例输入、覆盖有效/空/失败不覆盖输出的真实测试、中文 README；所有文件只在当前项目。
4. AI 工作流工程师交付一条可重复运行的命令：验证输入→运行工具→执行检查→产生结果与流程版本报告；连续运行两次得到一致的业务输出，无重复累积。
5. 关键代码交付需独立会话复核。可给开发子任务配置 executionPolicy 的 review stage，参与者为 AI 工作流工程师；再分派独立流程实现任务。复核提出实际发现，若有问题退回修改并复验，不编造缺陷。

分工：开发工程师 ${state.agents.developer} 写工具和测试；AI 工作流工程师 ${state.agents["workflow-engineer"]} 独立复核并编排流程；你负责明确验收、分派与汇总。子任务 assigneeAdapterOverrides.useProjectWorkspace=true，避免落在岗位默认目录。不自行招聘。

使用 Paperclip API 的当前 agent 身份与 run header，按注入技能操作。交付至少保存版本化 issue document，并上传/登记实际文件或 workspace_file work product；最终评论包含可打开的成果链接与真实检查结果。依赖子任务时保存现场并退出，由依赖事件继续，不轮询、不把已分派当完成。当前范围无需新增人审。`,
  },
  {
    key: "operations-v1", project: "operations-pilot", role: "it-steward",
    title: "[真实试点] 本机只读环境盘点与维护建议",
    description: `实际完成一次有限范围只读盘点，并将中文报告写到当前项目工作区。

允许读取：操作系统版本、CPU 型号、内存容量、逻辑磁盘容量/可用空间，node/git/pwsh 的版本，当前项目目录的文件清单；不扫描用户其他目录，不读取凭据、环境变量值、浏览器数据或私人文件，不连接网络设备或群晖，不移动/删除文件，不更改系统或服务。

交付：inventory.json（采集时间、每项事实及来源命令、读取失败也如实记录）、REPORT.md（事实、限制、按优先级排列的维护建议）以及可重复运行的只读采集脚本。只允许向本项目工作区写这些交付文件；建议不等于执行变更。报告应说明目前没有 NAS 接入证据。

验证：运行采集脚本，检查 JSON 可解析、必填项存在、报告引用真实数据。保存版本化 issue document 并上传/登记实际文件；评论提供可打开的成果与验证证据。若事实无误按本任务的复核阶段交产品经理独立检查。已授权本机只读工作不再请求批准。`,
    executionPolicy: {
      mode: "normal", commentRequired: true,
      stages: [{ type: "review", approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: state.agents["product-manager"] }] }],
    },
  },
];
const receipts = [];
for (const item of definitions) {
  const project = state.projects[item.project];
  const issue = await api("POST", `/companies/${state.companyId}/issues`, {
    title: item.title, description: item.description, status: "todo", priority: "medium",
    projectId: project.id, projectWorkspaceId: project.workspaceId,
    assigneeAgentId: state.agents[item.role], assigneeAdapterOverrides: { useProjectWorkspace: true },
    idempotencyKey: `workbench-pilot:${item.key}`,
    ...(item.executionPolicy ? { executionPolicy: item.executionPolicy } : {}),
  });
  receipts.push({ key: item.key, id: issue.id, identifier: issue.identifier, projectId: issue.projectId });
  console.log(`${issue.identifier}: ${issue.title}`);
}
await mkdir(path.join(root, "evidence"), { recursive: true });
await writeFile(path.join(root, "evidence/pilot-assignments.json"), JSON.stringify({ createdAt: new Date().toISOString(), receipts }, null, 2) + "\n");
console.log("Assignments submitted. Their actual run results must be verified separately.");
