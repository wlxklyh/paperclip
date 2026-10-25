#!/usr/bin/env node
// Explicit TEST drill with real Codex roles. Only --start writes to the API.
// No service control, private credential reads, board approvals, or manual wakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const modes = ["--prepare", "--start", "--collect"];
const mode = modes.find((item) => args.includes(item));
if (args.includes("--help") || !mode) {
  console.log(`Usage: node scripts/workbench/start-rework-test.mjs <mode> [--root <workbench-root>]
  --prepare  Read configuration/API and save the TEST contract, validator and request. No task/run creation.
  --start    Require completed AI-1/AI-5 and no company live runs; create one idempotent TEST assignment.
  --collect  Read evidence once. Never approve, reassign, retry, or wake an agent.
All deliverables stay in software-pilot/verification/rework-contract-v1.
Evidence stays outside this source checkout in evidence/rework-contract-v1.
Wait for the coordinating operator's start notification before --start.`);
  process.exit(0);
}
assert.equal(modes.filter((item) => args.includes(item)).length, 1, "Choose exactly one mode");
const rootArg = args.indexOf("--root");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(rootArg < 0 ? path.join(here, "../../../..") : args[rootArg + 1] ?? "");
const state = JSON.parse(await readFile(path.join(root, "config/workbench.json"), "utf8"));
const base = new URL(state.baseUrl);
assert(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
assert(!base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
const project = state.projects["software-pilot"];
const ownerId = state.agents.developer;
const reviewerId = state.agents["workflow-engineer"];
assert(ownerId && reviewerId && ownerId !== reviewerId);
const projectRoot = path.resolve(project.cwd);
assert.equal(projectRoot.toLowerCase(), path.resolve(root, "projects/software-pilot").toLowerCase());
const taskRoot = path.join(projectRoot, "verification/rework-contract-v1");
const evidenceRoot = path.join(root, "evidence/rework-contract-v1");
const marker = "[TEST rework-contract-v1]";
const title = "[TEST] 版本清单缺字段返工演练";
const key = "workbench-test:software-rework-contract-v1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stamp = () => new Date().toISOString().replaceAll(":", "-");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
async function maybeJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function safeDirectory(directory, allowedRoot) {
  const relative = path.relative(allowedRoot, directory);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  let current = allowedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { assert(!(await lstat(current)).isSymbolicLink(), `Refuse linked output directory: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(current); }
  }
  assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase(), "Output path must remain local");
}
async function writeOnce(file, contents) {
  try { await writeFile(file, contents, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(await readFile(file, "utf8"), contents, `Existing prepared file differs: ${file}`);
  }
}
async function api(route, body) {
  if (body !== undefined) assert.equal(mode, "--start", "Only start may create the assignment");
  const res = await fetch(new URL(`/api${route}`, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${body === undefined ? "GET" : "POST"} ${route}: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const health = await api("/health");
assert(health.status === "ok" && health.deploymentMode === "local_trusted", "Expected the dedicated local workbench");
const company = await api(`/companies/${state.companyId}`);
assert(company.description?.includes("[workbench:four-roles-v1]"));
const projects = await api(`/companies/${state.companyId}/projects`);
const remoteProject = projects.find((item) => item.id === project.id);
assert(remoteProject, "Software pilot project is missing");
const workspace = remoteProject.workspaces.find((item) => item.id === project.workspaceId);
assert(workspace && path.resolve(workspace.cwd).toLowerCase() === projectRoot.toLowerCase());
const agents = await api(`/companies/${state.companyId}/agents`);
for (const id of [ownerId, reviewerId]) {
  const agent = agents.find((item) => item.id === id);
  assert(agent?.adapterType === "codex_local" && agent.adapterConfig?.engine === "cli");
  assert(/[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]codex\.exe$/i.test(agent.adapterConfig.command), "Expected installed official desktop Codex executable");
  assert.equal(agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox, false);
  assert.equal(agent.runtimeConfig?.heartbeat?.wakeOnDemand, true);
}
await safeDirectory(taskRoot, projectRoot);
await safeDirectory(evidenceRoot, root);

const validator = `// TEST contract oracle, prepared by the acceptance harness. Do not edit during the drill.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
async function confined(arg) {
  if (!arg) throw new Error('Input and output paths are required');
  const candidate = path.resolve(root, arg), rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must remain inside the TEST directory');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked paths are not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return candidate;
}
try {
  if (process.argv.length !== 4) throw new Error('Usage: node verify-candidate.mjs <candidate-relative-path> <output-relative-path>');
  const input = await confined(process.argv[2]), output = await confined(process.argv[3]);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error('Input and output must differ');
  const candidate = JSON.parse(await fs.readFile(input, 'utf8'));
  if (candidate.fixture !== 'TEST intentional missing workflowVersion' || candidate.schemaVersion !== 1) throw new Error('Unexpected TEST fixture identity');
  if (typeof candidate.workflowVersion !== 'string' || !/^\\d+\\.\\d+\\.\\d+$/.test(candidate.workflowVersion)) throw new Error('Required workflowVersion must be a semantic version, e.g. 1.0.0');
  // No output operation occurs before the full contract check succeeds.
  await fs.writeFile(output, JSON.stringify({ verified: true, schemaVersion: 1, workflowVersion: candidate.workflowVersion }, null, 2) + '\\n');
  console.log('TEST candidate accepted');
} catch (error) {
  console.error('TEST validation failed: ' + error.message);
  process.exitCode = 2;
}
`;
const contract = `${marker}\n\n这是刻意缺字段的负向测试夹具，不能描述为 AI-4 或真实产品的缺陷。\n\n唯一允许写入目录：${taskRoot}\n\n固定契约：candidate-v1.json 必须恰为对象 {"fixture":"TEST intentional missing workflowVersion","schemaVersion":1}，故意没有 workflowVersion；candidate-v2.json 必须保留上述两字段并补充 "workflowVersion":"1.0.0"。v1 一经交付不得覆盖。\n\nverify-candidate.mjs 是演练的固定校验器，不得改动。任何候选缺少有效 workflowVersion 时，校验命令必须退出 2、stderr 包含 workflowVersion，并且已经存在的输出文件字节完全不变。合格 v2 返回 0 并生成确定性结果。\n\n所有路径参数相对于本 TEST 目录。命令：node verification/rework-contract-v1/verify-candidate.mjs candidate-v1.json review-v1-output.json。\n\n同一 issue 的原生 review stage 承载退回和再复核；所有 API 使用当前真实 agent/run 身份。没有人工审批或真实外部动作，不允许假冒 local-board，不修改 AI-1/AI-4/AI-5 或已有交付。\n`;
const description = `${marker}
这是已授权的真实 Codex 岗位返工验收，使用刻意缺 workflowVersion 的测试夹具，绝不是产品缺陷。独立任务，不修改或重开 AI-1、AI-4、AI-5，不创建子任务或新岗位。

工作区是 ${projectRoot}，但只允许写 ${taskRoot} 内的交付、临时文件和日志。不得修改现有 CLI、README、报告、源码包、主流程或该 TEST 目录以外的文件。不得联网访问业务服务、安装依赖、改全局设置或读取私有凭据。Paperclip API 正常使用注入的当前 agent/run 身份；不能借用 board 身份。先读 CONTRACT.md；固定 verify-candidate.mjs 不得改动，它由验收脚本准备。仅用 Node 内置模块和本机 PowerShell。

执行者是开发工程师 ${ownerId}；唯一原生复核者是 AI 工作流工程师 ${reviewerId}。本次刻意需要一次真实 changes_requested 和两次独立复核，不能在同一执行回合把 v1 自动修好，更不能伪造复核决定。复核只检查实际输入和真实命令结果，不能为了满足脚本捏造失败。

阶段一（开发，初始执行）：
1. 创建不可覆盖的 candidate-v1.json，内容恰为 {"fixture":"TEST intentional missing workflowVersion","schemaVersion":1}。这是明示的负向夹具；不要添加 workflowVersion，也不要提前创建 v2。
2. 独立创建 owner-v1-output.json 哨兵输出，真实运行 node verification/rework-contract-v1/verify-candidate.mjs candidate-v1.json owner-v1-output.json。记录退出 2、包含 workflowVersion 的 stderr、输出前后 SHA-256 完全相同及候选/校验器 SHA。把命令、exitCode、stdout/stderr、beforeOutputSha256、afterOutputSha256、candidateSha256、validatorSha256、runId、agentId 保存 owner-v1-result.json；不把预期当实测。
3. 保存当前任务文档 key=delivery（第1个 revision），准确说明负向候选待复核，包含 v1 SHA、当前 runId、文件链接；登记 workspace_file work product。PATCH 当前 issue {status:"in_review",comment:"TEST v1 intentionally lacks workflowVersion; submit actual negative fixture for independent review. ...证据..."}，交接后结束本次执行，不自行继续。

阶段二（工作流工程师，第1次原生 review wake）：
1. GET 当前 issue detail 检查 executionState.currentParticipant 是自己、returnAssignee 是开发工程师。独立读取 candidate-v1.json 与 CONTRACT.md/校验器；不得修文件，不提前生成 v2。
2. 新建 review-v1-output.json 哨兵，自己真实运行校验命令并保存 review-v1-result.json，字段同 owner-v1-result.json。应观察 exitCode=2、stderr含 workflowVersion、前后输出SHA一致；如果实际不符，诚实报告，不能编造结果。
3. 保存文档 review-v1，绑定 v1 SHA 和 delivery 第1 revision、独立 runId。把明确补齐 workflowVersion 的要求通过 PATCH 当前 issue {status:"in_progress",comment:"Changes requested [TEST intentional fixture]: workflowVersion is missing; command ... exited 2; output unchanged; please create v2 preserving v1. ...证据..."} 提交。原生阶段自动记录决定并返回开发；完成该调用后立即结束，不主动派发其他任务。

阶段三（开发，真实 execution_changes_requested 唤醒）：
1. 先读当前 issue、review-v1 和原生 executionState.lastDecisionOutcome=changes_requested；记录决定ID。没有实际退回不能进入此阶段。
2. 保留 candidate-v1.json 字节不变，新建 candidate-v2.json，仅加 "workflowVersion":"1.0.0"。真实运行 v2 校验并保存 owner-v2-result.json（exitCode=0、候选/校验器/输出SHA、命令、stdout/stderr、runId/agentId）；再次验证 v1 仍退出2且已有输出不变。
3. 更新同一文档 key=delivery 为第2 revision，记录v1/v2 SHA、修复对应的退回decisionId和真实结果；登记v2 work product。PATCH 当前 issue status=in_review 并评论修订证据，交接后结束。

阶段四（工作流工程师，第2次独立 review wake）：
1. 重新读取实际v2和delivery第2 revision，核对v1未变、v2只增加workflowVersion、固定校验器未改。
2. 自己实跑v1拒绝/输出不变及v2通过，把证据分别写 review-v2-negative-result.json 与 review-v2-result.json（字段同前，带本次runId）。不同角色和各阶段必须使用实际不同runId。
3. 保存文档 review-v2，引用v2 SHA和delivery第2 revision、退回决定ID、真实检查结果；通过时才PATCH当前issue {status:"done",comment:"Approved [TEST]: ...真实修订与复验结果..."}。没有通过不能批准；不得代签任何人审。若再次确有问题，按原生stage退回；两轮上限交给真实责任人，不绕过。

每次API状态切换可能即时结束旧run，因此先保存文件、文档、work product和评论要用的证据，再作最后一次PATCH，不依赖PATCH之后写回执。平台有实际run、activity和decision证据；不要求把交接引起的issue_reassigned取消伪装成succeeded。

验收范围：至少四次真实官方Codex角色run；初交→独立退回→修订→独立通过；同一stage、两版文档revision、实际SHA与命令退出码、失败不覆盖输出。只证明测试校验失败处理和原生返工，不证明provider崩溃恢复、任意shell安全治理或真人批准。`;
const request = {
  title, description, status: "todo", priority: "medium", projectId: project.id,
  projectWorkspaceId: project.workspaceId, assigneeAgentId: ownerId,
  assigneeAdapterOverrides: { useProjectWorkspace: true }, idempotencyKey: key,
  executionPolicy: { mode: "normal", commentRequired: true, maxReviewRounds: 2,
    stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewerId }] }] },
};
const manifestFile = path.join(evidenceRoot, "manifest.json");
let manifest = await maybeJson(manifestFile);
if (manifest) {
  assert.equal(manifest.companyId, state.companyId);
  assert.equal(manifest.projectId, project.id);
  assert.equal(manifest.idempotencyKey, key);
}

if (mode === "--prepare") {
  await writeOnce(path.join(taskRoot, "CONTRACT.md"), contract);
  await writeOnce(path.join(taskRoot, "verify-candidate.mjs"), validator);
  await writeOnce(path.join(evidenceRoot, "request.json"), encode(request));
  if (!manifest) {
    manifest = { version: 1, marker, baseUrl: base.origin, companyId: state.companyId,
      projectId: project.id, workspaceId: project.workspaceId, taskRoot,
      ownerId, reviewerId, idempotencyKey: key, preparedAt: new Date().toISOString(),
      validatorSha256: sha(validator), contractSha256: sha(contract), requestSha256: sha(encode(request)),
      sourceCommit: health.commit, issueId: null, startedAt: null };
    await writeFile(manifestFile, encode(manifest), { flag: "wx" });
  }
  console.log(JSON.stringify({ prepared: true, apiWrites: 0, taskRoot, evidenceRoot, next: "Wait for operator start notification; then --start" }));
  process.exit(0);
}
assert(manifest, "Run --prepare before starting or collecting");
assert.equal(sha(await readFile(path.join(taskRoot, "verify-candidate.mjs"))), manifest.validatorSha256, "Fixed validator changed");
assert.equal(sha(await readFile(path.join(taskRoot, "CONTRACT.md"))), manifest.contractSha256, "Fixed TEST contract changed");

if (mode === "--start") {
  if (manifest.issueId) {
    const existing = await api(`/issues/${manifest.issueId}`);
    assert(existing.description?.includes(marker) && existing.projectId === project.id);
    console.log(JSON.stringify({ alreadyCreated: true, issueId: existing.id, identifier: existing.identifier, status: existing.status, noWakeRequested: true }));
    process.exit(0);
  }
  const existingIssues = await api(`/companies/${state.companyId}/issues`);
  const matches = existingIssues.filter((issue) => issue.title === title && issue.projectId === project.id);
  assert(matches.length <= 1, "More than one TEST assignment found; inspect instead of creating another");
  if (matches.length) {
    const existing = await api(`/issues/${matches[0].id}`);
    assert(existing.description?.includes(marker), "Existing title belongs to another task");
    manifest.issueId = existing.id; manifest.identifier = existing.identifier;
    manifest.recoveredAt = new Date().toISOString();
    await writeFile(manifestFile, encode(manifest));
    console.log(JSON.stringify({ recoveredExisting: true, issueId: existing.id, identifier: existing.identifier, noWakeRequested: true }));
    process.exit(0);
  }
  const gate = [];
  for (const identifier of ["AI-1", "AI-5"]) {
    const issue = await api(`/issues/${identifier}`);
    assert.equal(issue.projectId, project.id);
    assert.equal(issue.status, "done", `${identifier} must finish before TEST launch`);
    assert(!issue.executionRunId && !issue.checkoutRunId, `${identifier} still holds an execution lock`);
    gate.push({ id: issue.id, identifier, status: issue.status, updatedAt: issue.updatedAt });
  }
  const live = await api(`/companies/${state.companyId}/live-runs?minCount=0&limit=50`);
  assert(Array.isArray(live) && live.length === 0, "Company has live/queued runs; defer the TEST launch");
  for (const issue of existingIssues.filter((item) => item.projectId === project.id)) {
    assert(!issue.activeRun && !issue.executionRunId && !issue.checkoutRunId, `Software task ${issue.identifier} still holds a run`);
  }
  const requestText = await readFile(path.join(evidenceRoot, "request.json"), "utf8");
  assert.equal(sha(requestText), manifest.requestSha256, "Prepared assignment changed; inspect first");
  await writeFile(path.join(evidenceRoot, `launch-gate-${stamp()}.json`), encode({ at: new Date().toISOString(), gate, liveRuns: live, sourceCommit: health.commit }));
  // The API's principal-scoped idempotency key survives a lost create response.
  // On an unknown result, rerun --start unchanged; never invent another key.
  const issue = await api(`/companies/${state.companyId}/issues`, JSON.parse(requestText));
  assert(issue.id && issue.projectId === project.id && issue.description?.includes(marker));
  manifest.issueId = issue.id; manifest.identifier = issue.identifier; manifest.startedAt = new Date().toISOString();
  await writeFile(manifestFile, encode(manifest));
  await writeFile(path.join(evidenceRoot, "creation-receipt.json"), encode(issue));
  console.log(JSON.stringify({ created: true, issueId: issue.id, identifier: issue.identifier, url: `${base.origin}/${company.issuePrefix}/issues/${issue.identifier}` }));
  process.exit(0);
}

assert(manifest.issueId, "No TEST assignment has been started");
const issueId = manifest.issueId;
const routes = [`/issues/${issueId}`, `/issues/${issueId}/comments`, `/issues/${issueId}/activity`, `/issues/${issueId}/runs`, `/issues/${issueId}/documents`, `/issues/${issueId}/work-products`];
const fetched = await Promise.allSettled(routes.map((route) => api(route)));
for (let i = 0; i < fetched.length; i++) if (fetched[i].status !== "fulfilled") throw new Error(`Evidence fetch failed ${routes[i]}: ${fetched[i].reason}`);
const [issue, comments, activity, runs, documents, workProducts] = fetched.map((result) => result.value);
assert(issue.description?.includes(marker) && issue.projectId === project.id && issue.companyId === state.companyId);
const snapshotRoot = path.join(evidenceRoot, "snapshots", stamp());
await safeDirectory(snapshotRoot, evidenceRoot);
const revisions = {};
for (const doc of documents) revisions[doc.key] = await api(`/issues/${issueId}/documents/${encodeURIComponent(doc.key)}/revisions`);
const decisions = new Map();
for (const event of activity) {
  const change = event.details?.changes?.executionState;
  const s = change?.to;
  // Later resubmission carries the previous decision ID. Attribute the decision
  // only to the actual transition that first changed it, never the next owner.
  if (s?.lastDecisionId && s.lastDecisionId !== change?.from?.lastDecisionId
    && !decisions.has(s.lastDecisionId)) decisions.set(s.lastDecisionId, {
    id: s.lastDecisionId, outcome: s.lastDecisionOutcome, actorType: event.actorType,
    agentId: event.agentId, runId: event.runId, at: event.createdAt,
    stageId: s.currentStageId ?? change?.from?.currentStageId ?? null,
    returnAssignee: s.returnAssignee, state: s.status, changesRequestedCount: s.changesRequestedCount,
  });
}
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), "TEST deliverable contains an unexpected link");
    if (entry.isDirectory()) await inventory(file);
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      files.push({ path: path.relative(taskRoot, file).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
}
await inventory(taskRoot);
const runDetailResults = await Promise.allSettled(runs.map((run) => api(`/heartbeat-runs/${run.runId}`)));
for (let i = 0; i < runDetailResults.length; i++) {
  if (runDetailResults[i].status !== "fulfilled") throw new Error(`Run evidence fetch failed: ${runs[i].runId}`);
}
const runSummaries = runs.map((run, index) => {
  const detail = runDetailResults[index].value;
  const context = detail.contextSnapshot ?? {};
  return { runId: run.runId, agentId: run.agentId, adapterType: run.adapterType,
  runtimeMode: run.runtimeMode, status: run.status, errorCode: run.errorCode,
  startedAt: run.startedAt, finishedAt: run.finishedAt, invocationSource: run.invocationSource,
  wakeupRequestId: run.wakeupRequestId, contextIssueId: run.contextIssueId, environmentLease: run.environmentLease,
  wakeReason: context.wakeReason, wakeSource: context.source, executionStage: context.executionStage,
  processPid: detail.processPid, sessionIdBefore: detail.sessionIdBefore, sessionIdAfter: detail.sessionIdAfter,
  logSha256: detail.logSha256, logBytes: detail.logBytes };
});
const results = {};
for (const name of ["owner-v1", "review-v1", "owner-v2", "review-v2-negative", "review-v2"]) {
  results[name] = await maybeJson(path.join(taskRoot, `${name}-result.json`));
}
const candidate1 = await maybeJson(path.join(taskRoot, "candidate-v1.json"));
const candidate2 = await maybeJson(path.join(taskRoot, "candidate-v2.json"));
const candidateSha = (name) => files.find((file) => file.path === name)?.sha256;
const phases = ["owner-v1", "review-v1", "owner-v2", "review-v2"];
const checks = {
  finalApproved: issue.status === "done" && issue.executionState?.status === "completed" && issue.executionState?.lastDecisionOutcome === "approved",
  genuineAgentReturn: [...decisions.values()].some((d) => d.outcome === "changes_requested" && d.actorType === "agent" && d.agentId === reviewerId && d.returnAssignee?.agentId === ownerId),
  genuineAgentApproval: [...decisions.values()].some((d) => d.outcome === "approved" && d.actorType === "agent" && d.agentId === reviewerId),
  fourRealRoleRuns: runSummaries.filter((r) => [ownerId, reviewerId].includes(r.agentId) && r.adapterType === "codex_local").length >= 4
    && [ownerId, reviewerId].every((id) => runSummaries.filter((r) => r.agentId === id).length >= 2),
  deliveryHasTwoRevisions: (revisions.delivery?.length ?? 0) >= 2,
  bothIndependentReviewDocuments: documents.some((d) => d.key === "review-v1" && d.createdByAgentId === reviewerId)
    && documents.some((d) => d.key === "review-v2" && d.createdByAgentId === reviewerId),
  v1RejectedWithoutOutputChange: ["owner-v1", "review-v1", "review-v2-negative"].every((key) => results[key]?.exitCode === 2
    && typeof results[key]?.beforeOutputSha256 === "string" && results[key]?.beforeOutputSha256 === results[key]?.afterOutputSha256),
  v2ActuallyAccepted: ["owner-v2", "review-v2"].every((key) => results[key]?.exitCode === 0),
  candidateContract: candidate1?.fixture === "TEST intentional missing workflowVersion" && candidate1?.schemaVersion === 1
    && !Object.hasOwn(candidate1, "workflowVersion") && Object.keys(candidate1).length === 2
    && candidate2?.fixture === candidate1.fixture && candidate2?.schemaVersion === 1
    && candidate2?.workflowVersion === "1.0.0" && Object.keys(candidate2).length === 3,
  evidenceMatchesFilesAndRuns: Object.entries(results).every(([key, result]) => {
    const expectedAgent = key.startsWith("owner") ? ownerId : reviewerId;
    const expectedCandidate = key.includes("negative") || key.endsWith("v1") ? "candidate-v1.json" : "candidate-v2.json";
    return result && result.agentId === expectedAgent && result.validatorSha256 === manifest.validatorSha256
      && result.candidateSha256 === candidateSha(expectedCandidate)
      && runSummaries.some((run) => run.runId === result.runId && run.agentId === expectedAgent && run.adapterType === "codex_local");
  }),
  fourDistinctPhaseRuns: phases.every((key) => typeof results[key]?.runId === "string")
    && new Set(phases.map((key) => results[key]?.runId)).size === 4,
  nativeStageWakeChain: runSummaries.some((run) => run.agentId === ownerId && run.wakeReason === "execution_changes_requested")
    && runSummaries.filter((run) => run.agentId === reviewerId && run.wakeReason === "execution_review_requested").length >= 2,
  noLiveTestRuns: !runSummaries.some((run) => ["queued", "running"].includes(run.status)),
};
const report = { collectedAt: new Date().toISOString(), issueId, identifier: issue.identifier, status: issue.status,
  executionState: issue.executionState, checks, decisions: [...decisions.values()], runs: runSummaries, files, results,
  currentLocks: { checkoutRunId: issue.checkoutRunId, executionRunId: issue.executionRunId },
  automaticallyComplete: Object.values(checks).every(Boolean) && !issue.checkoutRunId && !issue.executionRunId,
  requiresIndependentEvidenceInspection: true,
  limits: ["Intentionally invalid TEST fixture, not a product defect", "No human approval exercised", "No provider-crash recovery qualification", "No arbitrary-shell security enforcement claim", "Execution-policy decisions do not themselves bind file hashes"] };
for (const [name, value] of Object.entries({ issue, comments, activity, runs: runSummaries, documents, revisions, workProducts, report })) {
  await writeFile(path.join(snapshotRoot, `${name}.json`), encode(value), { flag: "wx" });
}
await writeFile(path.join(evidenceRoot, "report.json"), encode(report));
console.log(JSON.stringify({ snapshotRoot, identifier: issue.identifier, status: issue.status, checks, automaticallyComplete: report.automaticallyComplete }));
