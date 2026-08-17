# Codexzxm Private Preview 安装指南

适用版本：`0.8.2-preview.0`

这份指南面向受邀测试者。Codexzxm 会把 ChatGPT 通过 MCP 连接到测试者自己的 Windows 或 Apple Silicon macOS，并在本机 Codex 已经明确授权的范围内执行文件、Git、进程、PTY、浏览器、Workflow 等操作。

重要：每位测试者都必须使用自己的 GitHub 访问权限、自己的 OpenAI Tunnel、自己的 Runtime API Key、自己的本机 Codex 授权和自己的 ChatGPT 账号。不要复制其他人的 Tunnel、DPAPI/Keychain 凭据、`.workbench`、Root Registry 或本机配置目录。

## 1. 先确认 ChatGPT 侧能力

OpenAI 当前将完整 MCP 写入/修改能力提供给 Business、Enterprise 和 Edu 的 beta；Pro 可以在 developer mode 中连接自定义 MCP，但官方当前仅承诺 read/fetch 权限。产品能力可能继续变化。

官方说明：

- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

因此，安装成功并不等于所有账号都能在 ChatGPT 中看到或调用全部 Stable 写入工具。Codexzxm Stable 本身默认注册 121 个 MCP 工具；最终可见和可调用的工具仍受 ChatGPT 产品权限、工作区策略和本机 Codex 权限共同约束。

## 2. 获取公开仓库并检查前置环境

仓库：

```text
https://github.com/1519511/Codexzxm
```

仓库已经公开，不需要 collaborator 邀请，可以直接 clone。

Windows：

```powershell
git clone https://github.com/1519511/Codexzxm.git
cd Codexzxm
node --version
git --version
codex --version
tunnel-client --version
```

macOS：

```sh
git clone https://github.com/1519511/Codexzxm.git
cd Codexzxm
node --version
git --version
codex --version
tunnel-client --version
```

要求 Node.js 22+。macOS 当前面向 Apple Silicon。

## 3. 安装 Codexzxm

Windows：

```powershell
.\bin\codexzxm-install.cmd
```

默认安装到：

```text
%LOCALAPPDATA%\Codexzxm
```

macOS：

```sh
sh ./bin/codexzxm-install.sh
```

默认安装到：

```text
~/Library/Application Support/Codexzxm/app
```

## 4. 先运行 Doctor

Windows：

```powershell
& "$env:LOCALAPPDATA\Codexzxm\bin\codexzxm-doctor.cmd" --cwd "$HOME"
```

macOS：

```sh
"$HOME/Library/Application Support/Codexzxm/app/bin/codexzxm-doctor.sh" --cwd "$HOME"
```

Doctor 失败时先解决 Node、Codex、权限或 tunnel-client 问题，不要直接扩大文件系统权限。

## 5. 为这台机器单独创建 Secure MCP Tunnel

ChatGPT 不能直接连接本机 MCP。对于开发机或私有网络里的 MCP server，使用 Secure MCP Tunnel。

管理入口：

```text
https://platform.openai.com/settings/organization/tunnels
```

Runtime API Key：

```text
https://platform.openai.com/settings/organization/api-keys
```

Admin API Key（只有创建/管理 Tunnel 时才需要）：

```text
https://platform.openai.com/settings/organization/admin-keys
```

权限原则：

- 长期运行的 tunnel-client 使用 Runtime API Key。
- Runtime key 对目标 Tunnel 需要 Read + Use。
- Tunnel 的创建、删除、修改需要相应 Manage 权限。
- Admin key 不得交给长期运行的 daemon，也不要写入仓库、脚本、聊天或配置文件。
- 每台电脑使用独立 Tunnel alias，建议类似 `codexzxm-zhang-laptop`、`codexzxm-macbook`，不要复用别人的 Tunnel。

如果需要查看 tunnel-client 自带的最新官方操作说明：

```text
tunnel-client help quickstart
```

## 6. 把 Runtime API Key 安全交给本机自启动配置

Windows 建议在当前 PowerShell 会话中无回显读取 Runtime API Key：

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
  -Alias codexzxm-friend `
  -TunnelId tunnel_xxx

Remove-Item Env:OPENAI_API_KEY
```

脚本会把长期运行凭据保存为当前 Windows 用户绑定的 DPAPI 密文，配置位于仓库之外的 `%USERPROFILE%\.config\codexzxm`。

macOS：

```sh
read -s OPENAI_API_KEY
export OPENAI_API_KEY
"$HOME/Library/Application Support/Codexzxm/app/scripts/enable-codexzxm-autostart.sh" \
  --alias codexzxm-friend \
  --tunnel-id tunnel_xxx
unset OPENAI_API_KEY
```

macOS 使用本机 Keychain/受保护配置和 LaunchAgent。不要把 Keychain 导出物提交到 Git。

## 7. 在 ChatGPT 中连接自己的 MCP App

保持 tunnel-client 处于 running/ready 状态后，在 ChatGPT 的 Apps / developer mode 中创建或连接自定义 MCP App，并选择这台机器对应的 Secure MCP Tunnel。

可先在本机确认：

```text
tunnel-client runtimes list
```

以及：

```text
tunnel-client runtimes status codexzxm-friend --json
```

ChatGPT 当前的 developer mode、Apps 和完整 MCP 权限会随套餐和工作区策略变化，以 OpenAI 当前官方说明为准。

## 8. 只授权你确实需要的本机目录

Codexzxm 不能替本机 Codex 创建新的 trust。Root alias 只有在本机 Codex 已经明确把目标路径解析为相应权限时才能注册。

建议第一次测试只授权一个测试目录，例如：

```text
D:\Codexzxm-Test
```

或：

```text
~/Codexzxm-Test
```

确认读写、Git、Process 和 PTY 均符合预期后，再决定是否扩大到更高层目录。

如果确实已经在本机 Codex 中明确授权，可在 MCP 侧注册稳定 alias，例如：

```text
workbench.root_register(alias="windows-data", cwd="D:\\")
```

不要因为“工具能申请更高权限”就把整个系统盘交给测试环境。Codexzxm 的设计是复用既有本机授权，不是绕过授权。

## 验收标准

完成后至少确认以下项目：

1. `codexzxm-doctor` 通过。
2. `tunnel-client runtimes status <alias> --json` 显示 runtime 正常运行且 ready。
3. ChatGPT 能识别 Codexzxm App，并能调用一个无副作用的读取工具。
4. 测试目录能正确读取；未授权目录不能被 Codexzxm 自行扩大权限访问。
5. Runtime API Key 未出现在 Git、终端历史、聊天记录或仓库文件中。
6. 重启电脑后 Tunnel supervisor 能恢复。
7. 如果账号只有 read/fetch 权限，不把“写入工具不可用”误判为 Codexzxm 安装失败。

## 绝对不要复制给朋友的内容

不要复制另一台机器的以下内容：

- `%USERPROFILE%\.config\codexzxm`
- `control-plane.dpapi`
- macOS Keychain 中的 Codexzxm 凭据
- `.workbench/`
- Tunnel runtime profile
- Runtime API Key / Admin API Key
- Permanent Root Registry 状态
- 浏览器登录态、Cookie、用户数据目录

仓库源码可以共享；机器身份、权限和凭据必须逐机重新建立。
