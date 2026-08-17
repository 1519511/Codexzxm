# Prompt for Codex on the Mac

Use this after cloning the private Codexzxm GitHub repository on an Apple Silicon Mac.

```text
Take ownership of installing and validating this Codexzxm repository on this Mac. Do not start a Codex model turn for work that can be completed with local model-free commands/tools.

Requirements:
1. Read README.md and platform/macos/README.md first.
2. Verify Apple Silicon, Node.js 22+, Git, local Codex, and tunnel-client. Do not silently change system-wide software.
3. Run bin/codexzxm-install.sh and preserve the full private V6.1 surface. Expected current contract: 124 tools. Do not replace it with a read-only/reduced surface.
4. Run the installed doctor. If the local Codex build is newer than the accepted compatibility policy, inspect and test the actual authority projection before modifying the version gate. Fail closed rather than guessing.
5. Configure the intended Mac roots in local Codex with explicit permanent trust/authority as required. Codexzxm must never create Codex trust by itself.
6. Register stable permanent root aliases for the roots I authorize, such as mac-home and external-data. There is no temporary permission lease model.
7. Test true PTY, process persistence, Git, guarded tree copy/delete-plan/delete-commit, and tar archive create/extract in a disposable fixture.
8. Verify Secret Broker metadata and Keychain integration without printing any plaintext secret. Secret creation must use the local secure prompt script.
9. Verify the Chrome backend if available: DOM query, safe test upload/download, back/forward/dialog behavior, and browser recovery. Do not claim unavailable backend features.
10. Verify Pro Web Bridge against a dedicated logged-in ChatGPT Web tab with a harmless test prompt. It must use the visible subscription Pro thinking level, must not use OpenAI API billing, and must not start a Codex model turn. If a browser mutation outcome is uncertain, do not automatically resend it.
11. Verify Workflow and codexzxm-pro-execution-manifest-v1 checkpointing: completed mutations must not replay after failure/restart; pro_reason must wait/poll the original Pro Bridge task.
12. Create a NEW workspace-scoped Secure MCP Tunnel for this Mac with a distinct alias/name such as codexzxm-mac / Codexzxm Mac. Do not reuse or modify the Windows tunnel.
13. If an OpenAI Admin Key is needed only for tunnel creation, have me enter it locally/securely; never paste or persist it in the repository. Store the ordinary runtime key in macOS Keychain through the provided autostart script.
14. Verify LaunchAgent, remote workspace scope, healthz/readyz, installed version, exact MCP tool count, and npm tests that are valid on macOS.
15. Report installed version, tool count, permanent roots, tunnel alias/ID, doctor/test results, and any Mac-only limitation. Never print secrets.
```
