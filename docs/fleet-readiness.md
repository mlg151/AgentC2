# Fleet readiness and host measurements

The Situation Room header shows the highest supported fleet condition. Open its DEFCON badge to see the contributing units or hosts, event times, observed-agent count, elapsed mission time, and partial provider totals. The level describes operational evidence, not test success.

| Level | Current source |
| --- | --- |
| 1 | SSH inventory lost for a host with a managed unit last seen live |
| 2 | Confirmed repeated-failure fault or a managed OpOrder sync conflict |
| 3 | Connected pending Flash Traffic request or confirmed live-unit input alert |
| 4 | Recent provider hook confirming execution, with no higher-priority source |
| 5 | Every observed managed agent completed or exited, all hosts connected, and no open confirmed alert |

Unknown is shown instead of a level when evidence is insufficient. An idle-looking terminal or live process by itself cannot produce level 4 or 5. Disconnected requests and hosts without active units keep evidence partial. A confirmed prohibited-operation block has no verified cross-provider event in the current gated launch modes, so the header does not infer one from a denied prompt. Readiness is recalculated from current inventory and request state; the panel names its sources and sample times.

The mission clock starts when the workspace is first created or migrated and survives desktop restarts. Each managed tmux pane also shows elapsed time since its remote session creation. Host resources reuse the existing single health poll per host: CPU (after two counter samples), used/total RAM, free/total disk, SSH command round trip including connection and helper startup, and active desktop/companion PTY viewer channels. A GPU probe runs at most every 30 seconds per host via `nvidia-smi`; other GPU stacks are unsupported. GPU samples older than 60 seconds and host samples older than 20 seconds are labeled stale. Unavailable probes stay unknown or unsupported rather than showing zero.

Fleet spend and token totals sum only fresh, provider-reported managed-session estimates. Sessions with the same provider conversation ID on the same host count once. Missing, stale, unsupported, or out-of-scope provider data marks the totals partial; the panel gives the latest measurement time. Individual pane telemetry retains its source and 75%/90% context warnings.

Validation: `npm run test:ci` includes readiness precedence, uncertainty, cost deduplication, and clock fixtures; `python3 tests/remote-helper.py` checks optional GPU parsing; the ten-unit live Electron/SSH workspace suite checks multi-host response, clock restart, host measurements, and transport-loss precedence. [Fleet panel screenshot](screenshots/fleet-readiness.png).
