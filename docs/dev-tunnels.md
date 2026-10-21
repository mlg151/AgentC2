# Development server tunnels

When a remote unit prints an `http://` or `https://` URL with an explicit `localhost`, `127.0.0.1`, or `[::1]` port, AgentC2 shows a **Tunnel :port** action in that unit's toolbar. Select it to open the remote server in your desktop browser. The detected URL is only a hint; AgentC2 checks that the server responds before reporting the tunnel as ready. The mapped local URL keeps the original path, query, and fragment. Several units on the same SSH host can share one forward for the same loopback address and port.

Tunnel startup uses the configured SSH target and strict host-key verification. The local listener binds only to `127.0.0.1`; the remote destination is restricted to loopback. A failed server or SSH connection is shown as **Retry :port**. Active forwards retry after SSH loss and close when their last attached unit detaches or the app quits. To open detected servers without selecting each action, enable **Auto-forward detected localhost URLs** for that SSH host in Settings. This preference is off by default.

These desktop-local URLs are separate from the paired web companion and Tailscale gateway. They are not automatically reachable from a phone. AgentC2 does not record URL paths or query strings in tunnel error logs.
