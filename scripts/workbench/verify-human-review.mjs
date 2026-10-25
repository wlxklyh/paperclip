#!/usr/bin/env node
// Real API/control-plane acceptance using a labelled deterministic process fixture.
// No service startup/shutdown, DB writes, impersonation headers, or local-board approval.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeControlledReceipt, receiptPath } from "./verify-human-review-action.mjs";

const args = process.argv.slice(2);
const phase = args[0];
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes("--help") || !phase) {
  console.log(`Usage (operator starts an ISOLATED authenticated/private instance first):
  node scripts/workbench/verify-human-review.mjs prepare --url http://127.0.0.1:3115 --evidence-dir <private absolute directory>
  # Operator restarts that same isolated instance; this script never controls services.
  node scripts/workbench/verify-human-review.mjs resume --url http://127.0.0.1:3115 --evidence-dir <same directory>
  node scripts/workbench/verify-human-review.mjs stages --url http://127.0.0.1:3115 --evidence-dir <same directory>

prepare creates a genuine TEST login, claims a FRESH disposable instance, and tests
agent denial, waiting/released capacity, rejection and revision invalidation.
resume requires changed serverInfo.processStartedAt, verifies persistence, then
approves ONLY the exact synthetic test revision through the TEST user's session.
stages qualifies one mandatory human approval stage through a separately admitted
agent probe and rechecks pending/rejected/expired controlled-action denials.
Credentials are private test-only data; report.json contains no credentials.
This proves API/runner behavior with a deterministic fixture, not UI/model behavior.`);
  process.exit(0);
}
assert(["prepare", "resume", "repair-rejection", "stages"].includes(phase), "Use prepare, resume, repair-rejection, or stages");
assert(option("--url") && option("--evidence-dir"), "Explicit --url and --evidence-dir are required");
const url = new URL(option("--url"));
assert.equal(url.protocol, "http:");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only a loopback disposable instance is supported");
assert(url.port && !["3000", "3100"].includes(url.port), "Shared workbench ports are forbidden");
assert.equal(url.pathname, "/");
assert(!url.username && !url.password && !url.search && !url.hash);
const base = url.origin;
const evidenceDir = path.resolve(option("--evidence-dir"));
assert(path.isAbsolute(option("--evidence-dir")), "Evidence directory must be absolute and private");
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "../..");
assert(evidenceDir.toLowerCase() !== sourceRoot.toLowerCase()
  && !evidenceDir.toLowerCase().startsWith(sourceRoot.toLowerCase() + path.sep), "Keep private evidence outside the source checkout");
await mkdir(evidenceDir, { recursive: true });
const stateFile = path.join(evidenceDir, "state.json");
const credentialsFile = path.join(evidenceDir, "credentials.private.json");
let state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : null;
if (!state) {
  assert.equal(phase, "prepare", "Prepare first");
  const id = randomUUID();
  state = { version: 1, id, base, marker: `[TEST human-review ${id}]`, issues: {}, checks: [], startedAt: new Date().toISOString() };
}
assert.equal(state.base, base, "Saved evidence belongs to another instance URL");
assert(state.marker === `[TEST human-review ${state.id}]`, "Invalid test marker");
const attempt = { phase, at: new Date().toISOString(), status: "running" };
const cookieJar = new Map();
async function save() {
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify({
    fixture: "real-api-and-process-adapter-with-synthetic-worker", base, marker: state.marker,
    sourceCommit: state.sourceCommit, userId: state.userId, companyId: state.companyId, agentId: state.agentId,
    issues: state.issues, checks: state.checks, preparedAt: state.preparedAt, completedAt: state.completedAt,
    observations: state.observations ?? [],
    executionPolicyStage: state.executionPolicyStage ?? null,
    limits: ["No browser UI acceptance", "No real model/provider execution", "No automatic service control",
      ...(state.executionPolicyStage?.completedAt ? [] : ["No executionPolicy stage qualification"]),
      "Execution-policy qualification covers one human approval stage, not multi-stage or human-requested-rework cycles",
      "No arbitrary-shell or external-action sandbox qualification",
      "Receipt gate validates at admission; not a transaction spanning server state and external effects",
      "Server restarted while the reviewed source runs had released; no mid-provider-run recovery qualification"],
  }, null, 2) + "\n", { mode: 0o600 });
}
async function check(name, detail = {}) {
  state.checks.push({ name, passedAt: new Date().toISOString(), ...detail });
  await save();
  console.log(`PASS ${name}`);
}
async function request(method, route, body, allowed = [200, 201, 202]) {
  const response = await fetch(`${base}/api${route}`, {
    method, headers: { "Content-Type": "application/json", Origin: base,
      ...(cookieJar.size ? { Cookie: [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000), redirect: "error",
  });
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(";", 1)[0]; const split = first.indexOf("=");
    if (split > 0) cookieJar.set(first.slice(0, split), first.slice(split + 1));
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${route}: non-JSON ${response.status}`); }
  if (!allowed.includes(response.status)) throw new Error(`${method} ${route}: ${response.status} ${data?.error ?? "unexpected response"}`);
  return { status: response.status, data };
}
const api = async (...input) => (await request(...input)).data;
function actionInput(scenario) {
  return { baseUrl: base, issueId: scenario.issueId, interactionId: scenario.interactionId,
    expectedRevisionId: scenario.revisionId, expectedReviewerId: state.userId, expectedCompanyId: state.companyId,
    marker: state.marker, receiptDir: path.join(evidenceDir, "receipts"),
    authentication: { sessionCookie: [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ") } };
}
async function deniedAction(scenario, status) {
  await assert.rejects(() => executeControlledReceipt(actionInput(scenario)), { code: `confirmation-${status}` });
  assert(!existsSync(receiptPath(path.join(evidenceDir, "receipts"), scenario.issueId, scenario.revisionId)), "Denied action unexpectedly left a receipt");
  await check(`controlled-action-${status}-denied-without-receipt`, { issueId: scenario.issueId, revisionId: scenario.revisionId });
}
async function waitForRework(scenario) {
  return poll("rejected task has a durable rework wait", async () => {
    const cards = await api("GET", `/issues/${scenario.issueId}/interactions`);
    const question = cards.find(entry => entry.idempotencyKey === `verify-rework:${scenario.interactionId}` && entry.status === "pending");
    if (!question?.sourceRunId) return false;
    const run = await api("GET", `/heartbeat-runs/${question.sourceRunId}`);
    const issue = await api("GET", `/issues/${scenario.issueId}`);
    if (run.status !== "succeeded" || issue.status !== "in_review" || issue.executionRunId || issue.checkoutRunId) return false;
    scenario.reworkInteractionId = question.id;
    scenario.repairRunId = run.id;
    return true;
  });
}
async function poll(label, fn, timeout = 150_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error(`Timeout: ${label}; preserve evidence and inspect the test run, do not count a retry as resolution`);
}
async function cardFor(issueId, interactionId) {
  const cards = await api("GET", `/issues/${issueId}/interactions`);
  const card = cards.find(entry => entry.id === interactionId);
  assert(card, "Saved interaction is missing");
  return card;
}
async function pendingAndReleased(issueId) {
  return poll(`pending card and released run for ${issueId}`, async () => {
    const cards = await api("GET", `/issues/${issueId}/interactions`);
    const card = cards.find(entry => entry.kind === "request_confirmation" && entry.status === "pending"
      && entry.createdByAgentId === state.agentId && entry.idempotencyKey?.startsWith("verify-human-review:"));
    if (!card?.sourceRunId) return null;
    const run = await api("GET", `/heartbeat-runs/${card.sourceRunId}`);
    if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`Fixture source run ${run.id} ended ${run.status}`);
    const issue = await api("GET", `/issues/${issueId}`);
    if (run.status !== "succeeded" || !run.finishedAt || issue.executionRunId || issue.checkoutRunId) return null;
    const workerFile = path.join(evidenceDir, `worker-${run.id}.json`);
    if (!existsSync(workerFile)) return null;
    const worker = JSON.parse(await readFile(workerFile, "utf8"));
    assert.equal(worker.agentSelfApproval?.code, "interaction_human_only");
    assert.equal(worker.agentSelfApproval?.status, 403);
    assert.equal(worker.agentDirectReviewCompletion?.code, "review_policy_denied");
    assert.equal(worker.agentDirectReviewCompletion?.status, 403);
    assert.equal(worker.pendingControlledAction, "denied");
    assert.equal(card.effectiveResolverPolicy, "human_only");
    assert.equal(card.addresseeUserId, state.userId);
    assert.equal(issue.status, "in_review");
    return { issueId, interactionId: card.id, sourceRunId: run.id, sourceRunFinishedAt: run.finishedAt,
      documentId: card.payload.target.documentId, revisionId: card.payload.target.revisionId,
      revisionNumber: card.payload.target.revisionNumber };
  });
}
async function createScenario(key) {
  if (!state.issues[key]) {
    const issue = await api("POST", `/companies/${state.companyId}/issues`, {
      title: `${state.marker} ${key}`, description: "Synthetic acceptance fixture. No real publication or external action.",
      status: "todo", assigneeAgentId: state.agentId, reviewPolicy: "human_only",
      idempotencyKey: `verify-human-review:${state.id}:${key}`,
    });
    state.issues[key] = { issueId: issue.id };
    await save();
  }
  if (!state.issues[key].interactionId) {
    Object.assign(state.issues[key], await pendingAndReleased(state.issues[key].issueId));
    await save();
  }
  return state.issues[key];
}
try {
  await save();
  const publicHealth = await api("GET", "/health");
  assert.equal(publicHealth.status, "ok");
  assert.equal(publicHealth.deploymentMode, "authenticated", "Never approve as local-board");
  assert.equal(publicHealth.deploymentExposure, "private");
  if (!state.userId) assert.equal(publicHealth.bootstrapStatus, "bootstrap_pending", "Only a fresh isolated instance can be claimed by this test");
  let credentials;
  if (existsSync(credentialsFile)) credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
  else {
    assert.equal(phase, "prepare");
    credentials = { email: `test-human-review-${state.id}@paperclip.invalid`, password: randomBytes(32).toString("base64url"), name: state.marker };
    await writeFile(credentialsFile, JSON.stringify(credentials) + "\n", { mode: 0o600, flag: "wx" });
  }
  assert.equal(credentials.name, state.marker);
  // Login first makes an interrupted registration safely resumable.
  let login = await request("POST", "/auth/sign-in/email", { email: credentials.email, password: credentials.password }, [200, 401]);
  if (login.status === 401) {
    assert.equal(phase, "prepare");
    await api("POST", "/auth/sign-up/email", credentials);
    login = await request("POST", "/auth/sign-in/email", { email: credentials.email, password: credentials.password });
  }
  const session = await api("GET", "/auth/get-session");
  assert.equal(session.user.email, credentials.email);
  assert.equal(session.user.name, state.marker);
  assert.notEqual(session.user.id, "local-board");
  if (state.userId) assert.equal(session.user.id, state.userId);
  state.userId = session.user.id;
  await save();
  if (publicHealth.bootstrapStatus === "bootstrap_pending") await api("POST", "/bootstrap/claim", {});
  const health = await api("GET", "/health");
  assert.equal(health.bootstrapStatus, "ready");
  assert(health.serverInfo?.processStartedAt, "Server identity is required for restart proof");
  state.sourceCommit ??= health.commit;
  assert.equal(health.commit, state.sourceCommit, "Do not mix source revisions in one acceptance record");
  await check("genuine-labelled-test-session", { userId: state.userId });

  if (phase === "prepare") {
    assert(!state.preparedAt, "Already prepared; restart the isolated instance and use resume");
    state.beforeRestartProcessStartedAt ??= health.serverInfo.processStartedAt;
    if (!state.companyId) {
      const candidates = (await api("GET", "/companies")).filter(entry => entry.description === state.marker);
      assert(candidates.length < 2, "Ambiguous test company; no automatic duplicate creation");
      const company = candidates[0] ?? await api("POST", "/companies", { name: `TEST human-review ${state.id.slice(0, 8)}`, description: state.marker, defaultResponsibleUserId: state.userId });
      state.companyId = company.id; await save();
    }
    const company = await api("GET", `/companies/${state.companyId}`);
    assert.equal(company.description, state.marker);
    if (!state.agentId) {
      const candidates = (await api("GET", `/companies/${state.companyId}/agents`)).filter(entry => entry.metadata?.humanReviewFixture === state.id);
      assert(candidates.length < 2, "Ambiguous test agent");
      const agent = candidates[0] ?? await api("POST", `/companies/${state.companyId}/agents`, {
        name: `TEST deterministic worker ${state.id.slice(0, 8)}`, role: "ceo", adapterType: "process", runner: "legacy",
        adapterConfig: { command: process.execPath, args: [path.join(here, "verify-human-review-worker.mjs"), base, state.marker, state.userId, evidenceDir], cwd: evidenceDir, timeoutSec: 60 },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: { canCreateAgents: false }, metadata: { humanReviewFixture: state.id, synthetic: true },
      });
      state.agentId = agent.id; await save();
    }
    const accepted = await createScenario("accept-after-restart");
    await check("exact-revision-human-only-and-agent-self-approval-denied", accepted);
    await deniedAction(accepted, "pending");
    const rejected = await createScenario("reject");
    assert.notEqual(rejected.sourceRunId, accepted.sourceRunId);
    assert.equal((await cardFor(accepted.issueId, accepted.interactionId)).status, "pending");
    await check("second-task-ran-with-first-human-wait-pending", { firstRun: accepted.sourceRunId, secondRun: rejected.sourceRunId });
    const rejection = await cardFor(rejected.issueId, rejected.interactionId);
    if (rejection.status === "pending") await api("POST", `/issues/${rejected.issueId}/interactions/${rejected.interactionId}/reject`, { reason: "TEST ONLY: synthetic deliverable rejected" });
    const rejectedAfter = await cardFor(rejected.issueId, rejected.interactionId);
    assert.equal(rejectedAfter.status, "rejected");
    assert.equal(rejectedAfter.resolvedByUserId, state.userId);
    assert.equal(rejectedAfter.result?.reason, "TEST ONLY: synthetic deliverable rejected");
    assert.notEqual((await api("GET", `/issues/${rejected.issueId}`)).status, "done");
    await check("test-user-rejection-persists-without-delivery", rejected);
    await deniedAction(rejected, "rejected");
    await waitForRework(rejected);
    await check("rejected-task-waits-for-revised-requirements", rejected);
    const stale = await createScenario("revision-invalidation");
    let document = await api("GET", `/issues/${stale.issueId}/documents/review-evidence`);
    if (document.latestRevisionId === stale.revisionId) document = await api("PUT", `/issues/${stale.issueId}/documents/review-evidence`, {
      title: document.title, format: "markdown", baseRevisionId: document.latestRevisionId,
      body: `${state.marker}\n\nSynthetic deliverable revision 2: changed after confirmation request.\n`,
    });
    assert.notEqual(document.latestRevisionId, stale.revisionId);
    stale.newRevisionId = document.latestRevisionId; await save();
    const expired = await cardFor(stale.issueId, stale.interactionId);
    assert.equal(expired.status, "expired");
    const staleAccept = await request("POST", `/issues/${stale.issueId}/interactions/${stale.interactionId}/accept`, {}, [409]);
    const staleCreate = await request("POST", `/issues/${stale.issueId}/interactions`, {
      kind: "request_confirmation", resolverPolicy: "human_only", continuationPolicy: "none",
      idempotencyKey: `verify-stale:${state.id}`, payload: { version: 1, prompt: "TEST invalid old revision", target: {
        type: "issue_document", issueId: stale.issueId, documentId: stale.documentId, key: "review-evidence", revisionId: stale.revisionId, revisionNumber: stale.revisionNumber,
      } },
    }, [422]);
    assert.notEqual((await api("GET", `/issues/${stale.issueId}`)).status, "done");
    await check("document-change-expires-old-card-and-rejects-stale-create", { ...stale, oldAcceptStatus: staleAccept.status, oldCreateStatus: staleCreate.status });
    await deniedAction(stale, "expired");
    // Revision recovery is allowed to run, but no new confirmation is accepted.
    state.preparedAt = new Date().toISOString();
    await save();
    console.log("PREPARED. Operator must restart the same isolated instance, then run resume with the same evidence directory.");
  } else if (phase === "stages") {
    assert(state.completedAt && state.companyId && state.agentId, "Complete the original fixture before extending stage coverage");
    const company = await api("GET", `/companies/${state.companyId}`);
    assert.equal(company.description, state.marker);
    const pendingAction = await createScenario("pending-action-recheck");
    await deniedAction(pendingAction, "pending");
    await deniedAction(state.issues.reject, "rejected");
    await deniedAction(state.issues["revision-invalidation"], "expired");
    if (!state.executionPolicyStage) {
      state.executionPolicyStage = { stageId: randomUUID() };
      await save();
    }
    const stage = state.executionPolicyStage;
    if (!stage.issueId) {
      const task = await api("POST", `/companies/${state.companyId}/issues`, {
        title: `${state.marker} execution-policy-stage`,
        description: "TEST ONLY: validate a server-enforced human approval stage, separate from interaction-card policy. No external action.",
        status: "todo", assigneeAgentId: state.agentId, reviewPolicy: "anyone",
        idempotencyKey: `verify-execution-stage:${state.id}`,
        executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stage.stageId,
          type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: state.userId }] }] },
      });
      stage.issueId = task.id;
      await save();
    }
    if (!stage.sourceRunId) {
      await poll("human execution stage and exact agent denial evidence", async () => {
        const task = await api("GET", `/issues/${stage.issueId}`);
        const runs = await api("GET", `/companies/${state.companyId}/heartbeat-runs?agentId=${state.agentId}&limit=100`);
        const candidates = runs.filter(run => run.issueId === stage.issueId || run.contextSnapshot?.issueId === stage.issueId);
        for (const run of candidates) {
          const workerFile = path.join(evidenceDir, `worker-${run.id}.json`);
          if (!existsSync(workerFile)) continue;
          const worker = JSON.parse(await readFile(workerFile, "utf8"));
          const knownFixtureExpectationError = run.status === "failed" && worker.policyStage?.id === stage.stageId
            && worker.error?.endsWith(": 403 This task is assigned to a human; the outgoing run can no longer change it");
          if (knownFixtureExpectationError) {
            stage.fixtureCorrection = { runId: run.id, originalRunStatus: run.status,
              originalAssertion: "Expected stage-level 422 from the outgoing run",
              actualResponse: "403 human handoff ownership fence",
              correction: "Retain the failed run; use an independently admitted probe run to test the stage-level 422 separately" };
          } else {
            if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`Stage fixture run ${run.id} ended ${run.status}; retain evidence and inspect the cause`);
            if (run.status !== "succeeded") continue;
            assert.equal(worker.outcome, "execution-policy-human-stage-pending-outgoing-run-denied");
            assert.equal(worker.policyStage?.denials?.length, 2);
          }
          assert.equal(task.status, "in_review");
          assert.equal(task.executionState?.status, "pending");
          assert.equal(task.executionState?.currentStageId, stage.stageId);
          assert.equal(task.executionState?.currentParticipant?.userId, state.userId);
          assert.equal(task.executionRunId, null);
          assert.equal(task.checkoutRunId, null);
          Object.assign(stage, { sourceRunId: run.id, sourceRunStatus: run.status, outgoingRunDenialStatus: 403 });
          return true;
        }
        return false;
      });
      await check("execution-policy-source-handoff-committed-outgoing-run-denied-403", stage);
    }
    if (!stage.probeIssueId) {
      const probe = await api("POST", `/companies/${state.companyId}/issues`, {
        title: `${state.marker} execution-policy-probe`, status: "backlog", reviewPolicy: "anyone",
        idempotencyKey: `verify-execution-stage-probe:${state.id}`,
        description: "TEST ONLY: a separately admitted run tests the pending human stage, then completes only its own probe task.",
      });
      stage.probeIssueId = probe.id;
      await save();
    }
    if (!stage.probeRunId) {
      const probe = await api("GET", `/issues/${stage.probeIssueId}`);
      if (probe.status === "backlog") {
        const docs = await api("GET", `/issues/${probe.id}/documents`);
        if (!docs.some(doc => doc.key === "stage-target")) await api("PUT", `/issues/${probe.id}/documents/stage-target`, {
          format: "markdown", title: "TEST exact stage probe target", baseRevisionId: null,
          body: JSON.stringify({ issueId: stage.issueId, stageId: stage.stageId, reviewerId: state.userId }),
        });
        await api("PATCH", `/issues/${probe.id}`, { status: "todo", assigneeAgentId: state.agentId });
      }
      await poll("independent agent stage-level 422 probes", async () => {
        const runs = await api("GET", `/companies/${state.companyId}/heartbeat-runs?agentId=${state.agentId}&limit=100`);
        for (const run of runs.filter(entry => entry.issueId === stage.probeIssueId || entry.contextSnapshot?.issueId === stage.probeIssueId)) {
          if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`Independent stage probe ${run.id} ended ${run.status}`);
          const workerFile = path.join(evidenceDir, `worker-${run.id}.json`);
          if (run.status !== "succeeded" || !existsSync(workerFile)) continue;
          const worker = JSON.parse(await readFile(workerFile, "utf8"));
          assert.equal(worker.outcome, "execution-policy-independent-probe-denied-422");
          assert.equal(worker.policyStage?.denials?.length, 2);
          Object.assign(stage, { probeRunId: run.id, agentDenials: worker.policyStage.denials });
          return true;
        }
        return false;
      });
      await check("execution-policy-human-stage-independent-agent-done-and-rework-denied-422", stage);
    }
    const before = await api("GET", `/issues/${stage.issueId}`);
    if (before.executionState?.status === "pending") {
      const noComment = await request("PATCH", `/issues/${stage.issueId}`, { status: "done" }, [422]);
      assert.match(noComment.data?.error ?? "", /requires a comment/);
      assert.equal((await api("GET", `/issues/${stage.issueId}`)).executionState?.status, "pending");
      await check("human-stage-verdict-requires-comment-and-does-not-advance-on-error", { issueId: stage.issueId, status: noComment.status });
      await api("PATCH", `/issues/${stage.issueId}`, { status: "done", comment: `${state.marker} TEST human approves the synthetic mandatory approval stage.` });
    }
    const approved = await api("GET", `/issues/${stage.issueId}`);
    assert.equal(approved.status, "done");
    assert.equal(approved.executionState?.status, "completed");
    assert(approved.executionState?.completedStageIds?.includes(stage.stageId));
    assert.equal(approved.executionState?.lastDecisionOutcome, "approved");
    assert(approved.executionState?.lastDecisionId);
    Object.assign(stage, { completedAt: new Date().toISOString(), decisionId: approved.executionState.lastDecisionId, resolvedByTestUserId: state.userId });
    await check("genuine-test-user-approval-completes-mandatory-execution-stage", stage);
  } else if (phase === "repair-rejection") {
    assert(state.preparedAt && state.issues.reject, "This repair only applies to an already prepared fixture");
    const rejected = state.issues.reject;
    const before = await api("GET", `/issues/${rejected.issueId}`);
    assert(before.title.startsWith(state.marker) && before.companyId === state.companyId);
    assert.equal((await cardFor(rejected.issueId, rejected.interactionId)).status, "rejected");
    state.observations ??= [];
    state.observations.push({ at: new Date().toISOString(), finding: "fixture-rejection-disposition",
      observedStatus: before.status, explanation: "Original deterministic worker checked out a rejected task and exited without a durable disposition; later recovery runs were observed. Approval and receipt denial held. Fixture now preserves rejection and asks for revised requirements.",
      manualRepairWake: true });
    await save();
    await api("POST", `/agents/${state.agentId}/wakeup`, { source: "on_demand", reason: "verify_human_review_fixture_disposition_repair",
      idempotencyKey: `fixture-disposition-repair:${state.id}`, payload: { issueId: rejected.issueId, taskId: rejected.issueId } });
    await waitForRework(rejected);
    Object.assign(state.observations.at(-1), { repairedAt: new Date().toISOString(), repairRunId: rejected.repairRunId });
    await deniedAction(rejected, "rejected");
    await check("rejection-fixture-repaired-to-durable-human-wait-without-delivery", rejected);
  } else {
    assert(state.preparedAt, "Prepare did not finish; preserve any recorded failure first");
    assert.notEqual(health.serverInfo.processStartedAt, state.beforeRestartProcessStartedAt, "No server restart observed; do not claim restart persistence");
    await check("actual-server-restart-observed", { before: state.beforeRestartProcessStartedAt, after: health.serverInfo.processStartedAt });
    const accepted = state.issues["accept-after-restart"];
    const rejected = state.issues.reject;
    const stale = state.issues["revision-invalidation"];
    assert.equal((await cardFor(rejected.issueId, rejected.interactionId)).status, "rejected");
    assert.equal((await cardFor(stale.issueId, stale.interactionId)).status, "expired");
    const pending = await cardFor(accepted.issueId, accepted.interactionId);
    assert(["pending", "accepted"].includes(pending.status));
    assert.equal(pending.payload.target.revisionId, accepted.revisionId);
    assert.equal(pending.effectiveResolverPolicy, "human_only");
    const document = await api("GET", `/issues/${accepted.issueId}/documents/review-evidence`);
    assert.equal(document.latestRevisionId, accepted.revisionId);
    await check("pending-rejected-expired-states-survive-restart");
    if (pending.status === "pending") await api("POST", `/issues/${accepted.issueId}/interactions/${accepted.interactionId}/accept`, {});
    const resolved = await cardFor(accepted.issueId, accepted.interactionId);
    assert.equal(resolved.status, "accepted");
    assert.equal(resolved.resolvedByUserId, state.userId);
    assert.equal(resolved.resolvedByAgentId, null);
    await poll("accepted confirmation automatically resumes the fixture", async () => {
      const issue = await api("GET", `/issues/${accepted.issueId}`);
      if (issue.status !== "done" || issue.executionRunId || issue.checkoutRunId) return false;
      const runs = await api("GET", `/companies/${state.companyId}/heartbeat-runs?agentId=${state.agentId}&limit=100`);
      for (const run of runs) {
        if (run.id === accepted.sourceRunId || run.status !== "succeeded") continue;
        const workerFile = path.join(evidenceDir, `worker-${run.id}.json`);
        if (!existsSync(workerFile)) continue;
        const worker = JSON.parse(await readFile(workerFile, "utf8"));
        if (worker.issueId === accepted.issueId && worker.outcome === "accepted-exact-revision-resumed") {
          assert.equal(worker.controlledAction?.replayCreated, false);
          accepted.resumedRunId = run.id; return true;
        }
      }
      return false;
    });
    await check("test-user-exact-revision-acceptance-automatically-resumes-and-completes", accepted);
    const receiptFile = receiptPath(path.join(evidenceDir, "receipts"), accepted.issueId, accepted.revisionId);
    const receiptBeforeReplay = await readFile(receiptFile, "utf8");
    const replay = await executeControlledReceipt(actionInput(accepted));
    assert.equal(replay.created, false);
    assert.equal(await readFile(receiptFile, "utf8"), receiptBeforeReplay);
    assert.equal((await readdir(path.join(evidenceDir, "receipts"))).filter(name => name.startsWith(`receipt-${accepted.issueId}-`)).length, 1);
    await deniedAction(rejected, "rejected");
    await deniedAction(stale, "expired");
    await check("controlled-action-exact-approved-revision-produces-one-immutable-receipt", { file: receiptFile });
    state.completedAt = new Date().toISOString(); await save();
    console.log(`COMPLETE. Sanitized evidence: ${path.join(evidenceDir, "report.json")}`);
  }
  attempt.status = "passed";
} catch (error) {
  attempt.status = "failed";
  attempt.error = error instanceof Error ? error.message : String(error);
  console.error(attempt.error);
  process.exitCode = 1;
} finally {
  attempt.finishedAt = new Date().toISOString();
  await appendFile(path.join(evidenceDir, "attempts.ndjson"), JSON.stringify(attempt) + "\n", { mode: 0o600 });
  await save();
}
