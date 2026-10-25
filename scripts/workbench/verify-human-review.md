# Human-review API acceptance fixture

This is an **explicitly synthetic test** against a real isolated Paperclip instance.
It does not prove browser interaction, real model compliance, or permission to execute
external actions. It never starts, stops, resets or deletes a service or database.

The operator must first start a fresh **authenticated/private**, loopback-only instance
using a separate data directory and port. Ports 3000 and 3100 are refused. Do not point
this test at an ordinary user instance or reuse a database containing real work.

```powershell
node scripts/workbench/verify-human-review.mjs prepare --url http://127.0.0.1:3115 --evidence-dir E:\LYH\agent-workbench\data\human-review-evidence
```

The script registers a labelled TEST account through Better Auth, signs in normally,
and claims the first instance administrator through `/api/bootstrap/claim`. It creates
one labelled company and a deterministic process adapter with concurrency one. The
worker receives its actual agent/run token from Paperclip; no header impersonates a
human. Passwords stay in `credentials.private.json` outside the source checkout.
Restrict access to that directory using the operating system's normal permissions.
On Windows, Node's Unix file mode does not replace a private directory ACL.

The prepare phase verifies:

- A `request_confirmation` binds a real document ID, revision ID and revision number.
- The actual source agent is denied with `interaction_human_only`, and direct completion
  of the review is denied with `review_policy_denied`. Generic authentication errors
  do not count as policy evidence.
- The run succeeds and releases both issue run locks while its confirmation stays
  pending; the same one-slot agent can process a second task.
- The dedicated TEST user's rejection persists without marking the task complete.
  If recovery wakes the worker, it retains the rejection and opens a distinct
  question asking for revised requirements, then releases the run in `in_review`.
- Updating the document expires the old card; resolving it returns 409 and creating
  a card against its old revision returns 422.
- The independently implemented `verify-human-review-action.mjs` re-reads server
  decisions and the current exact revision. Pending, rejected and expired cards
  produce no local receipt. Accepted current revisions create one receipt with an
  exclusive filesystem write; repeat calls validate and reuse that receipt.

After `PREPARED`, the **operator** restarts that same isolated instance. Then run:

```powershell
node scripts/workbench/verify-human-review.mjs resume --url http://127.0.0.1:3115 --evidence-dir E:\LYH\agent-workbench\data\human-review-evidence
```

Resume checks that `serverInfo.processStartedAt` changed and that pending, rejected,
and expired interactions survived. Only then does the TEST user accept the exact
synthetic revision. Paperclip must automatically start another real fixture run and
complete the test issue. The script never manually wakes the continuation.

This local receipt is a controlled fixture action, not gateway enforcement for
arbitrary shell writes or external publishing. It validates state at admission;
it is not an atomic transaction spanning Paperclip and a remote action. This suite
does not qualify restart during provider work. The additional stage phase below
qualifies one mandatory approval stage; it does not qualify multi-stage chains or
human-requested-rework cycles.

After the original fixture completes, extend the same isolated TEST company:

```powershell
node scripts/workbench/verify-human-review.mjs stages --url http://127.0.0.1:3115 --evidence-dir E:\LYH\agent-workbench\evidence\human-review
```

This configures an `executionPolicy` with an approval stage whose participant is
the genuine TEST user. The outgoing legacy run's further mutations are rejected
by the human-handoff fence (`403 issue_handed_off`). A separately admitted agent
probe tries `done` and `in_progress` against that pending stage; both must return
the stage-specific 422 and leave the stage unchanged. A human verdict without its
comment also returns 422. The TEST user's valid verdict completes the stage and
persists its decision ID. The test uses `reviewPolicy: anyone` only on these stage
fixtures to isolate this guard from the separate human-only review/card guard.
It also creates a fresh pending confirmation and rechecks all three denied action
states without creating a receipt.

The initial live stage probe expected 422 from the outgoing run, but encountered
the earlier 403 ownership fence. That run remains failed in history and is recorded
under `executionPolicyStage.fixtureCorrection`; its committed human handoff is
reported separately from the later successful independent stage probe. No failed
run is relabelled as succeeded. An execution stage itself does not bind a document
revision; the exact-revision confirmation/action checks remain separate evidence.

`repair-rejection` is a separately recorded one-off fixture recovery mode for evidence
created before the rejected-worker disposition was corrected. It invokes an explicitly
labelled test wake and retains the original observations; it is never used to wake the
accepted confirmation's continuation. Normal new prepare runs include the corrected wait.

`report.json` is sanitized evidence. `worker-<run-id>.json` records the deterministic
worker's policy-denial and continuation outcomes. `attempts.ndjson` retains failed
attempts: a successful retry is recovery evidence and does not explain an earlier
failure. Keep test data and evidence for diagnosis; cleanup is an operator decision.
The account and synthetic company remain clearly labelled in the isolated instance.

Source contracts (baseline `412914cfa`):

- `server/src/routes/access.ts:2760`: first-admin claim requires a genuine session.
- `server/src/routes/issues.ts:16774`: interaction creation and real run attribution.
- `server/src/services/issue-thread-interactions.ts:1827`: exact current revision check.
- `server/src/routes/issues.ts:10863`: document update expires old confirmations.
- `server/src/services/issue-thread-interaction-resolution.ts:248`: human-only denial.
- `server/src/services/issue-review-policy.ts:100`: review verdict policy.
- `server/src/adapters/process/execute.ts:34`: process runtime and server-minted token.
- `server/src/routes/health.ts:444`: process identity used for restart evidence.
