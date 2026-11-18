# dsh-pi-acp

![release](https://img.shields.io/github/v/release/zhiyu1998/dsh-pi-acp?style=flat-square)

把 **pi** 编码代理接进 DeepSeek Harness。本插件是 [`pi-acp`](https://github.com/svkozak/pi-acp) 的客户端，
用 ACP（JSON-RPC 2.0 over stdio）驱动它，再把能力暴露成三个模型可调用的工具。

```
DSH 会话 ──pi_run──► 本插件 ──stdio/JSON-RPC──► pi-acp ──rpc──► pi
```

## 安装

前置：`pi` 在 PATH 上且已完成登录（`npm i -g @earendil-works/pi-coding-agent`），以及 `pi-acp`（`npm i -g pi-acp`）。
凭据、模型、技能都沿用 pi 自己的配置（`~/.pi/agent`）。

```powershell
dsh plugin add https://github.com/zhiyu1998/dsh-pi-acp
```

也可以从 [Releases](https://github.com/zhiyu1998/dsh-pi-acp/releases) 下 `dsh-pi-acp-<version>.tgz`
（推 `v*` tag 时由 GitHub Actions 自动打包发布）。

重启 DSH：工具面出现 `pi_run` / `pi_session` / `pi_status`，设置里多出「pi（ACP）」。

## 工具

| 工具 | 作用 |
|---|---|
| `pi_run` | 交给 pi 一个任务，返回回答、工具调用、token 用量、耗时与会话句柄 |
| `pi_session` | `list` 列会话、`close` 关闭、`output` 读进度、`wait` 等结束 |
| `pi_status` | 诊断入口路径、pi-acp / pi 版本、可用模型与 thinking 档位 |

```jsonc
// 开新会话（结果里带 session: "pi1"）
{ "task": "把 src/utils.ts 的日期格式化抽成函数", "cwd": "D:\\repo\\proj" }
// 续同一会话，pi 保留上文
{ "task": "再补一个边界用例", "session": "pi1" }
// DSH 重启后按 pi 的会话 id 重新装载
{ "task": "继续", "resume": "01a1ed2c-c1b4-744a-b9af-b387a025df7e" }
```

## 后台执行

长任务加 `background: true`：立即返回运行中的句柄，不占住一个 turn。

```jsonc
{ "task": "整理 Downloads 顶层目录", "cwd": "C:\\Users\\Administrator\\Downloads", "background": true }
{ "action": "output", "session": "pi1" }                  // 不阻塞地看进度
{ "action": "wait", "session": "pi1", "waitMs": 300000 }  // 阻塞等结束，拿完整结果
```

也可以把「调 `pi_run` 再 `wait`」整段交给 DSH 的 `subagent`，主会话只收摘要。

## 配置

在设置页里改，或直接写 profile 的 `cordis.patch.yml`：

```yaml
- id: pi-acp
  name: 'dsh-pi-acp'
  config:
    model: magpie/auto/deepseek-v4.1-flash
    thinking: low          # off / low / medium / high / max，留空跟随 pi
    defaultCwd: 'D:\repo\proj'
    timeoutMs: 600000      # 单轮墙钟上限
    maxConcurrent: 4
    permission: allow      # allow | deny（pi 的权限询问）
    idleTimeoutMin: 15     # 空闲多久关闭 pi 进程
```

## 设置页

设置里的「pi（ACP）」一级分区：页首一行安装检测（`pi-acp` 版本、`pi` 版本、重新检测，数据来自只读路由
`GET /pi-acp/diagnose`），下面是 DSH 原生表单，编辑思考强度、默认模型、单轮超时、工具权限、并发轮数。

## 排障

- **Windows 上 pi 执行不了命令**：pi 的 `bash` 可能解析到 `C:\Windows\System32\bash.exe`（WSL 启动器）。
  在 `~/.pi/agent/settings.json` 里设 `"shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"`，
  或改用 `"defaultTools": ["read", "powershell", "edit", "write"]`。
- **插件 active 但工具面没有任何 `pi_*`**：DSH 会吞掉插件的 `console.error`，查
  `%USERPROFILE%\pi-acp-import.log`（模块是否被 import）与 `%USERPROFILE%\pi-acp-selftest.log`
  （apply 路径、每个 register 的结果）。两个常见原因是 `output.schema` 用了 `type: [a, b]`（DSH 只认 `oneOf`），
  以及在声明之外探测服务（cordis 会直接抛 `cannot get property … without inject`）。
- **入口解析顺序**：`entryFile` / `DSH_PI_ACP_ENTRY` / `PI_ACP_ENTRY` → npm 全局前缀 → PATH 上的 `pi-acp` shim；
  `pi_status` 会列出所有探测过的路径。

## 测试

```powershell
node tests/probe.mjs "<cwd>" "回答两个字：收到。"   # 裸 ACP 客户端，不依赖 DSH
node tests/verify_register.mjs                      # 按 DSH 规则校验三个工具定义
node tests/test_background.mjs                      # background 端到端
```

## License

MIT
