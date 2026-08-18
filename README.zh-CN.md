# Codexzxm

Codexzxm 是一个私有本地执行控制面，让 ChatGPT 通过 MCP 使用你自己 Windows 或 Apple Silicon Mac 上、受 Codex 本地权限约束的工具。项目基于 Apache-2.0 的 Codexless 演化而来。本地 model-free 执行、ChatGPT Web 订阅推理、以及可选的 Codex Agent 调用是三条独立通道。

当前版本：`0.8.3-preview.0`
默认私有 Surface：`codexzxm-stable-v1`
Stable 工具合同：**121 个已注册 MCP 工具** = 21 个兼容工具 + 100 个私有 Workbench 工具 = 118 个模型可见工具 + 3 个仅供 App 任务卡使用的工具。
只有显式设置 `CODEXZXM_EXPERIMENTAL_PRO_BRIDGE=1` 时，才会恢复 3 个 Pro Bridge 工具，实验 Surface 共 **124 个已注册工具**。

## 直接把这个仓库链接交给 Codex

在一台新电脑上，可以直接把下面这个链接发给 Codex：

```text
https://github.com/1519511/Codexzxm
```
让它**先阅读并严格执行 [CODEX_INSTALL.md](CODEX_INSTALL.md)**。仓库现在是 Public，不需要提前添加 GitHub collaborator。clone、环境检查、安装和 Doctor 可以自动完成；Secure MCP Tunnel 凭据、本机 Codex 权限和 ChatGPT 账号必须由实际安装这台机器的用户自己提供。

受邀测试者如果要在另一台电脑上安装，请先阅读 [`PRIVATE_PREVIEW.md`](PRIVATE_PREVIEW.md)。不要跨用户或跨机器复制 Tunnel 凭据、DPAPI/Keychain、Root Registry、浏览器登录态或 `.workbench` 运行状态；源码可以共享，机器身份、权限和凭据必须逐机建立。维护者侧的发布检查记录见 [`docs/PRIVATE_PREVIEW_RELEASE_AUDIT.md`](docs/PRIVATE_PREVIEW_RELEASE_AUDIT.md)。

## Stable 核心设计

Codexzxm Stable 按永久本地权限设计，**没有临时权限租约**。永久 Root alias 只有在本机 Codex 已经明确授权、且实时解析为 `:danger-full-access` 时才能注册。Codexzxm 可以永久记住并重复使用这个已存在的授权，但不能远程给自己新增 trust，也不能绕开 Codex 的权限上限。

主要能力包括：

- 永久 Root Registry：给 `C:\`、`D:\`、Mac Home、外置盘等已授权根建立稳定 alias。
- 文件系统：受保护的读取、写入、复制、移动、删除、目录树、literal/regex 搜索。
- Durable Process：长进程持久化，Codexzxm 服务重启后仍可重新发现。
- 真 PTY：支持交互式 Shell、REPL、CLI、TUI，可输入、resize、停止并持久发现。
- Secret Broker：Windows DPAPI / macOS Keychain。MCP 只看 `secretRef` 元数据，永远不返回明文；进程和 PTY 启动时可以把 secretRef 直接注入环境变量。
- Git：status/diff/log/stage/commit/branch/stash/fetch/pull/push，强推最高只开放 force-with-lease。
- Browser Agent：在原有 open/navigate/click/fill/select/wait/screenshot/logs 基础上，增加多元素 DOM query、本地文件上传、下载到已授权本地路径。
- Desktop Computer Use：系统安全界面、密码管理器、Terminal、ChatGPT/Codex 自身等保护目标继续硬拒绝；需要 Shell 时走 PTY。
- MCP Hub：在本地授权策略下 model-free 调用其他 MCP server。
- Persistent Workspace：任务、日志、changed files、快照与受保护恢复。
- Workflow Engine：多步骤持久工作流；每个成功副作用立即 checkpoint，失败或服务重启后不会偷偷重放已完成操作。
- Pro Execution Manifest：`codexzxm-pro-execution-manifest-v1`，优先引用永久 root alias，而不在高层计划里写死机器绝对路径。
- 实验性 Pro Web Bridge：Stable 默认关闭。显式启用后才通过已登录的 `chatgpt.com` 标签页尝试订阅内推理；该通道不走 OpenAI API，也不启动 Codex 模型回合，但不属于 Stable Core。
- ChatGPT Image Handoff：把本地文字与参考图交给当前 ChatGPT 会话的内置图像生成路径。
- Codex Agent 仍保留为可选升级通道，不属于默认 model-free 执行路径。

## 永久 Root 权限

安装后，可以给本机已经由 Codex 明确授权的根注册永久 alias：

```text
workbench.root_register(alias="windows-system", cwd="C:\\")
workbench.root_register(alias="windows-data", cwd="D:\\")
```
Mac 可以同样注册 `$HOME`、`/Volumes/Data` 等已经明确授权的根。

`root_status` 会重新校验当前 Codex 权限。如果以后本机 Codex trust/profile 被你主动收回或调整，Codexzxm 会报告 drift 并拒绝继续把该 alias 当成 full authority。这里没有到期时间，也没有临时 lease。

## Secret Broker

Secret 的创建只在本机安全终端完成，不通过模型可见的 MCP 写入明文。

Windows：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\Codexzxm\scripts\codexzxm-secret-set.ps1" `
  -Alias github-main `
  -Description "GitHub credential"
```
macOS：

```sh
"$HOME/Library/Application Support/Codexzxm/app/scripts/codexzxm-secret-set.sh" github-main "GitHub credential"
```
之后 MCP 只能看到 `secretRef=github-main` 等元数据。执行时可以写：

```json
{
  "secretEnv": {
    "GH_TOKEN": "github-main"
  }
}
```
持久化的 Process/PTY 状态只保存引用名，不保存 Secret 明文。

## 实验性 Pro Web Bridge

Pro Web Bridge 在 Codexzxm Stable 中**默认关闭**。原因是实际 `chatgpt.com` 页面上的 Browser/node_repl 运行可能独立超时，而 Stable Core 不应依赖这一层。源码仍然保留，只有明确测试时才开启：

```text
CODEXZXM_EXPERIMENTAL_PRO_BRIDGE=1
```
开启后会恢复 3 个 `workbench.pro_bridge_*` 工具，已注册工具数从 121 回到 124。该实验通道仍然使用已登录的 ChatGPT Web 订阅，不走 OpenAI API；任何发送结果不确定的情况都不得自动重发。

## Workflow 与 Execution Manifest

Stable Workflow 支持 1–50 个 typed steps，统一挂在永久 root alias 下。默认覆盖核心文件操作、Process/PTY、Git、Browser 和 MCP Call；**Stable 默认不包含 `pro_reason`**。

后续步骤可以引用前面步骤的结果：

```text
${steps.step_id.field.path}
```
只有显式设置 `CODEXZXM_EXPERIMENTAL_PRO_BRIDGE=1` 后，Workflow 才会加入 `pro_reason`，并允许等待/轮询原 Pro Bridge 任务。Stable 工作流不依赖它。

Execution Manifest 协议会保存 assumptions、verification、rollback metadata、rootAlias 和 steps，并显式返回：

```text
temporaryPermissionLease = false
apiRouteUsed = false
```
## Windows 安装

```powershell
.\bin\codexzxm-install.cmd
```
默认安装到：

```text
%LOCALAPPDATA%\Codexzxm
```
Tunnel、自启动和凭据配置放在 `%USERPROFILE%\.config\codexzxm`。Secure MCP Tunnel 使用的 ordinary runtime API key 由 Windows DPAPI 保存，因此 staged upgrade 不会再把凭据一起删除。

Windows 的 Startup 启动器通过 `%LOCALAPPDATA%` 动态解析 supervisor，不再把用户目录绝对路径直接写进 ASCII VBS，因此中文等非 ASCII 用户名不会被替换成 `???`。常驻 supervisor 会把 PID、更新时间和 runtime ready 状态写入 `%USERPROFILE%\.config\codexzxm\supervisor\heartbeat.json`；网络/代理中断导致 MCP 子进程或 tunnel-client 退出后，会持续自动拉起 managed runtime。自启动配置如果无法验证一个真实存活的 supervisor 心跳，会明确失败，不再打印假成功。

### HeyGen 本地素材临时 HTTPS 桥（Windows）

HeyGen 生成接口接受公网 HTTPS URL 或 HeyGen asset ID，但当前 HeyGen MCP 没有暴露 Upload Asset 工具。Windows 安装版因此提供“本地文件 → 临时 HTTPS URL”桥接脚本，用来绕开不稳定的网页上传自动化：

```powershell
& "$env:LOCALAPPDATA\Codexzxm\scripts\codexzxm-heygen-share.ps1" `
  -Action Start `
  -Path "C:\path\image.png","C:\path\audio.m4a" `
  -LeaseMinutes 30
```

本地文件服务只监听 `127.0.0.1`，不开放目录列表，每个素材使用随机不可猜路径，支持媒体下载常用的 HTTP Range；脚本复用 `tunnel-client` 同目录的 `cloudflared.exe` 创建临时 `trycloudflare.com` HTTPS 地址。任何拿到完整素材 URL 的人都能在有效期内获取该文件，因此应使用尽可能短的 lease，并在 HeyGen 已完成素材拉取后立即停止：

```powershell
& "$env:LOCALAPPDATA\Codexzxm\scripts\codexzxm-heygen-share.ps1" -Action Stop
```

当 HeyGen 这类重网页导致 Browser/node_repl 超时，或 Computer Use 无法安全判定当前浏览器 URL 时，这条桥接路径是首选兜底；它不会放宽或绕过 Computer Use 的浏览器安全策略。

## Apple Silicon Mac 安装

```sh
sh ./bin/codexzxm-install.sh
```
默认安装到：

```text
~/Library/Application Support/Codexzxm/app
```
Mac 使用独立 Secure MCP Tunnel、macOS Keychain 和 LaunchAgent。详细说明见 [`platform/macos/README.md`](platform/macos/README.md) 与 [`MAC_CODEX_BOOTSTRAP.md`](MAC_CODEX_BOOTSTRAP.md)。

## Windows 与 Mac 同时使用

```text
Codexzxm Windows -> Windows 文件/软件 -> Tunnel A
Codexzxm Mac     -> Mac 文件/软件     -> Tunnel B
```
高层 Workflow 使用永久 root alias 后，可以减少机器路径差异，同时每台机器继续独立执行自己的 Codex 权限边界。

## 开发与测试

```sh
npm ci
npm test
```
精确工具合同固定在 `src/surface-contracts.mjs`。

## 上游与许可

Codexzxm 基于 [liyana31811/Codexless](https://github.com/liyana31811/Codexless) 演化，继续保留 Apache License 2.0 与相关第三方声明。Codexzxm 是独立项目，不是 OpenAI 官方产品或背书。
