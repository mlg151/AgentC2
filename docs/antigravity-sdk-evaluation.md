# Antigravity SDK evaluation

Decision: defer production SDK adoption. Keep the pinned Antigravity CLI stream adapter for this delivery. The SDK is a separate runtime with useful richer controls; compatibility with existing CLI authentication and conversations remains unverified.

Evaluated on 2026-10-22: `google-antigravity==0.1.22`, installed into an isolated temporary Python target. Production CLI adapter: `agy 1.4.4`. The SDK is not a production dependency.

| Area | Evidence and conclusion |
| --- | --- |
| Authentication | The official SDK quickstart uses a Gemini API key; Enterprise configuration uses Vertex and Google Cloud credentials. Local OpenAI-compatible endpoints work without cloud credentials in the isolated test. CLI cached-login/subscription parity is **unknown** and must not be inferred. |
| Streaming and tools | Package source exposes streamed responses, builtin/custom tools, hooks, policies, MCP, and subagents. These are SDK capabilities, not capabilities enabled in AgentC2's CLI adapter. |
| Approvals | SDK policies and hooks support decisions before tools execute. Production adoption needs correlated one-shot decisions, cancellation, and stale-response tests through the worker. |
| Attachments | Official structured-output documentation and SDK types expose richer content. AgentC2 currently accepts text only; attachments remain disabled. |
| Persistence | A real installed SDK harness created a private fixture conversation database and transcript files. A second harness resumed the same ID and included the first prompt in its next loopback model request. |
| CLI history | Import/export or direct CLI conversation reuse has **not** been verified. No real user CLI history or credentials were used. Native SDK persistence is not evidence of CLI compatibility. |
| Operational impact | SDK deployment adds a Python package and bundled harness, explicit policy configuration, authentication setup, and separate storage management. These requirements differ from launching the installed CLI. |

Reproduce the persistence evidence with `python3 tests/antigravity-sdk-evaluation.py` in an isolated environment containing the pinned package. The test uses a disposable directory and loopback HTTP model fixture, disables tools, closes both SDK harnesses, and removes its fixtures. Without the package it reports a skip. It does not contact a live model service, verify billing, or establish production CLI interoperability.

An exploratory negative check also found that passing a nonexistent conversation ID to the default SDK continuation path attempts resume and fails. Create without an ID, persist the returned native ID, and resume explicitly.

Before adoption, validate supported account authentication on an explicitly chosen test host, round-trip disposable CLI/SDK conversations, test approval/attachment cancellation and reconnect, verify configuration/ROE parity, and document storage migration and rollback. Until then, keep SDK capabilities separate and use the CLI adapter's honest unsupported states for approval responses, attachments, forks, and native-history import.

Sources checked on 2026-10-22:

- [Official SDK overview and authentication setup](https://www.antigravity.google/docs/sdk/overview/)
- [SDK local models](https://www.antigravity.google/docs/sdk/local-models/)
- [SDK policies](https://www.antigravity.google/docs/sdk/policies/)
- [SDK lifecycle and persistence](https://www.antigravity.google/docs/sdk/lifecycle/)
- Installed 0.1.22 source: `Agent`, `AgentConfig`, `LocalOpenAIAgentConfig`, `SessionContinuationMode`, and local connection strategy.
