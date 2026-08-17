# Codexzxm

Codexzxm 是一个私有本地 Agent Runtime，让 ChatGPT 通过 MCP 调用你自己 Windows 或 Apple Silicon Mac 上、受 Codex 本地权限约束的工具。项目基于 Apache-2.0 的 Codexless 演化而来；平时的本地工具执行与真正调用 Codex Agent/模型是两条独立通道。

当前版本：`0.6.0-preview.0`。

## 完整能力

当前私有合同固定为 **88 个 MCP 工具**：21 个兼容工具 + 67 个 Workbench 工具，包括：

- 文件读取、写入、复制、删除和项目搜索
- 可持久化、重启后可重新挂接的长进程
- Git status/diff/log/stage/commit/branch/stash/fetch/pull/push
- Chrome Browser Agent 与运行时恢复
- MCP Hub
- 基于 Codex `@oai/sky` 后端的桌面 Computer Use；终端、密码管理器、Keychain 等受保护目标仍按安全合同拒绝
- 持久 Workspace、任务、日志、快照与恢复
- 本地资料/参考图到当前 ChatGPT 图像生成能力的 image handoff
- 单独的 Codex Agent 升级通道

普通 model-free 工具不会启动 Codex 模型回合。`codex.command_exec` 最长 30 秒，长任务使用 `workbench.process_*`。

## 平台

- Windows
- Apple Silicon macOS（arm64）

需要 Node.js 22+ 和本机可工作的兼容 Codex。Codex 仍然是本地权限与 trust 的最终权威；Codexzxm 不会静默创建 trust，也不会静默抬高 permission profile。

## Windows 安装

```powershell
.\bin\codexzxm-install.cmd
```

默认安装到：

```text
%LOCALAPPDATA%\Codexzxm
```

检查项目：

```powershell
& "$env:LOCALAPPDATA\Codexzxm\bin\codexzxm-doctor.cmd" --cwd "D:\你的项目"
```

Tunnel 和自启动配置不再放在安装目录里，而是放在 `%USERPROFILE%\.config\codexzxm`。普通 `OPENAI_API_KEY` 用 Windows DPAPI 保存；Tunnel ID、profile、代理等非敏感配置单独保存。这样升级安装不会再把凭据一起删掉。

## Apple Silicon Mac 安装

```sh
sh ./bin/codexzxm-install.sh
```

默认安装到：

```text
~/Library/Application Support/Codexzxm/app
```

检查项目：

```sh
"$HOME/Library/Application Support/Codexzxm/app/bin/codexzxm-doctor.sh" --cwd "$HOME/你的项目"
```

Mac 建议单独创建一条 workspace-scoped Secure MCP Tunnel，例如 `codexzxm-mac / Codexzxm Mac`，然后运行：

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/enable-codexzxm-autostart.sh" \
  --alias codexzxm-mac \
  --tunnel-id tunnel_... \
  --tunnel-client /path/to/tunnel-client \
  --permission-profile :danger-full-access
```

普通 runtime API Key 存在 macOS Keychain；非敏感配置放在 `~/.config/codexzxm`；LaunchAgent 负责登录后的自动保持连接。

更完整的 Mac 说明见 [`platform/macos/README.md`](platform/macos/README.md)。如果准备直接让 Mac 上的 Codex 承接安装，把 [`MAC_CODEX_BOOTSTRAP.md`](MAC_CODEX_BOOTSTRAP.md) 整份交给它即可。

## Windows 与 Mac 同时使用

推荐结构：

```text
Codexzxm Windows -> Windows 文件/软件 -> Tunnel A
Codexzxm Mac     -> Mac 文件/软件     -> Tunnel B
```

两台机器不要抢同一个 runtime alias/Tunnel。ChatGPT 里可以明确指定要操作哪台执行主机。

## Image handoff

`workbench.image_handoff_prepare` 可以把本机文字资料和 PNG/JPG/WebP 参考图带进当前 ChatGPT 会话，再由当前 ChatGPT 的内置图像生成能力完成出图。Codexzxm 不会偷偷改走 OpenAI Image API。

## 安全与隐私

不要把普通 API Key、Admin Key、DPAPI 密文、Keychain 导出、机器专属 Tunnel 配置提交到 Git。机器配置只留在 `~/.config/codexzxm`。

详见 [`SECURITY.md`](SECURITY.md)。

## 开发与测试

```sh
npm ci
npm test
```

精确工具合同固定在 `src/surface-contracts.mjs`。

## 上游与许可

Codexzxm 基于 [liyana31811/Codexless](https://github.com/liyana31811/Codexless) 演化，继续保留 Apache License 2.0 与相关第三方声明。Codexzxm 是独立项目，不是 OpenAI 官方产品或背书。
