# Prompt for Codex on the Mac

Use this after cloning the Codexzxm GitHub repository on an Apple Silicon Mac.

```text
Take ownership of installing this Codexzxm repository on this Mac without using a Codex model turn for tasks that can be completed with local tools/commands.

Requirements:
1. Read README.md and platform/macos/README.md first.
2. Verify Apple Silicon, Node.js 22+, Git, local Codex, and tunnel-client. Do not silently install or change system-wide software unless necessary; explain any missing prerequisite.
3. Run the repository's own bin/codexzxm-install.sh. Keep the full private MCP surface; do not replace it with a read-only/reduced surface.
4. Run the installed doctor. If the local Codex version is newer than the accepted compatibility policy, inspect the compatibility code and test the actual authority projection before changing the accepted-version policy. Fail closed rather than guessing.
5. Ensure the intended Mac project/root is explicitly trusted in Codex and that :danger-full-access is an allowed profile if I want the complete file/process/Git/workspace workflow. Do not create trust silently.
6. Locate or install the official OpenAI tunnel-client if it is not already available. Do not invent a download URL; use an official current source.
7. Create a NEW workspace-scoped Secure MCP Tunnel for this Mac, with a distinct alias/name such as codexzxm-mac / Codexzxm Mac. Do not reuse or modify my Windows Codexzxm tunnel.
8. If an OpenAI Admin Key is required to create the remote tunnel, ask me to place it in a local environment variable or secure prompt; never ask me to paste the secret into chat and never write it to the repository.
9. Set an ordinary OPENAI_API_KEY only in the local shell and run the installed enable-codexzxm-autostart.sh with the Mac tunnel ID. The script must store the runtime key in macOS Keychain and non-secret configuration in ~/.config/codexzxm.
10. Verify the LaunchAgent, tunnel remote workspace scope, healthz/readyz, and the installed MCP tool count. Expected private surface: 88 tools for V5.2; use the repository's current declared count if it has advanced.
11. Run tests that are valid on macOS. For Computer Use, report backend availability and test only safe/non-destructive targets. Do not hide unavailable capabilities.
12. Report the final Mac tunnel alias/ID, installed version, tool count, doctor result, and any Mac-only limitations. Never print API/Admin keys.
```
