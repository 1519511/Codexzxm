# Codexzxm

Codexzxm 是一个私有本地执行控制面，让 ChatGPT 通过 MCP 使用你自己 Windows 或 Apple Silicon Mac 上、受 Codex 本地权限约束的工具。项目基于 Apache-2.0 的 Codexless 演化而来。本地 model-free 执行、ChatGPT Web 订阅推理、以及可选的 Codex Agent 调用是三条独立通道。

当前版本：`0.7.4-preview.0`
私有 Surface：`codexzxm-private-v6.1`
精确工具合同：**124 个 MCP 工具** = 21 个兼容工具 + 103 个私有 Workbench 工具。

## V6.1 的核心设计

V6.1 按永久本地权限设计，**没有临时权限租约**。永久 Root alias 只有在本机 Codex 已经明确授权、且实时解析为 `:danger-full-access` 时才能注册。Codexzxm 可以永久记住并重复使用这个已存在的授权，但不能远程给自己新增 trust，也不能绕开 Codex 的权限上限。

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
- Pro Web Bridge：通过已经登录的 `chatgpt.com` 独立标签页，把推理任务送到页面上真实可见的订阅思考等级（默认 `Pro`），再轮询原任务拿回答案。**不走 OpenAI API，也不启动 Codex 模型回合。**
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

## Pro Web Bridge

这一层专门解决“高推理 Pro 与插件/工具执行面分离”的问题，而且不需要 API Gateway。

```text
支持工具的 ChatGPT 回合
        |
        v
Codexzxm pro_bridge_start(thinking="Pro")
        |
        v
已登录 ChatGPT Web 的独立任务页
        |
        v
订阅内 Pro 推理
        |
        v
pro_bridge_status 拿回答案
        |
        v
Codexzxm Workflow / Execution Manifest 执行
```

Bridge 每次都验证当前页面真实可见的思考等级、Composer 和发送按钮。请求的 `Pro` 不可见时会明确失败，不会偷偷降级；浏览器 mutation 出现 uncertain outcome 时也不会自动重发，避免同一任务提交两次。

## Workflow 与 Execution Manifest

Workflow 支持 1–50 个 typed steps，统一挂在永久 root alias 下。目前覆盖核心文件写操作、Process/PTY、Git、Browser、MCP Call 和 `pro_reason`。

后续步骤可以引用前面步骤的结果：

```text
${steps.step_id.field.path}
```

`pro_reason` 是异步步骤。发送后 Workflow 进入 `waiting`，下一次 `workflow_run` 只轮询原 Pro Bridge 任务；完成以后继续后续执行。

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
