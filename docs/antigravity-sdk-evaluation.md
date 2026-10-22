# Antigravity SDK deployment and compatibility

Production structured chat now uses `google-antigravity==0.1.22`, superseding the earlier CLI-only delivery and SDK deferral. The host daemon automatically prepares a private Python environment and installs the pinned PyPI wheel, including its compiled runtime. No manual SDK or `agy` installation is needed for structured chat. Terminal launches continue to use the host CLI.

SDK authentication uses a Gemini API key or Vertex configuration on the execution host. CLI cached credentials and CLI conversation databases are separate and are not represented as compatible. SDK-native resume requires a conversation created in AgentC2's SDK storage; CLI-native resumes direct the user to Terminal without creating another conversation.

Full mode explicitly allows SDK tools; gated chat uses SDK safe-default policies with one-shot AgentC2 approval callbacks. Provider-default retains SDK default policy. Streaming, tool events/results, question-option mapping, interruption, native persistence/resume, cumulative token usage, and unknown cost/context are connected to the worker journal. Attachments, steering, and forks remain disabled.

`python3 tests/chat-runtime.py` boots a disposable daemon, installs both provider SDKs in its private environment, verifies pinned versions and reuse, then runs four Antigravity SDK/harness and eight Claude SDK/bundled-CLI boundary tests against loopback models. Antigravity cases include streaming/resume context, gated deny/allow file witnesses, stale decisions, question mapping, pending-approval interruption, and rejection of CLI history. These checks use no cloud model calls or user credentials. They do not establish live Gemini/Vertex account support or native macOS/WSL runtime validation.

Sources checked October 22, 2026:

- [Official SDK product and wheel deployment](https://antigravity.google/product/antigravity-sdk/)
- [SDK overview and authentication](https://antigravity.google/docs/sdk/overview/)
- [SDK policies](https://antigravity.google/docs/sdk/policies/)
- [SDK persistence and lifecycle](https://antigravity.google/docs/sdk/lifecycle/)
- [SDK streaming](https://antigravity.google/docs/sdk/structured-output)

The earlier `tests/antigravity-sdk-evaluation.py` persistence probe is retained as historical evidence. CLI-only adapter regression fixtures do not establish SDK behavior.
