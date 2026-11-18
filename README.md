# dsh-pi-acp

把 **pi** 编码代理接进 DeepSeek Harness：本插件是 `pi-acp`（ACP 适配器）的**客户端**，
以 ACP JSON-RPC 2.0 over stdio 驱动它，再用三个模型可调用的工具暴露出来。

```
DSH 会话 ──pi_run──► 本插件(AcpTransport) ──stdio/JSON-RPC──► pi-acp ──rpc──► pi
```

## 工具

| 工具 | 作用 |
|---|---|
| `pi_run` | 把一个任务交给 pi 执行；返回 pi 的最终回答、它调用的工具、token 用量、耗时与会话句柄 |
| `pi_session` | `list` 列出本插件持有的 pi 会话，`close` 关闭一个或全部 |
| `pi_status` | 诊断：解析到的 `pi-acp` 入口、pi-acp / pi 版本、可用模型与 thinking 档位 |

`pi_run` 的会话复用：

```jsonc
// 第一次：开新会话，结果里带 session: "pi1"
{ "task": "把 src/utils.ts 里的日期格式化抽成函数，并补测试", "cwd": "D:\\repo\\proj" }
// 第二次：接同一会话，pi 保留上文
{ "task": "再补一个边界用例", "session": "pi1" }
// DSH 重启后：用 pi 的会话 id 重新装载
{ "task": "继续", "resume": "01a1ed2c-c1b4-744a-b9af-b387a025df7e" }
```

## 前置条件

1. `pi` 在 PATH 上：`npm i -g @earendil-works/pi-coding-agent`（≥ 0.81.0），并已在终端跑过一次 `pi` 完成登录／配置模型。
2. `pi-acp` 已安装：`npm i -g pi-acp`（本插件实测 0.0.34）。
3. 不需要在 `pi-acp` 里配任何东西；凭据、模型、技能都沿用 pi 自己的配置（`~/.pi/agent`）。

## 安装本插件

```powershell
# A. 从 GitHub 装（插件管理器支持 Git 仓库 / 本地目录 / npm 包名）
dsh plugin add https://github.com/zhiyu1998/dsh-pi-acp

# B. 本地目录（改完代码重启即生效，适合自己改）
dsh plugin add C:\Users\Administrator\Documents\dsh-pi-acp
```

装完重启一次 DSH：工具面出现 `pi_run` / `pi_session` / `pi_status`，设置里多出「pi（ACP）」一级分区。

手工方式（等价）：在 profile 的 `cordis.patch.yml` 末尾插入

```yaml
- insert:
    - id: pi-acp
      name: 'dsh-pi-acp'
```

包名是 `dsh-pi-acp`（不带 `@local/` 前缀）。

## Windows：pi 需要一个能用的 bash

pi 的 `bash` 工具按 `settings.json` 的 `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` →
`%ProgramFiles(x86)%\Git\bin\bash.exe` → PATH 上的 `bash.exe` 依次解析。若机器上只有
`C:\Windows\System32\bash.exe`（WSL 启动器）而没有 WSL 发行版，pi 每次执行命令都会报
「适用于 Linux 的 Windows 子系统没有已安装的发行版」，插件本身正常但 pi 干不了活。两种修法：

```jsonc
// ~/.pi/agent/settings.json —— 指向任何真实 bash（Git for Windows / PortableGit / MSYS2）
{ "shellPath": "C:\\Program Files\\PortableGit\\bin\\bash.exe" }
```

或让 pi 改用原生 PowerShell 工具：`{ "defaultTools": ["read", "powershell", "edit", "write"] }`。

## 入口解析顺序

`command` → `entryFile` / `DSH_PI_ACP_ENTRY` / `PI_ACP_ENTRY` → PATH 里各目录下的
`node_modules/pi-acp/dist/index.js`（即 npm 全局前缀）→ PATH 上的 `pi-acp` / `pi-acp.cmd` shim。
解析不到时 `pi_status` 会列出全部探测过的路径。

Node 二进制优先用 shim 同目录下的 `node.exe`（Electron 宿主里 `process.execPath` 是应用本身，不能用），
可用 `PI_ACP_NODE` 覆盖。

## 配置（profile patch 覆盖）

```yaml
- id: pi-acp
  name: 'dsh-pi-acp'
  config:
    defaultCwd: 'D:\repo\proj'      # 不传 cwd 时的会话目录
    model: magpie/auto/deepseek-v4.1-flash
    thinking: low
    timeoutMs: 600000               # 单轮墙钟预算
    idleTimeoutMin: 15              # 空闲多久关闭 pi 进程
    maxConcurrent: 4
    permission: allow               # allow | deny（pi 的扩展 UI 授权提示）
    entryFile: ''                   # 显式指定 pi-acp/dist/index.js
```

## 实现要点

- 传输：`initialize` → `session/new`（或 `session/load`）→ `session/prompt`，
  帧格式为行分隔 JSON；`session/update` 通知在这里折成一次工具结果。
- `agent_message_chunk` 里 pi-acp 会先吐一段启动信息（版本/技能清单），插件按
  `session/new` 返回的 `_meta.piAcp.startupInfo` 精确剔除，回答里不会混入。
- 同一会话的并发调用被 `busy` 标记挡住；跨会话并发受 `maxConcurrent` 限制。
- 每轮有超时与 AbortSignal 两条中止路径，都会先发 `session/cancel` 再取回部分输出。
- pi 自己执行工具（读文件、跑命令），本插件不代理 `fs/*` 与 `terminal/*`。

## 验证

```powershell
node tests/probe.mjs "<cwd>" "回答两个字：收到。不要调用任何工具。"
```

`tests/probe.mjs` 是不依赖 DSH 的裸 ACP 客户端，用来单独确认 pi-acp 链路。

## 后台执行（0.2.0）

默认 `pi_run` 会一直等到 pi 答完（长任务会占住一个 turn）。传 `background: true` 则立刻返回运行中的句柄：

```jsonc
// 1) 起任务，几百毫秒返回
{ "task": "整理 Downloads 顶层目录", "cwd": "C:\\Users\\Administrator\\Downloads", "background": true }

// 2) 轮询进度（不阻塞）
{ "action": "output", "session": "pi1" }

// 3) 阻塞等它结束（最多 5 分钟），拿完整结果
{ "action": "wait", "session": "pi1", "waitMs": 300000 }
```

`pi_session output/wait` 返回 `status`（running/done/failed/idle）、`elapsedMs`、`answer`（截至目前）、`toolCalls`、`usage`、`error`。

配合 DSH 的 `subagent` 用更省事：把"调 pi_run 并 wait"整段丢给子 agent，主会话的上下文只收最终摘要。

## 注册约束（0.2.0 修复）

DSH 在 `tools.register()` 里用 `assertSupportedJsonSchema` 校验 `output.schema`，只认 `type/oneOf/properties/required/additionalProperties/items/enum/const`：

- `type: ['string', 'null']` 这类联合写法会被拒绝，抛错后同一插件里**所有**工具都注册不上（表现是插件 `active` 但工具面完全没有 `pi_*`）；
- 可空字段必须写成 `oneOf: [{ type: 'string' }, { type: 'null' }]`；
- 注册走 `ctx.tools` 直连（服务已注入时），并把每个工具单独 `try/catch`，一个坏定义不再拖垮其余。

改完用 `node tests/verify_register.mjs` 离线自检：它会 mount 插件、按 DSH 的规则校验三个定义、用样例值跑输出校验和 render。需要指定宿主 tools 包路径时设 `DSH_TOOLS_ENTRY`。

### 0.2.1 追加：`ctx.tools` 不能探测

cordis 的 ctx 是严格代理——读取没写进 `inject` 的服务会**直接抛错**，不是返回 `undefined`：

```
Error: cannot get property "tools" without inject
  at setup (.../bundle/index.js)
  at Fiber.execute (.../cordis/lib/index.js)
```

所以 `if (ctx.tools !== undefined) { … } else { ctx.inject(['tools'], …) }` 这种"兜底"写法会让 `apply` 每次启动就抛异常，症状和 schema 失败一模一样：插件 `active`、工具一个都没有。正确做法是**只走** `ctx.inject(['tools'], mountTools)`。

排障日志（诊断期保留，每次 apply 约 5 行）：

- `%USERPROFILE%\pi-acp-import.log` — 模块到底有没有被 import
- `%USERPROFILE%\pi-acp-selftest.log` — apply 入口 / 挂载路径 / 每个 `register` 的 ok 或异常堆栈

DSH 会吞掉插件的 `console.error`，没有这两个文件时故障是"静默"的。改完 JS 后不需要重启：改一下 profile 的 `cordis.patch.yml`（哪怕加一行注释）就会触发 HMR 重新 import 并重跑 apply。

## 设置页（0.3.0）

插件在 **设置 → 插件** 里贡献一个「pi（ACP）」标签页。页面用的是 DSH 自己的 `SettingsForm` / `SettingsValueField` 组件，外观与「终端」「网页搜索」等官方配置页一致，没有自定义样式。

- **安装检测**（页首一行）：`pi-acp` 的版本与入口是否存在、`pi` 的版本，右侧「重新检测」。数据来自宿主只读路由 `GET /pi-acp/diagnose`，客户端同源 fetch。
- **字段**：思考强度（off / low / medium / high / max，留空跟随 pi）、默认模型、单轮超时（毫秒）、工具权限（allow / deny）、并发轮数。保存写回 profile 的 patch。

实现要点，改之前先看：

1. host 侧 `export const Config = Schema.object({ … .volatile() })`；只有 volatile 字段会出现在设置文档里。
2. `.volatile()` 字段在 `apply` 收到的是 `{ get() }` 引用而不是标量，`unrefConfig()` 负责解包——直接当字符串用会把对象塞进设置里。
3. 客户端拿不到 host 的运行时信息（settings 只能读写 config），所以「检测」走一条只读 HTTP 路由，而不是配置字段。
4. `lib/client.js` 必须是 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => … })`；包 manifest 声明 `dsh.client`（`platform: web`，`exports["./client"]`）。DSH 只扫描 **loader 里已实例化的行** 的 `dsh.client` 声明，所以 profile patch 里必须有 `pi-acp` 那一行。
5. 新 client 模块要被扫描进 boot graph，改完需要重启一次 DSH。



