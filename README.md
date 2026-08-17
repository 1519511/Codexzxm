# Codexzxm

Codexzxm is a private local agent runtime that lets ChatGPT use authority-bounded tools on a user's own Windows or Apple Silicon macOS machine through MCP. It is derived from the Apache-2.0 licensed Codexless project and keeps Codex Agent/model escalation separate from normal model-free local execution.

Current package: `0.6.0-preview.0`.

## Full private surface

The current private contract exposes **88 MCP tools**: 21 compatibility tools plus 67 Workbench tools. It includes:

- authority-bounded filesystem read/write/copy/delete and project search
- durable detached processes with persisted events and restart reattachment
- structured Git status/diff/log/stage/commit/branch/stash/fetch/pull/push
- Chrome Browser Agent and recovery
- generic MCP Hub
- Desktop Computer Use through the Codex `@oai/sky` backend, with protected apps/terminals blocked
- persistent workspaces, tasks, logs, snapshots and restore
- ChatGPT image handoff for local text/reference images
- optional Codex Agent escalation as a separate lane

Normal model-free tools do not start a Codex model turn. `codex.command_exec` is capped at 30 seconds; long-running work belongs in `workbench.process_*`.

## Platforms

- Windows
- Apple Silicon macOS (`arm64`)

Node.js 22+ and a compatible local Codex executable are required. Codex remains the local permission/trust authority. Codexzxm does not silently create trust or grant a stronger permission profile.

## Windows install

```powershell
.\bin\codexzxm-install.cmd
```

Default install root:

```text
%LOCALAPPDATA%\Codexzxm
```

Run doctor:

```powershell
& "$env:LOCALAPPDATA\Codexzxm\bin\codexzxm-doctor.cmd" --cwd "D:\your-project"
```

Tunnel/autostart configuration is intentionally kept outside the install tree under `%USERPROFILE%\.config\codexzxm`. A valid ordinary `OPENAI_API_KEY` is stored with Windows DPAPI; the non-secret tunnel ID/profile/proxy configuration is stored separately. This prevents staged upgrades from deleting the runtime credential.

## Apple Silicon macOS install

```sh
sh ./bin/codexzxm-install.sh
```

Default install root:

```text
~/Library/Application Support/Codexzxm/app
```

Run doctor:

```sh
"$HOME/Library/Application Support/Codexzxm/app/bin/codexzxm-doctor.sh" --cwd "$HOME/your-project"
```

For a Mac execution host, create a **separate workspace-scoped Secure MCP Tunnel**, then configure it with:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/enable-codexzxm-autostart.sh" \
  --alias codexzxm-mac \
  --tunnel-id tunnel_... \
  --tunnel-client /path/to/tunnel-client \
  --permission-profile :danger-full-access
```

The ordinary runtime API key is stored in macOS Keychain. Non-secret config lives under `~/.config/codexzxm`. `launchd` keeps the Mac tunnel alive after login.

See [`platform/macos/README.md`](platform/macos/README.md). If you want Codex on the Mac to perform the installation, give it [`MAC_CODEX_BOOTSTRAP.md`](MAC_CODEX_BOOTSTRAP.md).

## Windows + Mac together

Use distinct execution hosts and distinct tunnel aliases, for example:

```text
Codexzxm Windows -> Windows filesystem/apps -> tunnel A
Codexzxm Mac     -> macOS filesystem/apps   -> tunnel B
```

Do not make the two machines fight over one runtime alias/tunnel. ChatGPT can then target the intended host explicitly.

## ChatGPT image handoff

`workbench.image_handoff_prepare` packages bounded local UTF-8 source excerpts plus PNG/JPG/WebP references into the current ChatGPT conversation. ChatGPT's built-in image generation performs the generation step. Codexzxm itself does not silently call an image API.

## Security and secrets

Never commit runtime/admin API keys, DPAPI ciphertext, Keychain exports, tunnel profiles containing secrets, or machine-specific tunnel configuration. Local runtime state belongs under `~/.config/codexzxm` (or the Windows equivalent using the same home-relative directory).

See [`SECURITY.md`](SECURITY.md).

## Development

```sh
npm ci
npm test
```

The surface contract is pinned in `src/surface-contracts.mjs`.

## Upstream and license

Codexzxm is derived from [liyana31811/Codexless](https://github.com/liyana31811/Codexless) and retains the Apache License 2.0 and applicable third-party notices. Codexzxm is an independent project and is not an OpenAI product or endorsement.
