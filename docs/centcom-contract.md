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
referenced definitions. Add `"schema": "output"` for the successful adapter
payload or automation lifecycle schema. These individual responses fit the
outcome read limit; `definition` selects a named `$defs` definition if needed.
Input-schema reads also include validated request examples. The commander
workspace's `CAPABILITIES.json` contains every input/output schema and example;
it and the doctrine refresh alongside each situation snapshot.
Launch doctrine is generated from the same registry and fits the provider's
20,000-character instruction limit. Its index, envelope version, examples,
authority, directive/query limits, budget, fallback, and deadlines derive from
the executable contract and current policy. A changed schema that invalidates
an example fails registry construction. Unsupported operations have reasons and
no executable example. Examples use illustrative scope/revision values: resolve
them from fresh inspection and merge existing configuration before proposing a
change. They do not authorize actions or establish evidence.

The published input schemas also validate dispatch and automation payloads.
They describe nested worktree, contestant, question-answer, settings, OpOrder/MCP,
workflow-stage, and trigger structures, including conditional fields and limits.
Unknown nested fields produce a diagnostic instead of silently changing a draft.
The schema for SPECOPS YAML includes its content structure. Existing service
validators additionally enforce live host/profile references, workflow graph
rules, provider permissions, revision evidence, and persistence constraints.
Output contracts retain each adapter's actual return type, including native
receipts, scalar metadata results, no-payload actions (`null`), configuration
readback, and explicit partial-result markers. Upstream extension fields are
bounded JSON and are not proof of project acceptance. The remaining adapter
verification is still tracked in #69.

`capabilities.support` requires `operation` and accepts `hostId`, `provider`,
`transport`, `sessionKey`, `after`, and `limit`. It pages current support and
eligibility with source timestamps and reasons. Native capability discovery is
read-only and does not prepare runtimes or take control. An exact session query
also inspects ownership and pending requests; saved/external inspection does not
grant mutation eligibility. Supported protocol capability, unavailable targets,
unsupported features, and unknown prerequisites are separate states. Terminal
launch binaries/presets and repository/resource prerequisites remain unknown
until the relevant inspection or dispatch validates them. Every mutation still
requires current authority, applicable Watch Officer review, and fresh binding.

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

`unit.inspect` with the returned `commandId` reads the later native receipt
without acquiring control. Its `command.facts` keeps submission, exact provider
turn completion, and project acceptance separate. A receipt for another session
or command is rejected; missing terminal evidence remains unverified. These
fields survive a truncated transcript. The original directive outcome remains
the dispatch observation; the correlated inspection supplies newer evidence.

`history.read` provides a redacted index of retained CENTCOM actions and handoffs.
It accepts `after`, `through`, `limit` (maximum 50), `operation`, `hostId`,
`sessionKey`, `handoffsOnly`, and `view` (`actions` or `patterns`). Copy `through`
from the first response to keep subsequent pages on the same outcome snapshot.
Each action includes its latest dispatch state at that snapshot, durable source
outcome/request IDs, reviewed target identities, scope, and separate completion
facts. Completed handoffs retain the source preview/revision and returned
recipient identity even after the preview expires or a unit exits. Descriptions,
objectives, summaries, and next steps remain commander-supplied, unverified claims.
Prompts, native answers, configuration contents, patches, and test logs are omitted.
Pages fit the persisted query-result budget; clipped display fields are labeled
`displayTruncated`, and oversized indexes retain correlation and a partial marker.
Grouping uses a digest of the full scope, so clipped paths cannot merge identities.

Pattern reads count distinct completed server requests with the same canonical
operation and exact reviewed identity/scope. Pending, denied, failed, uncertain,
legacy/unbound, and truncated-target records do not establish repetition. Source
outcome IDs support inspection; lists beyond ten sources explicitly truncate.
The observed fact is repeated adapter completion, not identical tasks or project
acceptance. Reusable-workflow suitability and title-based suggestions are
hypotheses. Titles never determine grouping. Read the cited outcomes and task
acceptance evidence before proposing a permanent automation.

This view shares the 2,000-outcome retention window. It does not claim complete
lifetime history, other desktop actions, or that a preview completed a handoff.
`retainedFrom`, `truncated`, and `unknownMetadata` expose gaps, including older
records without a compact action index. Reads remain available after targets exit
without granting control or discovering their saved transcripts.

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
Unavailable, stale, or unsupported fields are explicit. Optional `commandId`
inspection correlates its receipt with a terminal event in the last 100 journal
events. Older or pruned events do not prove either success or failure.

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

`missions.read` lists coordination records and persisted SPECOPS/exercise
observations. Filter by `kind`, responsible `sessionKey`, or `linkKind`/`linkId`;
issue/PR identities retain their repository to disambiguate numbers. The returned
IDs are `coordination:<id>`, `specops:<run-id>`, and `exercise:<exercise-id>`.
`mission.inspect` accepts an ID and pages `summary`, `links`, `owners`,
`dependencies`, `acceptanceCriteria`, `blockers`, `nextActions`, `jobs`,
`artifacts`, or `evidence`. Supply the returned `revision` on subsequent pages to
reject a changed record. Ownership observations are live and can change between
reads. Pages fit the persisted result budget; oversized source entries retain
identity and an explicit partial marker.

`mission.update` records a plan through the existing action/approval boundary.
Supply an application-local `id`, `expectedRevision` (`null` only for creation),
and a typed `plan` containing all seven sections: title, links, owners,
dependencies, acceptance criteria, blockers, and next actions. Links identify
missions, issues, PRs, jobs, and artifacts; owner/criterion/action references use
those link keys. Owners must be connected active managed units at staging and
execution. Duplicate keys, dangling references, cyclic dependencies, oversized
plans, unavailable evidence, and claimed satisfaction without citations are
rejected. Approval binds the previous revision, cited outcome identities, and
current process/session incarnations. Recording a plan does not launch a unit,
change a native workflow, or grant historical owners control. Operational C2
authority applies; this is not an automation configuration change.

Coordination records survive restart. The contract permits 100 records and
24,000 bytes per plan, 50 distinct outcome citations, and 64,000 bytes for a plan
with its retained evidence; these limits are exposed in the manifest. Criteria can be
`unverified`, `blocked`, or `claimed_satisfied`; they cannot self-assert verified
acceptance. Cited `evidenceOutcomeIds` retain source request IDs, dispatch state,
completion facts, and artifact revision when available. Relevance and project
acceptance remain unverified even if a cited command completed. Native SPECOPS
links come from persisted issue inputs and publication receipts, with visit/job
IDs, stage-output digests, routing, and halt evidence. Exercise records expose
contestants and revision-bound test receipts. Titles never establish external
issue/PR links, and workflow completion or a passing test alone never upgrades
project acceptance.

`admission.check` exposes exact assignment and resource checks. Before direct
CENTCOM launches (`unit.create`, `specops.launch`, `exercise.create`, and
`sitrep.handoff`), the engine repeats admission at dispatch. Existing worktree
operation IDs, canonical working-directory aliases, and low memory can block
launch. Unknown ownership or headroom requires Watch Officer review even in
Autonomous C2. The production session launcher repeats checks for every C2-owned
SPECOPS stage, exercise contestant/retry, and nested SitRep launch. A private
workflow provenance record survives restart and retains reviewed host routes,
ROE, contestant presets, and C2 authority. Changed scope blocks further launches.
Legacy workflows traceable to retained C2 launch directives but lacking a policy
halt for fresh review; they cannot silently become unguarded desktop launches.
Known resource/assignment conflicts cannot be waived by approval. Approval covers
only the reviewed unknown conditions in its current call; new unknowns need fresh
review, and later automatic stages receive no indefinite exception.

C2 launches on a host serialize their final inspection/dispatch and refresh
inventory before releasing the next launch. These are admission checks against
observed state, not a global resource reservation against outside processes.
SPECOPS can reuse its owned worktree only for exact recorded predecessors whose
fresh native state is idle/failed/stopped, whose latest correlated turn has a
terminal outcome, and which have no pending requests. Another writer, another
turn, missing ownership/path evidence, or stale identity blocks reuse. The public
admission query cannot supply this private workflow exception.

Pre-dispatch admission/scope failures persist a blocked visit or contestant with
its report. A C2-owned blocked launch can be retried after fresh review even when
it has no active participant yet. Exercise recovery of a partially provisioned
worktree requires fresh Watch Officer review in both authority modes. Its exact
ownership record and Git revision must match the failed contestant, with a clean
worktree, no active provider session, and no live writer at its canonical path.
The review binds every pending recovery revision. The native helper checks it
again under a per-operation launch lock, so changed or concurrently completed
attempts cannot reuse approval. A new launch also requires the ownership record
to remain absent at remote dispatch. Uncertain launched sessions cannot use this
path to resume or replay work. The current reserve is 256 MiB. A reported cgroup
limit without measured headroom remains unknown. Matching repository basenames
alone do not establish a conflict.

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
Provider changes preserve the unresolved reservation. Explicit session reset
stops the reserved provider through the worker and waits for its matching completed
stop receipt before retiring that session. A failed or unconfirmed stop retains
the reservation. This also recovers older startup failures where the assessment
was rejected before a send receipt existed, without replaying the assessment.

Commander creation does not submit an automatic instructions prompt. The first
owned assessment includes the doctrine and waits for provider initialization (or
an older bootstrap turn) to finish before sending. Readiness waits use the turn
deadline; cancellation or timeout before submission leaves no uncertain turn.

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

## Adapter verification and completion gates

The issue checklist and current-head Quality gate are authoritative.
`tests/fixtures/centcom-adapter-coverage.json` maps all 69 advertised operations
onto required production-adapter suites or an explicit unsupported contract.
The core catalog regression rejects omissions, and each native suite checks
that every declared operation actually completed its verification.

Large unit inspections retain the current turn, runtime/control summary, and
bounded pending requests outside the journal preview, within the commander
outcome delivery limit. Native approval/question event names are recognized
when binding a reviewed response.

The three required Linux SSH suites exercise 66 implemented operations through
the real CENTCOM engine, service, SSH transport, native worker, and isolated
repositories. They cover structured questions and approvals (including stale
responses), revision-bound OpOrder enrollment, Git diff/artifact mutations,
configuration readback, SPECOPS retry/cancel, exercise verification/promotion,
SitRep transfers, native attention/Flash Traffic hooks, and terminal control.
Provider and GitHub protocols use local fixtures without credentials, external
service calls, or paid model calls. The GitHub fixture records the actual CLI
arguments; it does not establish live GitHub integration availability.
`unit.resume`, `history.discover`, and `history.cleanup` remain explicitly
unsupported with reasons and no executable handler.

`tests/centcom-bridge.e2e.cjs` verifies the production Electron preload/IPC,
service, SSH transport, remote worker, and provider protocol adapter in disposable
homes and repositories. It creates a reviewed worktree, inspects its unit, denies
and approves input through the UI, reads the correlated native terminal receipt,
verifies artifact bytes/SHA through commander queries, and applies/reads back a
saved preset. It asserts no preapproval mutation and verifies query results
actually delivered to the commander. Required Linux CI runs it under Xvfb and
retains screenshots, outcome evidence, and transport logs. Its provider protocol
fixture performs no model calls; this is not paid-provider or external-host proof.
