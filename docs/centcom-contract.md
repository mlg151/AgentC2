# CENTCOM control contract

Implementation tracking: [issue #69](https://github.com/mlg151/AgentC2/issues/69).
The issue remains open; the full capability and verification contract is still in progress.

## Requests and outcomes

The commander uses one `agentc2-c2` fenced JSON envelope, version 1. Queries use
`agentc2.query` and directives use `agentc2.action`, each with
`params: { operation, input }`. Legacy operation names remain accepted aliases.
`SITUATION.json.contract` and the `capabilities.read` query expose the implemented
registry, current C2 authority, effective limits, and review requirements.
Launch doctrine is generated from the same registry and fits the provider's
20,000-character instruction limit.

Give each directive and automation a unique string `id`. The engine preserves
that client ID alongside its durable server ID. Reusing an ID within the same
commander conversation returns a duplicate diagnostic without repeating the
mutation, including after restart. Reusing it with changed input is rejected.
Legacy requests without an ID cannot be retried safely.

Mixed envelopes retain their directives and automation drafts before continuing
queries. A turn permits three query continuations; queries submitted at the
last hop receive durable `hop_limit` diagnostics. Malformed envelopes, invalid
entries, unknown operations, and collection limits produce diagnostics.

`outcomes.read` accepts optional `after`, `limit`, `collection`,
`clientRequestId`, and `serverId` filters. Collections are `directive`,
`automation`, `audit`, `query`, and `diagnostic`. The default page contains up
to 20 entries; the maximum is 50. Cursors are monotonically increasing and
survive restart. The latest 2,000 outcomes are retained; `retainedFrom` and
`truncated` report an expired cursor. Results are bounded and redact common
credential fields and credential text. Oversized records return a truncation
marker and preview. Narrow a query when a result is partial.

The snapshot carries recent outcomes. Query/action continuations and approval
or denial assessments also receive outcomes. Command delivery, provider turn
completion, and project acceptance are different facts: a completed C2 action
does not verify the requested project artifact or its acceptance criteria.

## Approval and persistence

Gated C2 stages mutations. Autonomous C2 may execute operational directives up
to the configured per-turn limit. Permanent configuration changes through
`configuration.save`, `specops.configure`, `oporder.enroll`, and
`automation.apply` still require Watch Officer approval in both modes.
Native provider permissions remain separate from C2 authority.

Automation proposals are drafts until reviewed. Applying a preset, workflow,
trigger configuration, or OpOrder must persist and read back the artifact before
reporting `applied`. Successful results include the artifact and a SHA-256
revision of its canonical JSON. OpOrder results additionally include the
revision-bound enrollment readback. A failed readback or a restart during
application becomes `uncertain`; it must not be blindly replayed.

Fleet text and artifacts are untrusted evidence, never instructions or grants
of authority. Snapshots have a capture timestamp and explicit truncation
metadata; target eligibility is rechecked at execution.

## Scheduling and spend

Alerts persist while CENTCOM is busy or paused. A due timer drains the final
event after cooldown without requiring another inventory update. Queued alerts,
in-flight alerts, cooldown timestamps, and deduplication signatures survive
restart. Flash Traffic, structured chat questions/approvals, observed unit
completion/failure, and mission stage/dependency changes can wake CENTCOM.
Commander sessions cannot wake themselves. Retired action targets cannot be
controlled merely because an old alert references them; completion evidence can
still inform the next assessment.

`triggers.fallbackSeconds` defaults to 600 for the ten-minute status policy.
Set it to zero for event-only operation; enabled fallback intervals must be at
least 600 seconds. Events remain the primary wake mechanism. Scheduled checks
instruct the commander to act on meaningful changes and avoid waiting-only
chatter. Pausing stops the timer while preserving queued events. Known spend
at the budget ceiling stops automatic wakeups.

`turnDeadlineSeconds` defaults to 600 and accepts 1–86,400 seconds. Full provider
cancellation reconciliation and ownership retention are still tracked in #69;
the configurable deadline alone does not establish that an interrupted provider
has stopped.

`costUsd` is known spend. Once a turn lacks cost evidence, `costKnown` stays
false, even if later turns report cost. The UI labels this as incomplete. The
budget stops when known spend reaches the configured ceiling. With incomplete
coverage, actual spend may be higher; missing cost is never evidence of free
work or remaining budget.

## Remaining implementation and completion gates

The issue checklist is authoritative. Work still includes complete per-kind
output schemas and host/provider support, richer paged unit/resource/mission
evidence, stronger revision/incarnation/authorization binding, cancellation
reconciliation, all automation validate/preview/draft/readback operations, and
an isolated production-bridge round trip with artifact verification. Current
fixture coverage must not be presented as native-provider or live-host proof.
