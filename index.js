/**
 * Host half of the `dsh-pi-acp` bundle.
 *
 * The pi coding agent does not speak ACP itself; `pi-acp` is a small adapter
 * that does, spawning `pi --mode rpc` behind a JSON-RPC 2.0 stdio server. This
 * plugin is the ACP *client* half of that pair, so a DSH agent can hand a task
 * to pi and read back what pi did:
 *
 *   1. resolve the `pi-acp` entry point (explicit config / PATH / npm prefix),
 *   2. spawn it with `node` and speak newline-delimited JSON-RPC 2.0,
 *      `initialize` → `session/new` (or `session/load`) → `session/prompt`,
 *   3. fold the streamed `session/update` notifications (assistant text, tool
 *      calls, context usage) into one tool result,
 *   4. keep the process alive so a follow-up call continues the same pi
 *      session, and sweep idle sessions on a timer.
 *
 * Tools registered here:
 *   - `pi_run`     run one task through pi (new session, live handle, or a
 *                  resumed pi session id) and return its answer plus trace;
 *                  `background: true` returns a running handle at once,
 *   - `pi_session` list, close, poll (`output`) or block on (`wait`) those
 *                  sessions and their latest turn,
 *   - `pi_status`  diagnose the launch path, adapter version and model list.
 *
 * Registration notes: DSH validates every tool's `output.schema` with
 * `assertSupportedJsonSchema`, which only supports type/oneOf/properties/
 * required/additionalProperties/items/enum/const — union types written as
 * `type: ['string', 'null']` are rejected and take the whole registration
 * down with them, so nullable fields are spelled as `oneOf`. Registration
 * goes through `ctx.tools` directly when the service is already injected.
 *
 * No third-party import is used on purpose: the bundle is installed from a
 * workspace checkout, so it must load with nothing but Node built-ins.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

// Diagnostics: prove the module was imported at all, before any apply runs.
// The host swallows plugin console output, so this is the only outside signal.
/** Append one diagnostic line to a file under the user profile. */
const traceTo = (file, message) => {
  try {
    const base = process.env.USERPROFILE ?? 'C:\\Users\\Administrator'
    appendFileSync(join(base, file), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* diagnostics must never break the plugin */
  }
}
traceTo('pi-acp-import.log', 'module imported')

/**
 * Settings fields declared `.volatile()` arrive as `{ get() }` refs; plain
 * values pass through untouched so the same code works with or without them.
 * @param {unknown} config - raw loader config.
 * @returns {Record<string, unknown>} plain field values.
 */
const unrefConfig = (config) => {
  const source = config !== null && typeof config === 'object' ? config : {}
  const resolved = {}
  for (const [key, value] of Object.entries(source)) {
    resolved[key] =
      value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return resolved
}

export const name = '@local/dsh-pi-acp'
/** ACP protocol revision this adapter negotiates (pi-acp supports 1). */
const PROTOCOL_VERSION = 1
/** Anything larger than this never reaches the model verbatim. */
const MAX_ANSWER_CHARS = 60_000
/** Bounded tail of a child's stderr quoted in failure text. */
const STDERR_TAIL = 4_000
const IS_WINDOWS = process.platform === 'win32'

const DEFAULTS = {
  /** Absolute path of `pi-acp/dist/index.js`; empty = auto-resolve. */
  entryFile: '',
  /** Custom launch command, used verbatim instead of the resolved entry. */
  command: '',
  /** Working directory for new pi sessions; empty = the host process directory. */
  defaultCwd: '',
  /** Model id such as `magpie/auto/deepseek-v4.1-flash`; empty = pi default. */
  model: '',
  /** Thinking level (`off`/`low`/`medium`/`high`…); empty = pi default. */
  thinking: '',
  /** Per-turn wall clock budget. */
  timeoutMs: 600_000,
  /** Minutes an unused pi process is kept before it is closed. */
  idleTimeoutMin: 15,
  /** Concurrent pi turns across all sessions. */
  maxConcurrent: 4,
  /** Answer characters kept in the tool result. */
  maxAnswerChars: MAX_ANSWER_CHARS,
  /** `allow` answers ACP permission prompts with the first allow option. */
  permission: 'allow',
  /** Extra environment variables for the adapter process. */
  env: {},
}

/** Settings schema: every field is volatile so the Settings page can edit it. */
export const Config = Schema.object({
  thinking: Schema.union(['', 'off', 'low', 'medium', 'high', 'max'])
    .default('')
    .description('默认思考强度；留空跟随 pi 自己的默认。')
    .volatile(),
  model: Schema.string().default('').description('默认模型 id；留空跟随 pi 自己的默认。').volatile(),
  timeoutMs: Schema.number()
    .min(5_000)
    .max(3_600_000)
    .step(1_000)
    .default(600_000)
    .description('单轮墙钟上限（毫秒）。')
    .volatile(),
  permission: Schema.union(['allow', 'deny']).default('allow').description('pi 请求工具权限时如何回答。').volatile(),
  maxConcurrent: Schema.number().min(1).max(8).step(1).default(4).description('同时运行的 pi 任务上限。').volatile(),
  defaultCwd: Schema.string().default('').description('默认工作目录（绝对路径）；留空用宿主进程目录。').volatile(),
  idleTimeoutMin: Schema.number().min(1).max(1_440).step(1).default(15).description('空闲多少分钟后关闭 pi 进程。').volatile(),
})

/** One failure the model can act on: stable `code`, prose `message`. */
class PiAcpError extends Error {
  /**
   * @param {string} message - actionable text.
   * @param {string} [code] - stable machine code.
   * @param {Record<string, unknown>} [detail] - structured extras.
   */
  constructor(message, code = 'pi_acp_error', detail) {
    super(message)
    this.name = 'PiAcpError'
    this.code = code
    this.detail = detail
  }
}

/* ------------------------------------------------------------------ launch */

/** @returns {string[]} PATH entries without empties. */
function pathDirectories() {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw.split(delimiter).filter((entry) => entry !== '')
}

/**
 * Locate a Node.js binary. A desktop host runs the plugin inside Electron,
 * where `process.execPath` is the app itself, so the npm prefix that owns the
 * `pi-acp` shim is probed first.
 * @param {string} [preferredDirectory] - directory checked before PATH.
 * @returns {string} command usable as `spawn`'s file argument.
 */
function resolveNodeExecutable(preferredDirectory) {
  const override = process.env.PI_ACP_NODE
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override
  const names = IS_WINDOWS ? ['node.exe'] : ['node']
  const directories = preferredDirectory === undefined ? pathDirectories() : [preferredDirectory, ...pathDirectories()]
  for (const directory of directories) {
    for (const candidate of names) {
      const executable = join(directory, candidate)
      if (existsSync(executable)) return executable
    }
  }
  return IS_WINDOWS ? 'node.exe' : 'node'
}

/**
 * Package entry a global npm prefix owns.
 * @param {string} directory - bin directory, or the npm prefix itself.
 * @returns {string | undefined} absolute `dist/index.js`, when present.
 */
function entryForPrefix(directory) {
  const candidates = [
    join(directory, 'node_modules', 'pi-acp', 'dist', 'index.js'),
    join(directory, '..', 'lib', 'node_modules', 'pi-acp', 'dist', 'index.js'),
    join(directory, '..', 'node_modules', 'pi-acp', 'dist', 'index.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolvePath(candidate)
  }
  return undefined
}

/**
 * Resolve how to start the adapter.
 * @param {typeof DEFAULTS} settings - merged plugin settings.
 * @returns {{file: string, args: string[], shell: boolean, entry: string, node: string | undefined, source: string}}
 */
function resolveLaunchSpec(settings) {
  const probed = []
  const custom = typeof settings.command === 'string' ? settings.command.trim() : ''
  if (custom !== '') {
    if (/\.(?:m?js|cjs)$/i.test(custom) && existsSync(custom)) {
      const entry = resolvePath(custom)
      const node = resolveNodeExecutable(dirname(entry))
      return { file: node, args: [entry], shell: false, entry, node, source: 'command' }
    }
    return {
      file: custom,
      args: [],
      shell: IS_WINDOWS && /\.(?:cmd|bat)$/i.test(custom),
      entry: custom,
      node: undefined,
      source: 'command',
    }
  }

  const explicit = []
  if (typeof settings.entryFile === 'string' && settings.entryFile.trim() !== '') explicit.push(settings.entryFile.trim())
  for (const key of ['DSH_PI_ACP_ENTRY', 'PI_ACP_ENTRY']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') explicit.push(value)
  }
  for (const candidate of explicit) {
    probed.push(candidate)
    if (!existsSync(candidate)) continue
    const entry = resolvePath(candidate)
    const node = resolveNodeExecutable(dirname(entry))
    return { file: node, args: [entry], shell: false, entry, node, source: 'config' }
  }

  for (const directory of pathDirectories()) {
    const entry = entryForPrefix(directory)
    if (entry !== undefined) {
      const node = resolveNodeExecutable(directory)
      return { file: node, args: [entry], shell: false, entry, node, source: 'PATH' }
    }
    probed.push(join(directory, 'node_modules', 'pi-acp', 'dist', 'index.js'))
  }

  for (const directory of pathDirectories()) {
    const shim = join(directory, IS_WINDOWS ? 'pi-acp.cmd' : 'pi-acp')
    if (existsSync(shim)) return { file: shim, args: [], shell: true, entry: shim, node: undefined, source: 'PATH shim' }
    probed.push(shim)
  }

  throw new PiAcpError(
    [
      '没有找到 pi-acp 适配器入口。',
      '先安装：npm install -g pi-acp（它同时要求 pi 在 PATH 上）。',
      `已探测：${probed.slice(0, 12).join(' | ')}`,
      '或者在本插件配置里显式写 entryFile（指向 pi-acp/dist/index.js）或 command。',
    ].join(' '),
    'pi_acp_missing',
    { probed },
  )
}

/**
 * Read one package.json without throwing.
 * @param {string} file - candidate manifest path.
 * @returns {Record<string, unknown> | undefined} parsed manifest.
 */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Adapter + pi versions, best effort: the adapter's own manifest, then pi's.
 * @param {string} entry - resolved `pi-acp/dist/index.js`.
 * @returns {{piAcp?: string, pi?: string}} discovered versions.
 */
function readVersions(entry) {
  const versions = {}
  const modules = resolvePath(join(dirname(entry), '..', '..'))
  const adapter = readManifest(join(modules, 'pi-acp', 'package.json'))
  if (adapter && typeof adapter.version === 'string') versions.piAcp = adapter.version
  const pi = readManifest(join(modules, '@earendil-works', 'pi-coding-agent', 'package.json'))
  if (pi && typeof pi.version === 'string') versions.pi = pi.version
  return versions
}

/* --------------------------------------------------------------- transport */

/**
 * ACP client over one adapter process: newline-delimited JSON-RPC 2.0, with
 * the agent→client direction (permission prompts, unsupported delegations)
 * answered by the callbacks the owner installs.
 */
class AcpTransport {
  /**
   * @param {{file: string, args: string[], shell: boolean}} spec - launch plan.
   * @param {{cwd: string, env: Record<string, string>, onNotification: (method: string, params: unknown) => void, onRequest: (method: string, params: unknown) => Promise<unknown>}} options - wiring.
   */
  constructor(spec, options) {
    this.spec = spec
    this.cwd = options.cwd
    this.env = options.env
    this.onNotification = options.onNotification
    this.onRequest = options.onRequest
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.stderrTail = ''
    this.exited = false
    this.child = undefined
  }

  /** Start the child and begin reading frames. */
  start() {
    const child = spawn(this.spec.file, this.spec.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.spec.shell === true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.receive(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL)
    })
    child.on('error', (error) => {
      this.exited = true
      this.failPending(
        new PiAcpError(`无法启动 pi-acp：${error instanceof Error ? error.message : String(error)}`, 'pi_acp_spawn_failed'),
      )
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      this.failPending(
        new PiAcpError(
          `pi-acp 进程已退出（code=${String(code)} signal=${String(signal)}）${this.stderrTail === '' ? '' : `：${this.stderrTail.trim().slice(-800)}`}`,
          'pi_acp_exited',
        ),
      )
    })
  }

  /** @param {string} chunk - stdout text. */
  receive(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      void this.dispatch(message)
    }
  }

  /** @param {Record<string, any>} message - one decoded frame. */
  async dispatch(message) {
    if (typeof message.method === 'string' && message.id !== undefined) {
      try {
        const result = await this.onRequest(message.method, message.params)
        this.write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result })
      } catch (error) {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }
    if (typeof message.method === 'string') {
      this.onNotification(message.method, message.params)
      return
    }
    if (message.id === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort)
    if (message.error !== undefined && message.error !== null) {
      entry.reject(
        new PiAcpError(
          `${entry.method} 失败：${String(message.error.message ?? 'unknown')}（code=${String(message.error.code ?? '?')}）`,
          'pi_acp_rpc_error',
          { method: entry.method, rpc: message.error },
        ),
      )
      return
    }
    entry.resolve(message.result)
  }

  /** @param {Record<string, unknown>} payload - frame to write. */
  write(payload) {
    if (this.exited || this.child === undefined) return
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch {
      /* a closed stdin surfaces through the exit handler */
    }
  }

  /**
   * Send one request and await its result.
   * @param {string} method - ACP method name.
   * @param {unknown} params - method parameters.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - cancellation.
   * @returns {Promise<any>} the `result` member.
   */
  request(method, params, options = {}) {
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PiAcpError(`${method} 超时（${timeoutMs}ms 无响应）`, 'pi_acp_timeout', { method, timeoutMs }))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new PiAcpError(`${method} 已被取消`, 'pi_acp_aborted', { method }))
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          clearTimeout(timer)
          reject(new PiAcpError(`${method} 已被取消`, 'pi_acp_aborted', { method }))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, { resolve, reject, timer, method, signal: options.signal, onAbort })
      this.write({ jsonrpc: '2.0', id, method, params: params === undefined ? {} : params })
    })
  }

  /**
   * Fire one notification (no reply expected).
   * @param {string} method - ACP method name.
   * @param {unknown} params - method parameters.
   */
  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** @param {Error} error - reason every in-flight call fails. */
  failPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Terminate the adapter process and everything it spawned. */
  dispose() {
    const child = this.child
    if (child === undefined) return
    this.exited = true
    this.failPending(new PiAcpError('pi-acp 会话已关闭', 'pi_acp_closed'))
    try {
      child.stdin.end()
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, 400)
    timer.unref?.()
  }
}

/* ------------------------------------------------------------------- turn */

/**
 * Folds the notification stream of one prompt turn into a result: assistant
 * text (minus the adapter's startup block), tool-call lifecycle, usage.
 */
class TurnCollector {
  /** @param {string | null} startupInfo - prelude text `session/new` announced. */
  constructor(startupInfo) {
    this.text = ''
    this.pendingStartup = typeof startupInfo === 'string' && startupInfo !== '' ? startupInfo : null
    this.tools = new Map()
    this.log = []
    this.usage = null
    this.updates = 0
  }

  /** @param {Record<string, any>} update - one `session/update` payload. */
  observe(update) {
    this.updates += 1
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    if (kind === 'agent_message_chunk') {
      const content = update.content
      if (content === null || typeof content !== 'object' || content.type !== 'text') return
      const chunk = typeof content.text === 'string' ? content.text : ''
      if (chunk === '') return
      if (this.pendingStartup !== null) {
        if (chunk === this.pendingStartup) {
          this.pendingStartup = null
          return
        }
        if (this.pendingStartup.startsWith(chunk)) {
          this.pendingStartup = this.pendingStartup.slice(chunk.length)
          return
        }
        this.pendingStartup = null
      }
      this.text += chunk
      return
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : 'unknown'
      const previous = this.tools.get(id)
      const title = typeof update.title === 'string' ? update.title : previous?.title ?? id
      const entry = {
        title,
        kind: typeof update.kind === 'string' ? update.kind : previous?.kind ?? 'other',
        status: typeof update.status === 'string' ? update.status : previous?.status ?? 'pending',
      }
      this.tools.set(id, entry)
      if (kind === 'tool_call') this.push(`→ ${title}${update.kind === undefined ? '' : ` (${String(update.kind)})`}`)
      else if (entry.status === 'completed') this.push(`✓ ${title}`)
      else if (entry.status === 'failed') this.push(`✗ ${title}`)
      return
    }
    if (kind === 'usage_update') {
      this.usage = { used: Number(update.used ?? 0), size: Number(update.size ?? 0) }
    }
  }

  /** @param {string} line - trace entry, kept bounded. */
  push(line) {
    if (this.log.length >= 80) return
    this.log.push(line)
  }

  /**
   * @param {number} limit - maximum answer characters retained.
   * @returns {{answer: string, truncated: boolean}} the assistant text.
   */
  answer(limit) {
    const text = this.text.trim()
    if (text.length <= limit) return { answer: text, truncated: false }
    return { answer: text.slice(0, limit), truncated: true }
  }
}

/**
 * Timeout + cancellation for one turn. Interrupting sends `session/cancel` to
 * the adapter and aborts the in-flight ACP request, so the caller sees the
 * partial transcript instead of a hang.
 */
class TurnWatch {
  /** @param {() => void} cancel - sends `session/cancel` to the adapter. */
  constructor(cancel) {
    this.cancel = cancel
    this.controller = new AbortController()
    this.reason = undefined
    this.code = 'pi_acp_timeout'
    this.timer = undefined
  }

  /** @returns {AbortSignal} signal handed to the ACP request. */
  get signal() {
    return this.controller.signal
  }

  /** @param {number} timeoutMs - wall clock budget. */
  arm(timeoutMs) {
    this.timer = setTimeout(() => {
      this.interrupt(`超过 ${Math.round(timeoutMs / 1000)}s 时限`, 'pi_acp_timeout')
    }, timeoutMs)
    this.timer.unref?.()
  }

  /** @param {AbortSignal | undefined} signal - the caller's signal. */
  linkAbort(signal) {
    if (signal === undefined) return
    if (signal.aborted) {
      this.interrupt('调用方取消', 'pi_acp_aborted')
      return
    }
    signal.addEventListener('abort', () => this.interrupt('调用方取消', 'pi_acp_aborted'), { once: true })
  }

  /**
   * @param {string} reason - prose shown to the caller.
   * @param {string} code - stable machine code.
   */
  interrupt(reason, code) {
    if (this.reason !== undefined) return
    this.reason = reason
    this.code = code
    try {
      this.cancel()
    } catch {
      /* the process may already be gone */
    }
    this.controller.abort()
  }

  /** Stop the timer once the turn settles. */
  stop() {
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}

/* ---------------------------------------------------------------- manager */

/**
 * Owns every live pi session this plugin started and serializes turns into
 * them. One process per session, one prompt in flight per process.
 */
class PiAcpManager {
  /** @param {typeof DEFAULTS} settings - merged plugin settings. */
  constructor(settings) {
    this.settings = settings
    this.sessions = new Map()
    this.runs = new Map()
    this.counter = 0
    this.running = 0
    this.disposed = false
  }

  /** @returns {{file: string, args: string[], shell: boolean, entry: string, node: string | undefined, source: string}} */
  launchSpec() {
    return resolveLaunchSpec(this.settings)
  }

  /** @returns {Record<string, string>} adapter environment. */
  childEnvironment() {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = env.PI_ACP_ENABLE_EMBEDDED_CONTEXT ?? 'true'
    for (const [key, value] of Object.entries(this.settings.env ?? {})) {
      if (typeof value === 'string') env[key] = value
    }
    return env
  }

  /**
   * Answer one agent→client request. pi executes its tools locally, so the
   * only documented request is an extension-UI permission prompt.
   * @param {string} method - request method.
   * @param {unknown} params - request parameters.
   * @returns {Promise<unknown>} reply result.
   */
  async handleRequest(method, params) {
    if (method === 'session/request_permission') {
      const options = Array.isArray(params?.options) ? params.options : []
      if (this.settings.permission === 'deny') return { outcome: { outcome: 'cancelled' } }
      const allow = options.find((option) => option?.kind === 'allow_once' || option?.kind === 'allow_always') ?? options[0]
      if (allow === undefined || typeof allow.optionId !== 'string') return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    throw new PiAcpError(`pi-acp 请求了本客户端未声明的能力：${method}`, 'pi_acp_unsupported_request', { method })
  }

  /**
   * Spawn one adapter process and initialize it.
   * @param {string} cwd - session working directory.
   * @returns {Promise<{transport: AcpTransport, init: any, sink: {current: ((update: Record<string, any>) => void) | undefined}}>} handshake plus the notification sink a turn installs itself into.
   */
  async connect(cwd) {
    const spec = this.launchSpec()
    // One indirection so each turn attaches its own collector to a long-lived
    // process: the sink is swapped per prompt, the listener is installed once.
    const sink = { current: undefined }
    const transport = new AcpTransport(
      { file: spec.file, args: spec.args, shell: spec.shell },
      {
        cwd,
        env: this.childEnvironment(),
        onNotification: (method, params) => {
          if (method !== 'session/update') return
          const update = params?.update
          if (update !== null && typeof update === 'object') sink.current?.(update)
        },
        onRequest: (method, params) => this.handleRequest(method, params),
      },
    )
    transport.start()
    try {
      const init = await transport.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        { timeoutMs: 60_000 },
      )
      return { transport, init, sink }
    } catch (error) {
      transport.dispose()
      throw this.explain(error)
    }
  }

  /**
   * Create one session record (new ACP session, or a resumed pi session id).
   * @param {{cwd: string, resumeId?: string, model?: string, thinking?: string}} request - what to open.
   * @returns {Promise<Record<string, any>>} the session record.
   */
  async open(request) {
    const cwd = request.cwd
    const { transport, init, sink } = await this.connect(cwd)
    try {
      const resumed = typeof request.resumeId === 'string' && request.resumeId !== ''
      const response = resumed
        ? await transport.request('session/load', { sessionId: request.resumeId, cwd, mcpServers: [] }, { timeoutMs: 180_000 })
        : await transport.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 180_000 })
      const record = {
        handle: this.nextHandle(),
        transport,
        sink,
        init,
        piSessionId: resumed ? request.resumeId : String(response?.sessionId ?? ''),
        cwd,
        startupInfo: typeof response?._meta?.piAcp?.startupInfo === 'string' ? response._meta.piAcp.startupInfo : null,
        model: typeof request.model === 'string' && request.model.trim() !== '' ? request.model.trim() : this.settings.model,
        thinking:
          typeof request.thinking === 'string' && request.thinking.trim() !== '' ? request.thinking.trim() : this.settings.thinking,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        turns: 0,
        busy: false,
        usage: null,
      }
      this.sessions.set(record.handle, record)
      if (record.model !== '') await this.applyModel(record, record.model)
      if (record.thinking !== '') await this.applyThinking(record, record.thinking)
      return record
    } catch (error) {
      transport.dispose()
      throw this.explain(error)
    }
  }

  /** @returns {string} a short, stable, human-usable session handle. */
  nextHandle() {
    this.counter += 1
    let handle = `pi${this.counter}`
    while (this.sessions.has(handle)) {
      this.counter += 1
      handle = `pi${this.counter}`
    }
    return handle
  }

  /**
   * @param {Record<string, any>} record - live session.
   * @param {string} model - model id pi advertises.
   */
  async applyModel(record, model) {
    await record.transport.request(
      'session/set_config_option',
      { sessionId: record.piSessionId, configId: 'model', value: model },
      { timeoutMs: 60_000 },
    )
    record.model = model
  }

  /**
   * @param {Record<string, any>} record - live session.
   * @param {string} mode - thinking level id pi advertises.
   */
  async applyThinking(record, mode) {
    await record.transport.request(
      'session/set_mode',
      { sessionId: record.piSessionId, modeId: mode },
      { timeoutMs: 60_000 },
    )
    record.thinking = mode
  }

  /**
   * Translate a raw adapter failure into text the model can act on.
   * @param {unknown} error - anything thrown by a call.
   * @returns {Error} the error to surface.
   */
  explain(error) {
    if (!(error instanceof PiAcpError)) {
      return new PiAcpError(error instanceof Error ? error.message : String(error), 'pi_acp_error')
    }
    const rpc = error.detail?.rpc
    if (rpc !== null && typeof rpc === 'object' && rpc.data !== null && typeof rpc.data === 'object' && 'authMethods' in rpc.data) {
      return new PiAcpError(
        'pi 还没有可用的模型凭据：先在终端执行一次 pi 完成登录／配置 API key，然后重试。',
        'pi_auth_required',
        error.detail,
      )
    }
    if (error.code === 'pi_acp_rpc_error' && /auth|login|api[ _-]?key/i.test(error.message)) {
      return new PiAcpError(`pi 未完成认证：${error.message}`, 'pi_auth_required', error.detail)
    }
    return error
  }

  /**
   * Start one turn and return its live state. `state.done` settles the result;
   * the foreground path awaits it, the background path returns at once and lets
   * `pi_session` poll or wait for it.
   * @param {{task: string, cwd?: string, handle?: string, resumeId?: string, model?: string, thinking?: string, timeoutMs?: number, signal?: AbortSignal}} request - the turn.
   * @returns {Promise<Record<string, any>>} the turn state.
   */
  async begin(request) {
    if (this.disposed) throw new PiAcpError('插件已卸载', 'pi_acp_disposed')
    if (this.running >= this.settings.maxConcurrent) {
      throw new PiAcpError(
        `已有 ${this.running} 个 pi 任务在跑（上限 ${this.settings.maxConcurrent}），稍后重试或调大 maxConcurrent。`,
        'pi_acp_busy',
      )
    }
    const cwd = this.resolveCwd(request.cwd)
    const timeoutMs = this.resolveTimeout(request.timeoutMs)
    const record = await this.acquire(request, cwd)
    const collector = new TurnCollector(record.startupInfo)
    record.startupInfo = null
    record.sink.current = (update) => collector.observe(update)
    const watcher = new TurnWatch(() => {
      record.transport.notify('session/cancel', { sessionId: record.piSessionId })
    })
    watcher.linkAbort(request.signal)
    watcher.arm(timeoutMs)
    record.busy = true
    this.running += 1
    const state = {
      handle: record.handle,
      record,
      collector,
      watcher,
      task: request.task,
      startedAt: Date.now(),
      status: 'running',
      error: null,
      result: null,
      finishedAt: null,
      done: undefined,
    }
    this.runs.set(record.handle, state)
    state.done = this.settle(state, timeoutMs)
    // A background turn settles with nobody listening until pi_session reads it.
    state.done.catch(() => {})
    return state
  }

  /**
   * Drive one acquired turn to completion and record the outcome on its state.
   * @param {Record<string, any>} state - live turn state.
   * @param {number} timeoutMs - wall clock budget already armed on the watcher.
   * @returns {Promise<Record<string, any>>} tool-result payload.
   */
  async settle(state, timeoutMs) {
    const { record, collector, watcher } = state
    const startedAt = state.startedAt
    try {
      const response = await record.transport.request(
        'session/prompt',
        { sessionId: record.piSessionId, prompt: [{ type: 'text', text: composePrompt(state.task) }] },
        { timeoutMs, signal: watcher.signal },
      )
      record.turns += 1
      record.lastUsedAt = Date.now()
      record.usage = collector.usage
      state.result = this.result(record, collector, {
        stopReason: String(response?.stopReason ?? 'end_turn'),
        elapsedMs: Date.now() - startedAt,
      })
      state.status = 'done'
      return state.result
    } catch (error) {
      record.lastUsedAt = Date.now()
      const partial = collector.answer(this.settings.maxAnswerChars)
      let failure
      if (watcher.reason === undefined) {
        failure = this.explain(error)
      } else {
        const tail =
          partial.answer === '' ? '没有收到任何输出。' : '已收到的部分输出：\n' + partial.answer
        failure = this.explain(
          new PiAcpError(`${watcher.reason}，pi 已中止本轮。${tail}`, watcher.code, {
            session: record.handle,
            piSessionId: record.piSessionId,
          }),
        )
      }
      if (watcher.reason === undefined && record.transport.exited) this.forget(record.handle)
      state.status = 'failed'
      state.error = failure instanceof Error ? failure.message : String(failure)
      throw failure
    } finally {
      watcher.stop()
      record.sink.current = undefined
      record.busy = false
      this.running -= 1
      state.finishedAt = Date.now()
    }
  }

  /**
   * Run one task through pi and wait for it.
   * @param {{task: string, cwd?: string, handle?: string, resumeId?: string, model?: string, thinking?: string, timeoutMs?: number, signal?: AbortSignal}} request - the turn.
   * @returns {Promise<Record<string, any>>} tool-result payload.
   */
  async run(request) {
    const state = await this.begin(request)
    return state.done
  }

  /**
   * Give the caller a live session, opening one when needed. A reused session
   * is marked busy here and released by `run`'s finally block, so two parallel
   * calls cannot interleave prompts into one pi process.
   * @param {{handle?: string, resumeId?: string, model?: string, thinking?: string}} request - selection.
   * @param {string} cwd - working directory.
   * @returns {Promise<Record<string, any>>} the session record.
   */
  async acquire(request, cwd) {
    const handle = typeof request.handle === 'string' ? request.handle.trim() : ''
    if (handle === '') {
      return this.open({
        cwd,
        resumeId: typeof request.resumeId === 'string' ? request.resumeId : undefined,
        model: request.model,
        thinking: request.thinking,
      })
    }
    const record = this.sessions.get(handle)
    if (record === undefined) {
      throw new PiAcpError(
        `没有会话 ${handle}（可能已因空闲关闭）。省略 session 参数开新会话，或用 pi_session 列出。`,
        'pi_acp_unknown_session',
      )
    }
    if (record.transport.exited) {
      this.forget(handle)
      throw new PiAcpError(`会话 ${handle} 的 pi 进程已退出，请开新会话。`, 'pi_acp_session_dead')
    }
    if (record.busy) throw new PiAcpError(`会话 ${handle} 正在执行上一轮，等它结束或先取消。`, 'pi_acp_session_busy')
    if (cwd !== record.cwd) {
      throw new PiAcpError(`会话 ${handle} 的工作目录是 ${record.cwd}，不能在同一会话里切到 ${cwd}。`, 'pi_acp_cwd_mismatch')
    }
    record.busy = true
    try {
      await this.reconfigure(record, request)
      return record
    } catch (error) {
      record.busy = false
      throw this.explain(error)
    }
  }

  /**
   * Apply a per-call model / thinking override to a reused session.
   * @param {Record<string, any>} record - live session.
   * @param {{model?: string, thinking?: string}} request - overrides.
   */
  async reconfigure(record, request) {
    const model = typeof request.model === 'string' ? request.model.trim() : ''
    if (model !== '' && model !== record.model) await this.applyModel(record, model)
    const thinking = typeof request.thinking === 'string' ? request.thinking.trim() : ''
    if (thinking !== '' && thinking !== record.thinking) await this.applyThinking(record, thinking)
  }

  /**
   * @param {Record<string, any>} record - live session.
   * @param {TurnCollector} collector - finished turn.
   * @param {{stopReason: string, elapsedMs: number}} extra - turn facts.
   * @returns {Record<string, any>} tool-result payload.
   */
  result(record, collector, extra) {
    const answer = collector.answer(this.settings.maxAnswerChars)
    return {
      session: record.handle,
      piSessionId: record.piSessionId,
      cwd: record.cwd,
      model: record.model === '' ? null : record.model,
      thinking: record.thinking === '' ? null : record.thinking,
      stopReason: extra.stopReason,
      answer: answer.answer,
      answerTruncated: answer.truncated,
      elapsedMs: extra.elapsedMs,
      updates: collector.updates,
      toolCalls: [...collector.tools.values()],
      usage: collector.usage,
      log: collector.log,
    }
  }

  /**
   * @param {string | undefined} requested - caller's directory.
   * @returns {string} an absolute working directory.
   */
  resolveCwd(requested) {
    const candidate = typeof requested === 'string' ? requested.trim() : ''
    if (candidate !== '') {
      if (!isAbsolute(candidate)) throw new PiAcpError(`cwd 必须是绝对路径：${candidate}`, 'pi_acp_bad_cwd')
      return resolvePath(candidate)
    }
    if (this.settings.defaultCwd !== '') return resolvePath(this.settings.defaultCwd)
    return process.cwd()
  }

  /**
   * @param {number | undefined} requested - caller's budget.
   * @returns {number} clamped per-turn budget.
   */
  resolveTimeout(requested) {
    const value = Number(requested ?? this.settings.timeoutMs)
    if (!Number.isFinite(value) || value <= 0) return this.settings.timeoutMs
    return Math.min(Math.max(value, 5_000), 3_600_000)
  }

  /** @param {string} handle - session to drop. */
  forget(handle) {
    const record = this.sessions.get(handle)
    if (record === undefined) return
    this.sessions.delete(handle)
    record.transport.dispose()
  }

  /** Close every session idle for longer than the configured window. */
  sweep() {
    if (this.disposed) return
    const idleMs = Math.max(this.settings.idleTimeoutMin, 1) * 60_000
    const now = Date.now()
    for (const [handle, record] of this.sessions) {
      if (record.busy) continue
      if (now - record.lastUsedAt < idleMs) continue
      this.forget(handle)
    }
  }

  /**
   * Read one turn's live state without waiting for it.
   * @param {string} handle - session handle.
   * @returns {Record<string, any>} the latest turn state.
   */
  snapshot(handle) {
    const state = this.runs.get(handle)
    if (state === undefined) {
      const record = this.sessions.get(handle)
      if (record === undefined) throw new PiAcpError(`没有会话 ${handle}。`, 'pi_acp_unknown_session')
      return {
        session: handle,
        status: record.busy ? 'running' : 'idle',
        answer: '',
        answerTruncated: false,
        elapsedMs: 0,
        error: null,
        stopReason: null,
        toolCalls: [],
        usage: null,
        log: [],
      }
    }
    const answer = state.collector.answer(this.settings.maxAnswerChars)
    return {
      session: state.handle,
      status: state.status,
      answer: answer.answer,
      answerTruncated: answer.truncated,
      elapsedMs: Date.now() - state.startedAt,
      error: state.error,
      stopReason: state.result?.stopReason ?? null,
      toolCalls: [...state.collector.tools.values()],
      usage: state.collector.usage,
      log: state.collector.log,
    }
  }

  /**
   * Wait up to `waitMs` for one turn to settle, then read its state.
   * @param {string} handle - session handle.
   * @param {number} waitMs - how long to block.
   * @returns {Promise<Record<string, any>>} the state after waiting.
   */
  async waitFor(handle, waitMs) {
    const state = this.runs.get(handle)
    if (state === undefined) return this.snapshot(handle)
    if (state.status === 'running') {
      const budget = Math.min(Math.max(waitMs, 0), 300_000)
      await Promise.race([
        state.done.catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, budget)
          timer.unref?.()
        }),
      ])
    }
    return this.snapshot(handle)
  }

  /** @returns {Record<string, any>[]} a snapshot of live sessions. */
  list() {
    return [...this.sessions.values()].map((record) => ({
      session: record.handle,
      piSessionId: record.piSessionId,
      cwd: record.cwd,
      model: record.model === '' ? null : record.model,
      thinking: record.thinking === '' ? null : record.thinking,
      busy: record.busy,
      turns: record.turns,
      idleSeconds: Math.round((Date.now() - record.lastUsedAt) / 1000),
      alive: record.transport.exited !== true,
    }))
  }

  /** Close every session and stop accepting work. */
  disposeAll() {
    this.disposed = true
    for (const handle of [...this.sessions.keys()]) this.forget(handle)
  }
}

/**
 * Guard against pi's slash-command parser: a task that opens with `/` would be
 * read as `/compact`, `/model` … instead of prose.
 * @param {string} task - caller's task text.
 * @returns {string} prompt text safe to send.
 */
function composePrompt(task) {
  const text = String(task ?? '').trim()
  return /^\//.test(text) ? `\u200B${text}` : text
}

/* ------------------------------------------------------------------ tools */

/**
 * Mount the tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  traceTo('pi-acp-selftest.log', 'apply entered')
  try {
    setup(ctx, config)
    traceTo('pi-acp-selftest.log', 'apply finished')
  } catch (error) {
    const stack = String(error?.stack ?? error).split('\n').slice(0, 6).join(' | ')
    traceTo('pi-acp-selftest.log', `apply FAILED · ${error?.constructor?.name}: ${error?.message} · ${stack}`)
    throw error
  }
}

/** Plugin body, split out so `apply` can log a failure instead of losing it. */
function setup(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...unrefConfig(config) }
  const manager = new PiAcpManager(settings)

  // One line per registration event: the host swallows console output, so a
  // failed registration otherwise leaves no trace anywhere.
  const trace = (message) => traceTo('pi-acp-selftest.log', message)
  // Never touch `ctx.tools` here: cordis throws for an undeclared service.
  trace('apply · settings ready')

  ctx.effect(() => () => manager.disposeAll(), 'pi-acp: close sessions')
  ctx.effect(() => {
    const timer = setInterval(() => manager.sweep(), 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'pi-acp: idle sweep')

  /** @returns {object} the `pi_run` tool definition. */
  const runTool = {
    name: 'pi_run',
    description: [
      'Hand a task to the pi coding agent (the `pi` CLI) through its ACP adapter and return what it produced.',
      "pi runs autonomously in the given directory: it reads and edits files, runs commands, and answers in its own voice — use it when you want a second agent to do the work, or when the task fits pi's own models and skills rather than yours.",
      'A call starts a new session unless you pass `session` (a handle from an earlier call) or `resume` (a pi session id), which continue the same conversation and keep its context.',
      "The result carries pi's final answer, the tool calls it made, token usage and the session handle; following up with that handle avoids re-sending the earlier context.",
      'pi writes to disk itself: pass `cwd` explicitly and expect real filesystem changes.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The instruction for pi, as prose. State the goal, the constraints and how to verify success; pi decides the steps.',
        },
        cwd: {
          type: 'string',
          description: "Absolute working directory for the session. Defaults to the plugin's defaultCwd, else the host process directory.",
        },
        session: {
          type: 'string',
          description: 'A `pi_run` handle (e.g. `pi1`) to continue. Omit to start a new session.',
        },
        resume: {
          type: 'string',
          description: 'A pi session id to reopen with `session/load` when no live handle exists (pi keeps sessions under ~/.pi/agent/sessions).',
        },
        model: {
          type: 'string',
          description: "Model id pi advertises (see pi_status). Defaults to pi's own default, or the plugin's `model` setting.",
        },
        thinking: {
          type: 'string',
          description: "Thinking level pi advertises (`off`/`low`/`medium`/`high`). Defaults to pi's own default.",
        },
        timeoutMs: {
          type: 'integer',
          description: "Wall-clock budget for this turn. Clamped to 5s–1h; the plugin's timeoutMs is the default.",
        },
        background: {
          type: 'boolean',
          description:
            'Return at once with a running handle instead of blocking until pi finishes. Read it with pi_session action="output", or block with action="wait". Use it for long jobs (organizing directories, refactors, builds) so the turn does not stall. Defaults to false.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          piSessionId: { type: 'string' },
          cwd: { type: 'string' },
          model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          thinking: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stopReason: { type: 'string' },
          status: { type: 'string' },
          answer: { type: 'string' },
          answerTruncated: { type: 'boolean' },
          elapsedMs: { type: 'integer' },
          updates: { type: 'integer' },
          toolCalls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                kind: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['title', 'kind', 'status'],
            },
          },
          usage: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  used: { type: 'integer' },
                  size: { type: 'integer' },
                },
              },
              { type: 'null' },
            ],
          },
          log: { type: 'array', items: { type: 'string' } },
        },
        required: ['session', 'piSessionId', 'stopReason', 'answer', 'toolCalls'],
      },
      render: (_args, value) => {
        const stateLabel =
          value.status === undefined || value.status === 'done'
            ? value.stopReason
            : value.status === 'running'
              ? value.stopReason === 'background'
                ? 'background'
                : `${value.stopReason} (running)`
              : `${value.stopReason} (${value.status})`
        const header = [
          `pi · ${value.session}`,
          value.model === null ? '' : value.model,
          value.thinking === null ? '' : `thinking ${value.thinking}`,
          `${Math.round(Number(value.elapsedMs ?? 0) / 1000)}s`,
          stateLabel,
          value.toolCalls.length === 0 ? 'no tool calls' : `${value.toolCalls.length} tool calls`,
          value.usage === null ? '' : `${value.usage.used}/${value.usage.size} ctx`,
        ]
          .filter((part) => part !== '')
          .join(' · ')
        const lines = [header, '']
        lines.push(
          value.answer !== ''
            ? value.answer
            : value.status === 'running'
              ? '（后台运行中：pi_session action="output" 读进度，action="wait" 阻塞等待）'
              : '(pi returned no prose)',
        )
        if (value.answerTruncated === true) lines.push('', `… answer truncated at ${value.answer.length} chars.`)
        if (value.toolCalls.length > 0) {
          lines.push('', 'pi tool calls:')
          for (const call of value.toolCalls) {
            const mark = call.status === 'completed' ? '✓' : call.status === 'failed' ? '✗' : '·'
            lines.push(`  ${mark} ${call.title} (${call.kind}, ${call.status})`)
          }
        }
        if (value.log.length > 0) {
          lines.push('', 'trace:')
          for (const entry of value.log) lines.push(`  ${entry}`)
        }
        lines.push('', `继续这个会话：pi_run 传 session="${value.session}"。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: Math.max(settings.timeoutMs, 30_000) + 30_000,
    isConcurrencySafe: () => true,
    /**
     * @param {unknown} rawArgs - model arguments.
     * @param {{signal?: AbortSignal}} exec - execution context.
     * @returns {Promise<Record<string, any>>} the turn result.
     */
    async execute(rawArgs, exec) {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (task === '') throw new PiAcpError('task 必填，且必须是非空字符串。', 'pi_acp_bad_task')
      const request = {
        task,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        handle: typeof args.session === 'string' ? args.session : undefined,
        resumeId: typeof args.resume === 'string' ? args.resume : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
        thinking: typeof args.thinking === 'string' ? args.thinking : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        signal: exec?.signal,
      }
      if (args.background === true) {
        // Detached: no caller signal, the turn keeps its own wall-clock timer.
        const state = await manager.begin({ ...request, signal: undefined })
        return {
          ...manager.result(state.record, state.collector, { stopReason: 'background', elapsedMs: 0 }),
          status: 'running',
        }
      }
      return manager.run(request)
    },
  }

  /** @returns {object} the `pi_session` tool definition. */
  const sessionTool = {
    name: 'pi_session',
    description: [
      'Inspect or close the pi sessions this plugin holds open.',
      'action "list" reports each live handle with its directory, model, turn count and idle time — use it to find the handle to continue with pi_run.',
      'action "close" ends one session (or all of them) and frees its pi process; a closed session can still be reached through pi_run `resume` if you know its pi session id.',
      'action "output" reports one handle\'s latest turn without blocking: status (running/done/failed/idle), elapsed seconds, the answer received so far, the tool calls and any error.',
      'action "wait" blocks up to waitMs (max 5 min) for that turn to settle, then reports the same snapshot — use it after pi_run with background: true.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'close', 'output', 'wait'],
          description: "What to do: list sessions, close them, read one handle's latest turn (output), or wait for it to settle (wait). Defaults to list.",
        },
        session: {
          type: 'string',
          description: 'Handle to act on. Required for output/wait; omit with action close to close every session.',
        },
        waitMs: {
          type: 'integer',
          description: 'For action wait: how long to block, 0–300000 ms. Defaults to 60000.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          status: { type: 'string' },
          answer: { type: 'string' },
          elapsedMs: { type: 'integer' },
          stopReason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          closed: { type: 'array', items: { type: 'string' } },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session: { type: 'string' },
                piSessionId: { type: 'string' },
                cwd: { type: 'string' },
                model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                thinking: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                busy: { type: 'boolean' },
                turns: { type: 'integer' },
                idleSeconds: { type: 'integer' },
                alive: { type: 'boolean' },
              },
              required: ['session', 'cwd', 'busy', 'turns', 'idleSeconds', 'alive'],
            },
          },
        },
        required: ['action', 'sessions'],
      },
      render: (_args, value) => {
        if (typeof value.status === 'string') {
          // output / wait snapshot of one turn.
          const head = [
            `pi · ${value.session ?? ''}`,
            value.status,
            `${Math.round(Number(value.elapsedMs ?? 0) / 1000)}s`,
            typeof value.stopReason === 'string' ? value.stopReason : '',
            value.usage !== null && value.usage !== undefined ? `${value.usage.used}/${value.usage.size} ctx` : '',
          ]
          const lines = [head.filter((part) => part !== '').join(' · '), '']
          if (typeof value.error === 'string' && value.error !== '') lines.push(`error: ${value.error}`, '')
          lines.push(value.answer === '' ? '(还没有输出)' : value.answer)
          const calls = Array.isArray(value.toolCalls) ? value.toolCalls : []
          if (calls.length > 0) {
            lines.push('', 'pi tool calls:')
            for (const call of calls) {
              const mark = call.status === 'completed' ? '✓' : call.status === 'failed' ? '✗' : '·'
              lines.push(`  ${mark} ${call.title} (${call.kind}, ${call.status})`)
            }
          }
          if (value.status === 'running') {
            lines.push('', `仍在跑：pi_session action="wait" session="${value.session ?? ''}" waitMs=300000`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`pi sessions · ${value.sessions.length} live`]
        if (value.closed !== undefined && value.closed.length > 0) lines.push('', `closed: ${value.closed.join(', ')}`)
        if (value.sessions.length === 0) {
          lines.push('', '当前没有打开的 pi 会话。')
        } else {
          lines.push('')
          for (const item of value.sessions) {
            lines.push(
              `- ${item.session} → ${item.piSessionId} · ${item.cwd} · ${item.model ?? 'pi default'} · ${item.turns} turns · idle ${item.idleSeconds}s${item.busy ? ' · busy' : ''}${item.alive ? '' : ' · dead'}`,
            )
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    /**
     * @param {unknown} rawArgs - model arguments.
     * @returns {Promise<Record<string, any>>} the snapshot.
     */
    async execute(rawArgs) {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const requested = typeof args.action === 'string' ? args.action : 'list'
      const action =
        requested === 'close' || requested === 'output' || requested === 'wait' ? requested : 'list'
      if (action === 'output' || action === 'wait') {
        const target = typeof args.session === 'string' ? args.session.trim() : ''
        if (target === '') throw new PiAcpError(`action "${action}" 需要 session 句柄。`, 'pi_acp_bad_session')
        const snapshot =
          action === 'wait'
            ? await manager.waitFor(target, typeof args.waitMs === 'number' ? args.waitMs : 60_000)
            : manager.snapshot(target)
        return { action, sessions: manager.list(), ...snapshot }
      }
      if (action === 'list') return { action, sessions: manager.list() }
      const handle = typeof args.session === 'string' ? args.session.trim() : ''
      if (handle === '') {
        const closed = [...manager.sessions.keys()]
        for (const key of closed) manager.forget(key)
        return { action, closed, sessions: manager.list() }
      }
      if (!manager.sessions.has(handle)) throw new PiAcpError(`没有会话 ${handle}。`, 'pi_acp_unknown_session')
      manager.forget(handle)
      return { action, closed: [handle], sessions: manager.list() }
    },
  }

  /** @returns {object} the `pi_status` tool definition. */
  const statusTool = {
    name: 'pi_status',
    description: [
      'Check that the pi agent is reachable from this plugin and see what it offers.',
      'Reports the resolved pi-acp entry point, adapter and pi versions, and — with probe enabled — a live handshake that lists the models pi can use.',
      'Call it first when pi_run fails with a launch or authentication error: it separates "adapter not installed", "pi has no credentials" and "wrong entry point".',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: 'Open a real pi session to read its model list. Costs one process start and a few seconds. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          entry: { type: 'string' },
          node: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          source: { type: 'string' },
          versions: {
            type: 'object',
            properties: {
              piAcp: { type: 'string' },
              pi: { type: 'string' },
            },
          },
          agent: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          capabilities: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          models: { type: 'array', items: { type: 'string' } },
          thinking: { type: 'array', items: { type: 'string' } },
          sessions: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok', 'entry', 'source', 'versions', 'models', 'thinking', 'sessions'],
      },
      render: (_args, value) => {
        const lines = [`pi ACP · ${value.ok ? 'ready' : 'not ready'} · via ${value.source}`]
        lines.push(`entry: ${value.entry}`)
        if (typeof value.node === 'string') lines.push(`node: ${value.node}`)
        lines.push(`versions: pi-acp ${value.versions.piAcp ?? '?'} · pi ${value.versions.pi ?? '?'}`)
        if (typeof value.error === 'string') lines.push('', `error: ${value.error}`)
        if (value.models.length > 0) {
          lines.push('', `models (${value.models.length}):`)
          for (const id of value.models.slice(0, 40)) lines.push(`- ${id}`)
          if (value.models.length > 40) lines.push(`… ${value.models.length - 40} more`)
        }
        if (value.thinking.length > 0) lines.push('', `thinking levels: ${value.thinking.join(', ')}`)
        if (value.sessions.length > 0) lines.push('', `live sessions: ${value.sessions.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    /**
     * @param {unknown} rawArgs - model arguments.
     * @returns {Promise<Record<string, any>>} the report.
     */
    async execute(rawArgs) {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const probe = args.probe !== false
      const cwd = settings.defaultCwd === '' ? process.cwd() : resolvePath(settings.defaultCwd)
      const report = {
        ok: false,
        entry: '',
        node: null,
        source: '',
        versions: {},
        agent: null,
        capabilities: null,
        models: [],
        thinking: [],
        sessions: manager.list().map((item) => item.session),
      }
      let spec
      try {
        spec = manager.launchSpec()
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error)
        return report
      }
      report.entry = spec.entry
      report.node = spec.node ?? null
      report.source = spec.source
      report.versions = readVersions(spec.entry)
      if (!probe) {
        report.ok = true
        return report
      }
      let transport
      try {
        const connection = await manager.connect(cwd)
        transport = connection.transport
        report.agent = connection.init?.agentInfo ?? null
        report.capabilities = connection.init?.agentCapabilities ?? null
        const session = await transport.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 180_000 })
        report.models = Array.isArray(session?.models?.availableModels)
          ? session.models.availableModels.map((model) => String(model.modelId))
          : []
        report.thinking = Array.isArray(session?.modes?.availableModes)
          ? session.modes.availableModes.map((mode) => String(mode.id))
          : []
        report.ok = report.models.length > 0
        if (!report.ok) {
          report.error = '会话已建立，但 pi 没有报告任何可用模型：先在终端执行一次 pi 完成登录／配置 API key。'
        }
      } catch (error) {
        const explained = manager.explain(error)
        report.error = explained instanceof Error ? explained.message : String(explained)
      } finally {
        transport?.dispose()
      }
      return report
    },
  }

  // Register through whichever context owns the tools service. `ctx.tools` is
  // present when the host already injected it (the usual case); otherwise fall
  // back to a dependency fork. Each tool is registered on its own so one bad
  // definition can never take the other two down with it.
  const mountTools = (scope) => {
    trace('mountTools · entered (tools injected)')
    for (const definition of [runTool, sessionTool, statusTool]) {
      try {
        const dispose = scope.tools.register(definition)
        if (typeof dispose === 'function') scope.effect?.(() => dispose, `pi-acp: ${definition.name}`)
        trace(`register ${definition.name} · ok · disposer=${typeof dispose}`)
      } catch (error) {
        trace(`register ${definition.name} · FAIL · ${error?.constructor?.name}: ${error?.message ?? error}`)
        const text = `[pi-acp] 注册 ${definition.name} 失败：${error?.message ?? error}`
        console.error(text)
        ctx.logger?.error?.(text)
      }
    }
  }
  // `ctx.tools` cannot be probed: cordis throws `cannot get property "tools"
  // without inject` for an undeclared service. Always go through inject(), which
  // starts this callback as a dependency fork once the tools service is ready.
  trace('mount path · ctx.inject([tools])')
  ctx.inject(['tools'], mountTools)

  // Read-only self-check for the Settings page. The client cannot ask the host
  // anything else, so its "installation" line reads this route.
  let configEditorRef = null
  ctx.inject(['configEditor'], (editorCtx) => {
    configEditorRef = editorCtx.configEditor
    trace('configEditor service available')
  })
  let settingsRef = null
  ctx.inject(['settings'], (settingsCtx) => {
    settingsRef = settingsCtx.settings
    trace('settings service available')
  })
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pi-acp/diagnose',
          handler: (req, res) => {
            trace(`diagnose route · ${req.url ?? ''}`)
            let report
            try {
              const spec = manager.launchSpec()
              const versions = readVersions(spec.entry)
              report = {
                ok: true,
                piAcp: {
                  entry: spec.entry,
                  source: spec.source,
                  version: versions.piAcp ?? null,
                  exists: existsSync(spec.entry),
                },
                pi: { version: versions.pi ?? null },
                thinking: manager.settings.thinking,
                model: manager.settings.model,
              }
              // Why the Settings form may be unavailable: what the loader holds
              // for this entry (id, fiber state, and whether Config arrived).
              try {
                const cfg = configEditorRef?.configuration?.() ?? []
                report.entryCount = cfg.length
                report.entries = cfg
                  .map((item) => item?.entry)
                  .filter((entry) => entry !== undefined && /pi-acp/i.test(String(entry?.id ?? '')))
                  .map((entry) => ({
                    id: entry.id,
                    state: entry.fiber?.state ?? null,
                    hasRuntime: entry.fiber?.runtime != null,
                    hasConfig: entry.fiber?.runtime?.Config != null,
                    configKeys: entry.fiber?.runtime?.Config
                      ? Object.keys(entry.fiber.runtime.Config.dict ?? {})
                      : [],
                  }))
              } catch (error) {
                report.entriesError = error instanceof Error ? error.message : String(error)
              }
              // What the Settings document actually serves, so the client's
              // "namespace not served" case is diagnosable from outside.
              try {
                const forms = settingsRef?.describe?.() ?? []
                report.forms = forms.map((item) => ({
                  ns: item.ns,
                  fields: Object.keys(item.schema?.properties ?? item.schema?.dict ?? {}),
                  schemaKeys: Object.keys(item.schema ?? {}),
                  schemaHead: JSON.stringify(item.schema ?? null).slice(0, 260),
                  revision: item.revision,
                }))
              } catch (error) {
                report.formsError = error instanceof Error ? error.message : String(error)
              }
            } catch (error) {
              report = { ok: false, error: error instanceof Error ? error.message : String(error) }
            }
            trace(`diagnose route · ok=${report.ok}`)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(report))
          },
        }),
      'pi-acp: diagnose route',
    )
  })
}

/** Loader-friendly shape: `unwrapExports` prefers `default` when it exists, so
 * the settings schema must ride along or the entry looks non-configurable. */
export default { name, apply, Config }
