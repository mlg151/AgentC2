# Deployed worker compatibility baseline

`legacy-chat-worker.py` and `chat-protocol-v1.json` are frozen from AgentC2 commit `08c26e6` (v0.4.9). The worker retains the original lifecycle, session ownership, retirement refusal, and health response. The upgrade suite injects a disposable provider adapter and imports the current journal/protocol support modules; it also tests retained journal data through the actual new worker bootstrap. This is lifecycle and wire compatibility evidence, not a frozen historical database migration or live provider SDK test.

Do not regenerate these fixtures merely to pass CI. Future protocol or journal changes need additional historical fixtures and an explicit compatibility/migration implementation that preserves update continuity.
