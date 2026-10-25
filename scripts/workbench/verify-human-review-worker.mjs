#!/usr/bin/env node
// Deterministic provider fixture. Paperclip supplies the real agent/run JWT.
// This is NOT a model, a human user, or a substitute for provider qualification.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeControlledReceipt } from "./verify-human-review-action.mjs";

const [base, marker, reviewerId, evidenceDir] = process.argv.slice(2);
const runId = process.env.PAPERCLIP_RUN_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const companyId = process.env.PAPERCLIP_COMPANY_ID;
const token = process.env.PAPERCLIP_API_KEY;
assert(base && marker?.startsWith("[TEST human-review ") && reviewerId && evidenceDir);
assert(runId && agentId && companyId && token, "Use the Paperclip process adapter, not a manual worker launch");
assert.notEqual(reviewerId, "local-board");
const origin = new URL(base).origin;
assert.equal(new URL(process.env.PAPERCLIP_API_URL).origin, origin, "Fixture belongs to a different server");
const evidence = { fixture: "deterministic-process", runId, agentId, companyId, startedAt: new Date().toISOString() };

async function api(method, route, body, expected = [200, 201]) {
  const response = await fetch(new URL(`/api${route}`, origin), {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": runId, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${route}: non-JSON ${response.status}`); }
  if (!expected.includes(response.status)) throw new Error(`${method} ${route}: ${response.status} ${data?.error ?? "unexpected response"}`);
  return { status: response.status, data };
}
async function save() {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `worker-${runId}.json`), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}
try {
  const { data: run } = await api("GET", `/heartbeat-runs/${runId}`);
  assert.equal(run.agentId, agentId);
  assert.equal(run.companyId, companyId);
  const issueId = run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  assert(issueId, "The fixture requires a task-scoped admitted run");
  evidence.issueId = issueId;
  const { data: issue } = await api("GET", `/issues/${issueId}`);
  assert.equal(issue.companyId, companyId);
  assert(issue.title.startsWith(marker), "Refusing a non-fixture task");
  assert.equal(issue.assigneeAgentId, agentId);
  if (["done", "cancelled"].includes(issue.status)) {
    evidence.outcome = "terminal-task-noop";
  } else {
    // A legitimate run may adopt its own automatic execution checkout.
    await api("POST", `/issues/${issueId}/checkout`, {
      agentId, expectedStatuses: ["todo", "in_progress", "in_review", "blocked"],
    });
    if (issue.title.endsWith("execution-policy-stage")) {
      // Isolate the executionPolicy stage guard from the separate reviewPolicy
      // and interaction-card guards, so a generic 403 cannot masquerade as proof.
      assert.equal(issue.reviewPolicy, "anyone");
      const submitted = (await api("PATCH", `/issues/${issueId}`, {
        status: "done", comment: `${marker} TEST synthetic work ready for the mandatory human approval stage.`,
      })).data;
      assert.equal(submitted.status, "in_review");
      assert.equal(submitted.executionState?.status, "pending");
      assert.equal(submitted.executionState?.currentStageType, "approval");
      assert.equal(submitted.executionState?.currentParticipant?.type, "user");
      assert.equal(submitted.executionState?.currentParticipant?.userId, reviewerId);
      assert.equal(submitted.assigneeAgentId, null);
      assert.equal(submitted.assigneeUserId, reviewerId);
      evidence.policyStage = { id: submitted.executionState.currentStageId, participantUserId: reviewerId, denials: [] };
      for (const status of ["done", "in_progress"]) {
        const denied = await api("PATCH", `/issues/${issueId}`, {
          status, comment: `${marker} TEST forbidden agent stage advancement probe (${status}).`,
        }, [403]);
        assert.equal(denied.data?.details?.code, "issue_handed_off");
        evidence.policyStage.denials.push({ requestedStatus: status, status: denied.status, reason: denied.data.error });
        const unchanged = (await api("GET", `/issues/${issueId}`)).data;
        assert.equal(unchanged.status, "in_review");
        assert.equal(unchanged.executionState?.status, "pending");
        assert.equal(unchanged.executionState?.currentStageId, evidence.policyStage.id);
        assert.equal(unchanged.executionState?.currentParticipant?.userId, reviewerId);
      }
      evidence.outcome = "execution-policy-human-stage-pending-outgoing-run-denied";
    } else if (issue.title.endsWith("execution-policy-probe")) {
      const targetDoc = (await api("GET", `/issues/${issueId}/documents/stage-target`)).data;
      const target = JSON.parse(targetDoc.body);
      assert.equal(target.reviewerId, reviewerId);
      const pending = (await api("GET", `/issues/${target.issueId}`)).data;
      assert.equal(pending.companyId, companyId);
      assert(pending.title === `${marker} execution-policy-stage`);
      assert.equal(pending.executionState?.currentStageId, target.stageId);
      assert.equal(pending.executionState?.currentParticipant?.userId, reviewerId);
      evidence.policyStage = { id: target.stageId, issueId: target.issueId, denials: [] };
      for (const status of ["done", "in_progress"]) {
        const denied = await api("PATCH", `/issues/${target.issueId}`, {
          status, comment: `${marker} TEST independently admitted agent probes forbidden stage advance (${status}).`,
        }, [422]);
        assert.match(denied.data?.error ?? "", /Only the active reviewer or approver can advance the current execution stage/);
        evidence.policyStage.denials.push({ requestedStatus: status, status: denied.status, reason: denied.data.error });
        const unchanged = (await api("GET", `/issues/${target.issueId}`)).data;
        assert.equal(unchanged.status, "in_review");
        assert.equal(unchanged.executionState?.status, "pending");
        assert.equal(unchanged.executionState?.currentStageId, target.stageId);
        assert.equal(unchanged.executionState?.currentParticipant?.userId, reviewerId);
      }
      await api("PATCH", `/issues/${issueId}`, { status: "done", comment: `${marker} TEST stage denial probes complete; target approval remains pending.` });
      evidence.outcome = "execution-policy-independent-probe-denied-422";
    } else {
    const { data: documents } = await api("GET", `/issues/${issueId}/documents`);
    let document = documents.find(entry => entry.key === "review-evidence");
    if (document) document = (await api("GET", `/issues/${issueId}/documents/review-evidence`)).data;
    else document = (await api("PUT", `/issues/${issueId}/documents/review-evidence`, {
      title: "TEST exact-revision deliverable", format: "markdown", baseRevisionId: null,
      body: `${marker}\n\nSynthetic deliverable revision 1. No external action.\n`,
    })).data;
    evidence.documentId = document.id;
    evidence.revisionId = document.latestRevisionId;
    const { data: interactions } = await api("GET", `/issues/${issueId}/interactions`);
    const current = interactions.find(entry => entry.kind === "request_confirmation"
      && entry.payload?.target?.revisionId === document.latestRevisionId
      && entry.idempotencyKey === `verify-human-review:${issueId}:${document.latestRevisionId}`);
    if (current?.status === "accepted") {
      assert.equal(current.effectiveResolverPolicy, "human_only");
      assert.equal(current.resolvedByUserId, reviewerId, "Only the explicitly created test user may resolve this fixture");
      assert.equal(current.resolvedByAgentId, null);
      evidence.interactionId = current.id;
      evidence.resolvedByUserId = current.resolvedByUserId;
      evidence.outcome = "accepted-exact-revision-resumed";
      const actionInput = { baseUrl: origin, issueId, interactionId: current.id,
        expectedRevisionId: document.latestRevisionId, expectedReviewerId: reviewerId, expectedCompanyId: companyId,
        marker, receiptDir: path.join(evidenceDir, "receipts"), authentication: { agentToken: token, runId } };
      const firstReceipt = await executeControlledReceipt(actionInput);
      const replayReceipt = await executeControlledReceipt(actionInput);
      assert.equal(replayReceipt.created, false, "Repeated accepted action must reuse its original receipt");
      evidence.controlledAction = { firstCreated: firstReceipt.created, replayCreated: replayReceipt.created, file: firstReceipt.file };
      // The comment gives the next run's audit attribution without storing tokens.
      await api("PATCH", `/issues/${issueId}`, {
        status: "done", comment: `${marker} Fixture resumed after test user confirmed exact revision ${document.latestRevisionId}.`,
      });
    } else if (current?.status === "rejected") {
      evidence.interactionId = current.id;
      // Do not reinterpret rejection as permission or create a fresh identical ask.
      const rework = interactions.find(entry => entry.idempotencyKey === `verify-rework:${current.id}`);
      if (!rework) await api("POST", `/issues/${issueId}/interactions`, {
        kind: "ask_user_questions", resolverPolicy: "human_only", addresseeUserId: reviewerId,
        continuationPolicy: "wake_assignee", idempotencyKey: `verify-rework:${current.id}`,
        title: `${marker} Awaiting revised requirements after rejection`,
        payload: { version: 1, questions: [{ id: "rework", prompt: "TEST ONLY: what should change in the rejected synthetic deliverable?",
          selectionMode: "single", required: true, options: [{ id: "describe", label: "Describe the required correction", freeText: true }] }] },
      });
      await api("PATCH", `/issues/${issueId}`, { status: "in_review",
        comment: `${marker} Rejection preserved. Waiting for revised requirements; no controlled receipt was produced.` });
      evidence.outcome = "rejected-waiting-rework-no-delivery";
    } else {
      assert(!current || current.status === "pending", "Unexpected current-revision interaction state");
      const card = current ?? (await api("POST", `/issues/${issueId}/interactions`, {
        kind: "request_confirmation", resolverPolicy: "human_only", addresseeUserId: reviewerId,
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: `verify-human-review:${issueId}:${document.latestRevisionId}`,
        title: `${marker} Confirm this exact synthetic revision`,
        payload: { version: 1, prompt: "TEST ONLY: approve this exact synthetic document revision?", rejectRequiresReason: true,
          target: { type: "issue_document", issueId, documentId: document.id, key: document.key,
            revisionId: document.latestRevisionId, revisionNumber: document.latestRevisionNumber } },
      })).data;
      evidence.interactionId = card.id;
      assert.equal(card.effectiveResolverPolicy, "human_only");
      await assert.rejects(() => executeControlledReceipt({ baseUrl: origin, issueId, interactionId: card.id,
        expectedRevisionId: document.latestRevisionId, expectedReviewerId: reviewerId, expectedCompanyId: companyId,
        marker, receiptDir: path.join(evidenceDir, "receipts"), authentication: { agentToken: token, runId } }),
      { code: "confirmation-pending" });
      evidence.pendingControlledAction = "denied";
      const denied = await api("POST", `/issues/${issueId}/interactions/${card.id}/accept`, {}, [403]);
      const code = denied.data?.code ?? denied.data?.details?.code;
      assert.equal(code, "interaction_human_only", "A generic authentication/scope failure does not prove human_only");
      evidence.agentSelfApproval = { status: denied.status, code };
      const { data: afterDeny } = await api("GET", `/issues/${issueId}/interactions`);
      assert.equal(afterDeny.find(entry => entry.id === card.id)?.status, "pending");
      await api("PATCH", `/issues/${issueId}`, {
        status: "in_review", reviewInteractionId: current ? undefined : card.id,
        comment: `${marker} Pending explicit human confirmation. Fixture process exits and releases capacity.`,
      });
      const doneDenied = await api("PATCH", `/issues/${issueId}`, { status: "done" }, [403]);
      assert.equal(doneDenied.data?.details?.code, "review_policy_denied");
      evidence.agentDirectReviewCompletion = { status: doneDenied.status, code: doneDenied.data.details.code };
      evidence.outcome = "pending-human-review-process-exiting";
    }
    }
  }
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ fixture: evidence.fixture, issueId: evidence.issueId, runId, outcome: evidence.outcome }));
} catch (error) {
  evidence.outcome = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  await save();
  console.error(evidence.error);
  process.exitCode = 1;
}
