// A deliberately narrow local fixture action. This is not Paperclip's tool gateway
// and does not sandbox arbitrary shell writes or external provider operations.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function receiptPath(directory, issueId, revisionId) {
  assert(uuid.test(issueId) && uuid.test(revisionId), "Receipt IDs must be UUIDs");
  return path.join(directory, `receipt-${issueId}-${revisionId}.json`);
}
function deny(code) {
  const error = new Error(`Controlled fixture action denied: ${code}`);
  error.code = code;
  throw error;
}

export async function executeControlledReceipt(input) {
  const { baseUrl, issueId, interactionId, expectedRevisionId, expectedReviewerId,
    expectedCompanyId, marker, receiptDir, authentication } = input;
  const url = new URL(baseUrl);
  assert(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(url.port && !["3000", "3100"].includes(url.port));
  assert(marker.startsWith("[TEST human-review ") && expectedReviewerId !== "local-board");
  assert(path.isAbsolute(receiptDir));
  assert(uuid.test(issueId) && uuid.test(interactionId) && uuid.test(expectedRevisionId));
  const headers = authentication.agentToken
    ? { Authorization: `Bearer ${authentication.agentToken}`, "X-Paperclip-Run-Id": authentication.runId }
    : { Cookie: authentication.sessionCookie, Origin: url.origin };
  assert(authentication.agentToken ? authentication.runId : authentication.sessionCookie);
  async function get(route) {
    const response = await fetch(`${url.origin}/api${route}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) deny(`server-read-${response.status}`);
    return response.json();
  }
  const health = await get("/health");
  if (health.status !== "ok" || health.deploymentMode !== "authenticated" || health.deploymentExposure !== "private") deny("wrong-instance-mode");
  const issue = await get(`/issues/${issueId}`);
  if (issue.companyId !== expectedCompanyId || !issue.title.startsWith(marker)) deny("wrong-test-scope");
  const cards = await get(`/issues/${issueId}/interactions`);
  const card = cards.find(entry => entry.id === interactionId);
  if (!card || card.kind !== "request_confirmation") deny("missing-confirmation");
  if (card.status !== "accepted") deny(`confirmation-${card.status}`);
  if (card.effectiveResolverPolicy !== "human_only" || card.resolvedByUserId !== expectedReviewerId
      || card.resolvedByAgentId || card.addresseeUserId !== expectedReviewerId) deny("wrong-resolver");
  const target = card.payload?.target;
  if (target?.type !== "issue_document" || target.issueId !== issueId || target.key !== "review-evidence"
      || target.revisionId !== expectedRevisionId) deny("wrong-confirmed-revision");
  const document = await get(`/issues/${issueId}/documents/review-evidence`);
  if (document.id !== target.documentId || document.latestRevisionId !== expectedRevisionId
      || document.latestRevisionNumber !== target.revisionNumber) deny("revision-mismatch");
  // The proof is admission-time validation on real server state. It is not an
  // atomic transaction spanning Paperclip and a remote side effect.
  const identity = { marker, companyId: expectedCompanyId, issueId, interactionId,
    revisionId: expectedRevisionId, revisionNumber: document.latestRevisionNumber, resolvedByUserId: expectedReviewerId };
  const file = receiptPath(receiptDir, issueId, expectedRevisionId);
  await mkdir(receiptDir, { recursive: true });
  try {
    await writeFile(file, JSON.stringify({ ...identity, createdAt: new Date().toISOString(), synthetic: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { created: true, file };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(file, "utf8"));
    for (const [key, value] of Object.entries(identity)) assert.equal(prior[key], value, `Conflicting receipt ${key}`);
    return { created: false, file };
  }
}
