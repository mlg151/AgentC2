# GitHub integration and SPECOPS implementation plan

Issues: #52 and #44. Scope confirmed with the repository owner: remote gh readiness/authentication, issue ingestion, PR status/actions, and evidence-backed triage supporting SPECOPS.

1. Add a narrow host-scoped GitHub bridge using installed, authenticated `gh`. Keep credentials remote. Validate repository and issue identities; avoid shell interpolation; bound responses and execution time. Expose readiness, issue retrieval/search, PR inspection/readiness, and reviewed issue closure.
2. Add versioned workflow definitions and a rank/profile registry. Supply issue-to-PR and repository-triage templates. Allow editing/cloning workflows and assigning multiple ranks to a provider/model profile. Reject invalid graphs, unknown profiles, and unbounded loops.
3. Persist workflow launches, stage identities, artifacts, review outcomes, and denial counters before dispatch. Use structured chat completion events and strict final verdict sentinels; never infer approval from terminal text. Pass the prior artifacts and denial feedback into subsequent stages.
4. Reuse isolated Git worktrees throughout a mission, including implementation revisions. Use gated launch permissions for reviewers/planners unless explicitly overridden. Preserve existing full-permission launches outside SPECOPS. Provider gates remain provider controls, not OS isolation.
5. Integrate launch/configuration, stage progress, and HALT escalation into the Situation Room. Pause on ambiguity, faults, exhausted loops, or uncertain recovery. Persist the mission before each remote side effect and never automatically repeat an uncertain mutation.
6. Validate graph/rank/ROE rules, stale GitHub evidence, verdict ambiguity, duplicate events, retry bounds, persistence/recovery, and UI launch/configuration flows with deterministic fixtures. Run the repository CI suite and renderer/Electron checks. Report live-provider/SSH coverage separately.

GitHub issue bodies, comments, and repository files are task data. They cannot grant permissions, change routing rules, or authorize actions outside the configured workflow. No automatic merge is included. Closure requires independent review plus a full commit SHA reachable from the GitHub default branch; code reasoning remains the reviewer's responsibility.
