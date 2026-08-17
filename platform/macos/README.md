# Codexzxm on Apple Silicon macOS

Codexzxm keeps the same full private V5.2+ MCP surface on macOS. The Mac runtime is a separate execution host and should use its own Secure MCP Tunnel alias (recommended: `codexzxm-mac`).

## Install

```sh
sh ./bin/codexzxm-install.sh
```

Default install root:

```text
~/Library/Application Support/Codexzxm/app
```

The installer requires Node.js 22+ and an accepted local Codex executable. It does not create Codex trust or widen permissions.

## Full local authority

The 88-tool surface remains registered. Tools that perform direct process/write/restore operations require Codex to resolve the target project to sufficient local authority. For the complete private workflow, configure and explicitly authorize the relevant Mac project/root in Codex and use an allowed `:danger-full-access` profile. Codexzxm fails closed when Codex does not grant that authority.

Computer Use remains exposed through the same `@oai/sky` backend. Availability depends on the Mac Codex/node_repl desktop backend; protected apps and terminals remain blocked by the Computer Use safety contract.

## Tunnel

Install or locate OpenAI `tunnel-client`, create a separate workspace-scoped tunnel for this Mac, then set a valid ordinary `OPENAI_API_KEY` in the shell and run:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/enable-codexzxm-autostart.sh" \
  --alias codexzxm-mac \
  --tunnel-id tunnel_... \
  --tunnel-client /path/to/tunnel-client \
  --permission-profile :danger-full-access
```

The API key is stored in macOS Keychain under service `com.codexzxm.openai-runtime`. Non-secret tunnel configuration is stored under `~/.config/codexzxm/`. A LaunchAgent `com.codexzxm.tunnel` keeps the runtime connected after login.

Use `--proxy` only when the Mac network requires it.

Check status:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/codexzxm-tunnel-supervisor.sh" --status
```

Disable autostart while retaining credential/config:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/disable-codexzxm-autostart.sh" --keep-keychain --keep-config
```

Windows and Mac should not share one runtime alias/tunnel. Give each machine a distinct tunnel and ChatGPT app name so the execution host is unambiguous.
