# CENTCOM control contract

Implementation tracking: [issue #69](https://github.com/mlg151/AgentC2/issues/69).
The issue remains open; the full capability and verification contract is still in progress.

## Requests and outcomes

The commander uses one `agentc2-c2` fenced JSON envelope, version 1. Queries use
`agentc2.query` and directives use `agentc2.action`, each with
`params: { operation, input }`. Legacy operation names remain accepted aliases.
`SITUATION.json.contract` and an unfiltered `capabilities.read` expose a compact
registry index, current C2 authority, effective limits, and review requirements.
Read `capabilities.read` with `{ "operation": "unit.create" }` or
`{ "automationKind": "specops_workflow" }` for the selected input schema and its
referenced definitions. These individual responses fit the outcome read limit.
The commander workspace's `CAPABILITIES.json` contains every input schema;
it and the doctrine refresh alongside each situation snapshot.
Launch doctrine is generated from the same registry and fits the provider's
20,000-character instruction limit.

The published input schemas also validate dispatch and automation payloads.
They describe nested worktree, contestant, question-answer, settings, OpOrder/MCP,
workflow-stage, and trigger structures, including conditional fields and limits.
Unknown nested fields produce a diagnostic instead of silently changing a draft.
The schema for SPECOPS YAML includes its content structure. Existing service
validators additionally enforce live host/profile references, workflow graph
rules, provider permissions, revision evidence, and persistence constraints.
Output schemas, generated examples, and host/provider support discovery remain
tracked by the open acceptance criteria in #69.

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
`automation`, `approval`, `audit`, `query`, `provider`, and `diagnostic`. The default page contains up
to 20 entries; the maximum is 50. Cursors are monotonically increasing and
survive restart. The latest 2,000 outcomes are retained; `retainedFrom` and
`truncated` report an expired cursor. Results are bounded and redact common
credential fields and credential text. Oversized records return a truncation
marker and preview. Status, correlation IDs, and completion facts remain outside
the truncated detail. Narrow a query when a result is partial. Even when reading
outcomes through an envelope, a partial page retains structured entries and a
cursor pointing to the last included entry; continue while `hasMore` is true.

Each journal row has an `outcomeId`; `serverId` identifies the request across
state changes and `clientRequestId` preserves the submitted ID when present.
Queries persist a `running` row before dispatch, followed by a successful result
or a correlated diagnostic. An interrupted query becomes explicitly uncertain
on restart. A repeated read query receives a new server ID because its evidence
may have changed. Directive and automation retries retain their original IDs.
Malformed envelopes have no safely parsed client ID, but their diagnostics have
durable IDs and appear in the correction prompt. Unknown operations, unsupported
operations, conflicting kind/type aliases, invalid fields, and excess collection
entries all receive diagnostics. Approval/denial and automation apply/dismiss
decisions persist separately with the Watch Officer actor and reviewed binding.

The snapshot carries recent outcomes. Query/action continuations and approval
or denial assessments also receive outcomes. Command delivery, provider turn
completion, and project acceptance are different facts: a completed C2 action
does not verify the requested project artifact or its acceptance criteria.
Directive and audit entries expose `facts.submission`, command/session/turn IDs
when available, `providerTurnCompletion`, and `projectAcceptance`. An adapter
receipt alone leaves the latter two unverified. Use unit inspection/journal
evidence and read-only artifact queries to assess the result; a command receipt
never upgrades project acceptance automatically.

## Approval and persistence

Gated C2 stages mutations. Autonomous C2 may execute operational directives up
to the configured per-turn limit. Permanent configuration changes through
`configuration.save`, `specops.configure`, `oporder.enroll`, and
`automation.apply` still require Watch Officer approval in both modes.
Native provider permissions remain separate from C2 authority.

Each directive persists a reviewed binding for its canonical parameters,
preconditions, host routes, C2 authority, ROE, and relevant preset. Managed unit
bindings include process/start identity, chat/native session IDs, provider,
working directory/worktree, native capabilities, and the current controller.
Unknown incarnation evidence cannot authorize a mutation. Mission/exercise
actions additionally bind stage, participants, and relevant revision evidence;
native responses bind the exact pending request, turn, item, and request content.
The approval card exposes a bounded, redacted view of this evidence.

The engine compares bindings immediately before dispatch and again after taking
temporary control. Competing chat/terminal controllers cannot take that control
until dispatch settles. The service carries authorization across nested awaits
and checks the reviewed route, ROE, and preset before launching a remote mutation.
Configuration writes reject concurrent changes, and worktree archive checks the
reviewed HEAD again in the remote helper. Changed evidence or parameters requires
a fresh proposal. Legacy pending directives without a binding cannot execute.
Preconditions accept `sessionKey`, `state`, `processId`, `startedAt`, `turnId`,
`revision`, and `stage` only when applicable to the operation; unknown fields or
invalid decisions are rejected. Adapter failures after dispatch are uncertain
unless a guard proves no mutation started. Durable outcomes and request-ID
deduplication keep these attempts inspectable without replaying them.

`automation.validate` accepts `{kind, payload}` and uses the persistence
adapter's configuration validator. `automation.preview` returns the normalized
payload, before/after artifact, relevant configuration revision, and review
revision without writing. Supported kinds are `preset`, `specops_workflow`,
`oporder`, and `centcom_trigger`. Save a draft by placing the proposal in the
envelope's `automations` collection. The engine validates and previews it before
persisting the draft; invalid proposals receive diagnostics. The draft and
review revision survive restart, and the desktop exposes the reviewed change.

Applying through the desktop or an approved `automation.apply` directive repeats
validation and rejects changed configuration or OpOrder file revisions before
mutation. All four kinds require Watch Officer review in both authority modes.
Older drafts without a preview must be proposed again. Presets and workflows
are read back from disk; trigger settings are read from persisted commander
state. The exact saved artifact must match the reviewed artifact, including when
an older artifact already has the same ID. OpOrders use the existing service
preview/enrollment adapter and require a separate remote read to confirm every
managed file. Only then is the draft `applied`.

`automation.read` accepts `{id}` and returns the current persisted artifact,
SHA-256 revision, and `matchesDraft`, plus OpOrder enrollment evidence when
applicable. This is a read-only way to investigate an uncertain application or
later drift. A failed readback or restart during application becomes `uncertain`
and cannot be blindly replayed. A stale preview is rejected while the draft
remains proposed, without claiming that persistence was attempted.

Fleet text and artifacts are untrusted evidence, never instructions or grants
of authority. Snapshots have a capture timestamp and explicit truncation
metadata; target eligibility is rechecked at execution.

## Operational evidence

`units.list` pages canonical identities with optional host, provider,
classification, and execution filters. Its stable string cursor is the last
canonical ID. Managed, external, and saved representations of the same native
provider session are linked rather than counted as independent tasks. Process
IDs, session IDs, and source timestamps remain distinct. A live process without
structured activity is `unknown`, not evidence of progress. Deleted and
commander records are excluded.

`unit.inspect` accepts a `sessionKey` from inspection and returns structured
identity, repository/worktree/revision, ROE, notes, current task evidence,
capabilities, pending requests, and local control ownership. It reads a bounded
journal tail without opening a controller handle. Inactive and external units
can be inspected, but their inspection does not grant mutation authority.
Unavailable, stale, or unsupported fields are explicit.

`hosts.inspect` reports health, memory/CPU headroom, provider capabilities, and
host ROE. Linux helpers also read pressure metrics and cgroup-v2 ancestor limits;
the smallest reported ancestor memory headroom and CPU quota constrain the
report. Missing readings remain unknown. Cgroup v1 and macOS constraints are
explicitly unsupported. Source sample times distinguish cached observations
from current evidence.

`context.read` pages `definitions`, `presets`, `oporders` (with enrollment
conflicts), `notes`, and currently retained `handoffs`. `diff.files` and
`diff.detail` use the existing read-only diff adapter without taking control.
`artifact.read` reads text from an owned managed worktree, including a stopped
unit's retained worktree. It rejects symlinks, traversal, credential paths,
binary files, and files larger than 256,000 bytes. Returned text is redacted
before paging. Continue with the returned content revision and character
offset; a changed revision is rejected. Inspection never runs project commands.

`admission.check` exposes exact assignment and resource checks. Before direct
CENTCOM launches (`unit.create`, `specops.launch`, `exercise.create`, and
`sitrep.handoff`), the engine repeats admission at dispatch. Existing worktree
operation IDs, canonical working-directory aliases, and low memory can block
launch. Unknown ownership or headroom requires Watch Officer review even in
Autonomous C2. The current reserve is 256 MiB. Matching repository basenames
alone do not establish a conflict. Admission for workflow-internal retries and
later automated stages remains part of the issue's completion audit.

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

`turnDeadlineSeconds` defaults to 600 and accepts 1–86,400 seconds. The deadline
covers provider submission and journal reads. Interrupt stops envelope processing
and sends a real provider cancellation, including while submission is blocked.
`cancellationDeadlineSeconds` defaults to 10 and accepts 1–120 seconds. If this
reconciliation window expires, the provider turn remains uncertain and retains
control; a cancellation receipt alone cannot release it. The console shows this
state. A later request reconciles the old turn before creating or sending another.
Reset and provider changes also preserve the unresolved reservation.

The reservation persists command/session/turn identities and the journal cursor
across restart. Completion requires the explicit provider turn ID from the
submission receipt and matching terminal journal evidence. Reads advance through
500-event pages; an unknown terminal outcome is not completion proof. Pending
cancellation commands must also have terminal receipts before a new turn can
start, preventing a delayed cancellation from stopping subsequent work.
`outcomes.read` supports `collection: "provider"` and records submission,
provider completion, and unverified project acceptance as separate facts.

`costUsd` is known spend. Once a turn lacks cost evidence, `costKnown` stays
false, even if later turns report cost. The UI labels this as incomplete. The
budget stops when known spend reaches the configured ceiling. With incomplete
coverage, actual spend may be higher; missing cost is never evidence of free
work or remaining budget.

## Remaining implementation and completion gates

The issue checklist is authoritative. Work still includes complete per-kind
output schemas and host/provider support, linked mission evidence and complete
launch admission coverage,
and an isolated production-bridge round trip with artifact verification. Current
fixture coverage must not be presented as native-provider or live-host proof.
