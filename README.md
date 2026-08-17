# Codexzxm

Codexzxm is a private local execution plane that lets ChatGPT use authority-bounded tools on the user's own Windows or Apple Silicon macOS machine through MCP. It is derived from the Apache-2.0 licensed Codexless project. Local model-free execution, ChatGPT Web subscription reasoning, and optional Codex Agent escalation are separate lanes.

Current package: `0.7.0-preview.0`
Private surface: `codexzxm-private-v6.1`
Exact tool contract: **124 MCP tools** = 21 compatibility tools + 94 private Workbench tools.

## V6.1 design

V6.1 is built around permanent local authority. It deliberately has no temporary permission lease system. A permanent root alias may be registered only when the local Codex authority resolver already proves that root is explicitly trusted and currently resolves to `:danger-full-access`. Codexzxm can remember and reuse that authority, but cannot grant itself a new trusted root.

Key layers:

- Permanent Root Registry: stable aliases such as `windows-system`, `windows-data`, `mac-home`, or `external-ssd`.
- Filesystem: guarded read/write/copy/move/delete, tree inspection, literal/regex project search.
- Durable processes: detached processes with persisted events and restart reattachment.
- True PTY: interactive shells, REPLs, CLIs and TUIs with input, resize, stop and durable rediscovery.
- Secret Broker: Windows DPAPI / macOS Keychain metadata references; plaintext is never returned over MCP. Process/PTY launch can inject `secretRef` values directly into environment variables at runtime.
- Git: status/diff/log/stage/commit/branch/stash/fetch/pull/push with force-with-lease only.
- Browser Agent: open/navigate/click/fill/select/wait/screenshot/logs plus multi-element DOM query, authority-bounded file upload, and authority-bounded downloads.
- Desktop Computer Use: protected apps and terminals remain hard-refused; direct shell work belongs in the PTY lane.
- MCP Hub: model-free discovery and calls into locally authorized external MCP servers.
- Persistent workspaces: tasks, logs, changed files, snapshots and guarded restore.
- Workflow Engine: checkpointed multi-step execution; completed mutations are persisted immediately and are not silently replayed after failure or restart.
- Pro Execution Manifest: `codexzxm-pro-execution-manifest-v1`, rooted in permanent aliases instead of machine-specific paths.
- Pro Web Bridge: route a reasoning task to a dedicated logged-in `chatgpt.com` tab using a visibly available subscription thinking level such as `Pro`, then poll the original task and return the resulting answer. It uses the user's ChatGPT Web subscription, not an OpenAI API route, and it does not start a Codex model turn.
- ChatGPT image handoff: package local text/reference images for the current conversation's built-in image generation path.
- Optional Codex Agent escalation remains separate and is never the default model-free path.

## Permanent roots

After installation, register roots that are already explicitly authorized by local Codex:

```text
workbench.root_register(alias="windows-system", cwd="C:\\")
workbench.root_register(alias="windows-data", cwd="D:\\")
```

On macOS, analogous aliases can point to explicitly trusted roots such as `$HOME` or `/Volumes/Data`.

`root_status` revalidates current authority. If Codex trust/profile changes, Codexzxm reports drift and refuses to treat the stored alias as full authority. There is no expiry timer and no automatic self-renewal because there is no lease model.

## Secret Broker

Secret values are created locally, outside the model-visible tool surface.

Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\Codexzxm\scripts\codexzxm-secret-set.ps1" `
  -Alias github-main `
  -Description "GitHub credential"
```

macOS:

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/codexzxm-secret-set.sh" github-main "GitHub credential"
```

MCP can list only metadata such as `secretRef=github-main`. For execution, pass a mapping such as:

```json
{
  "secretEnv": {
    "GH_TOKEN": "github-main"
  }
}
```

The persisted process/PTY state stores the reference name, not the plaintext secret.

## ChatGPT Pro Web Bridge

The bridge solves a product-surface mismatch without using an API gateway. A tool-capable ChatGPT turn invokes Codexzxm; Codexzxm then uses the already logged-in Chrome ChatGPT Web session to create a dedicated reasoning task, verifies the visible thinking-level UI, sends exactly once, and later polls that same task.

```text
ChatGPT tool-capable turn
        |
        v
Codexzxm pro_bridge_start(thinking="Pro")
        |
        v
Dedicated logged-in ChatGPT Web tab
        |
        v
Subscription Pro reasoning
        |
        v
pro_bridge_status -> answer
        |
        v
Codexzxm Workflow / Execution Manifest
```

The bridge fails visibly when the requested thinking level is not shown, when the account is not signed in, or when a browser mutation has an uncertain outcome. It does not silently downgrade the requested level and does not automatically replay an uncertain send.

## Workflow and execution manifests

A workflow has 1-50 typed steps and a permanent root alias. Supported steps cover core filesystem writes, process/PTY starts, Git mutations, browser operations, MCP calls, and `pro_reason`.

Step results can be referenced by later steps:

```text
${steps.step_id.field.path}
```

`pro_reason` is asynchronous: the workflow enters `waiting`; the next `workflow_run` polls the original Pro Bridge task and continues only after it completes.

The execution manifest protocol records assumptions, verification goals, rollback metadata, root alias and workflow steps. It explicitly reports:

```text
temporaryPermissionLease = false
apiRouteUsed = false
```

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

Tunnel/autostart configuration lives outside the install tree under `%USERPROFILE%\.config\codexzxm`. The ordinary runtime API key used by Secure MCP Tunnel is stored with Windows DPAPI. Staged upgrades therefore do not delete the runtime credential.

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

Use a separate Mac Secure MCP Tunnel, macOS Keychain for runtime/secret credentials, and the included LaunchAgent supervisor. See [`platform/macos/README.md`](platform/macos/README.md) and [`MAC_CODEX_BOOTSTRAP.md`](MAC_CODEX_BOOTSTRAP.md).

## Windows + Mac together

Use distinct execution hosts and tunnel aliases:

```text
Codexzxm Windows -> Windows filesystem/apps -> tunnel A
Codexzxm Mac     -> macOS filesystem/apps   -> tunnel B
```

Permanent root aliases make higher-level workflows portable while each host continues to enforce its own local Codex authority.

## Development

```sh
npm ci
npm test
```

The exact surface contract is pinned in `src/surface-contracts.mjs`.

## Upstream and license

Codexzxm is derived from [liyana31811/Codexless](https://github.com/liyana31811/Codexless) and retains the Apache License 2.0 and applicable third-party notices. Codexzxm is an independent project and is not an OpenAI product or endorsement.
