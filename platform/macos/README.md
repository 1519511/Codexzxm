# Codexzxm on Apple Silicon macOS

Codexzxm 0.7.3-preview.0 exposes the same **124-tool** private V6.1 contract on Apple Silicon macOS. The Mac is a separate execution host and must use its own Secure MCP Tunnel alias/name.

## Install

```sh
sh ./bin/codexzxm-install.sh
```

Default install root:

```text
~/Library/Application Support/Codexzxm/app
```

Requirements: Apple Silicon macOS, Node.js 22+, a locally accepted Codex executable, and `tunnel-client` for the remote MCP tunnel.

## Permanent authority

V6.1 does not implement temporary permission leases. Register permanent aliases only for roots that local Codex already resolves to explicit `:danger-full-access` authority, for example:

```text
workbench.root_register(alias="mac-home", cwd="/Users/you")
workbench.root_register(alias="external-data", cwd="/Volumes/Data")
```

The alias remains stored until removed. Each use can revalidate current Codex authority; if local trust/profile is later changed, the alias reports drift and full-authority operations fail closed.

## PTY and filesystem

The Mac surface includes durable real PTY sessions through `node-pty`, guarded file/tree operations, two-phase recursive delete, and `.tar/.tar.gz/.tgz` archive create/extract. Recursive delete uses a planRef plus a fresh digest check and is distinct from permission authority.

## Secret Broker

Create permanent secrets locally with:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/codexzxm-secret-set.sh" github-main "GitHub credential"
```

The value is stored in macOS Keychain. MCP exposes metadata only. Process/PTY `secretEnv` can inject a `secretRef` into a child environment without persisting plaintext.

## Browser and Pro Web Bridge

When the local Codex Chrome backend is available, V6.1 provides browser navigation, semantic actions, DOM query, file upload/download, JS dialog handling, screenshots/logs, and the Pro Web Bridge.

The Pro Web Bridge opens a dedicated already-authenticated `chatgpt.com` tab, verifies the visibly available subscription thinking level (for example `Pro`), submits once, and later polls the same task. It does not use an OpenAI API gateway and does not start a Codex model turn.

Browser/Computer Use availability remains dependent on the actual Mac Codex/Chrome desktop backend. Do not claim live Mac Computer Use support until the installed Mac has passed its own backend probe.

## Tunnel and launchd

Create a separate workspace-scoped tunnel for this Mac, then run:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/enable-codexzxm-autostart.sh" \
  --alias codexzxm-mac \
  --tunnel-id tunnel_... \
  --tunnel-client /path/to/tunnel-client \
  --permission-profile :danger-full-access
```

The ordinary runtime API key is stored in macOS Keychain; non-secret configuration lives under `~/.config/codexzxm`; LaunchAgent `com.codexzxm.tunnel` keeps the runtime connected after login.

Check status:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/codexzxm-tunnel-supervisor.sh" --status
```

Windows and Mac should use separate tunnel aliases so the execution host is unambiguous.
