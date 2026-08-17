# Install Codexzxm with Codex

Target release: `v0.8.2-preview.0`
Repository: `https://github.com/1519511/Codexzxm`

Use this file when a user gives the Codexzxm repository URL to Codex and asks for installation on their own machine.

## Goal

Install and validate Codexzxm locally without copying credentials, tunnel identity, root authority, browser sessions, or machine state from any other user or host.

## Rules

- Treat every machine as a new execution host.
- Do not ask the user to paste Runtime API Keys, Admin API Keys, GitHub tokens, or other secrets into chat.
- Do not copy another user's `%USERPROFILE%\.config\codexzxm`, DPAPI files, macOS Keychain entries, `.workbench`, tunnel profiles, root registry, browser profile, cookies, or login state.
- Do not grant new filesystem authority on behalf of the user. Codexzxm may only reuse authority that local Codex already resolves for that machine.
- Stable default is 121 registered MCP tools. Do not enable `CODEXZXM_EXPERIMENTAL_PRO_BRIDGE=1` during a normal installation.
- Prefer the tagged release `v0.8.2-preview.0` rather than an arbitrary development commit.

## 1. Inspect the machine

Check:

```text
node --version
git --version
codex --version
tunnel-client --version
```

Requirements:

- Node.js 22+
- Git
- local Codex
- `tunnel-client`
- Windows, or Apple Silicon macOS

If a prerequisite is missing, report exactly what is missing before changing unrelated system software.

## 2. Clone the public release

```text
git clone --branch v0.8.2-preview.0 --depth 1 https://github.com/1519511/Codexzxm.git
```

Then enter the checkout and read `README.md`, `README.zh-CN.md`, and the platform-specific instructions before installation.

## 3. Install

Windows:

```powershell
.\bin\codexzxm-install.cmd
```

Default install root:

```text
%LOCALAPPDATA%\Codexzxm
```

Apple Silicon macOS:

```sh
sh ./bin/codexzxm-install.sh
```

Default install root:

```text
~/Library/Application Support/Codexzxm/app
```

## 4. Run Doctor before tunnel setup

Windows:

```powershell
& "$env:LOCALAPPDATA\Codexzxm\bin\codexzxm-doctor.cmd" --cwd "$HOME"
```

macOS:

```sh
"$HOME/Library/Application Support/Codexzxm/app/bin/codexzxm-doctor.sh" --cwd "$HOME"
```

Do not report installation success unless Doctor passes the Stable Core checks. Browser Reader/Computer Use are optional backends and are not required for Stable Core health.

## 5. Create or use this user's own Secure MCP Tunnel

Use `tunnel-client help quickstart` for the current local tunnel-client instructions.

The user needs their own:

- Secure MCP Tunnel / Tunnel ID
- Runtime API Key for the long-running runtime
- appropriate ChatGPT/OpenAI organization/workspace access

An Admin API Key, if needed to create/manage a tunnel, is an administrative credential and must not be persisted in the long-running runtime.

Never reuse the repository maintainer's tunnel ID or runtime credential.

## 6. Configure autostart securely

Windows: have the user enter their Runtime API Key locally with a secure prompt, then run the installed autostart script. Do not print the key.

```powershell
$secure = Read-Host 'Runtime API key' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\Codexzxm\scripts\enable-codexzxm-autostart.ps1" `
  -Alias codexzxm `
  -TunnelId tunnel_xxx

Remove-Item Env:OPENAI_API_KEY
```

Replace `tunnel_xxx` with this user's own Tunnel ID.

The Windows setup must finish with `Hidden supervisor watchdog verified.`. Version 0.8.2 writes a live heartbeat under:

```text
%USERPROFILE%\.config\codexzxm\supervisor\heartbeat.json
```

macOS: follow `platform/macos/README.md` and use the machine's own Keychain-backed credential and LaunchAgent.

## 7. Verify the managed runtime

```text
tunnel-client runtimes status codexzxm --json
```

Do not report tunnel readiness unless the current status shows the managed runtime running and ready. On Windows, also confirm the supervisor heartbeat is recent.

## 8. Connect ChatGPT and test safely

While the tunnel is running, connect the user's own ChatGPT app/workspace to this machine's tunnel using the product UI available to that account/workspace.

Start with a read-only, no-side-effect MCP call. Then test writes only inside a disposable directory that the user has deliberately authorized through local Codex.

Do not start by granting an entire system drive merely to make a test pass.

## Acceptance criteria

Installation is complete only when:

1. The tagged public source cloned successfully.
2. The installed package reports `0.8.2-preview.0`.
3. Doctor passes.
4. The user has a distinct tunnel and runtime credential for this machine.
5. `tunnel-client runtimes status codexzxm --json` reports running/ready.
6. Windows autostart reports a verified supervisor heartbeat, or macOS LaunchAgent health is verified.
7. ChatGPT can call at least one harmless read-only Codexzxm tool through the user's own tunnel.

If the account/workspace does not expose the required ChatGPT MCP capabilities, report that product-level limitation separately from local Codexzxm installation status.