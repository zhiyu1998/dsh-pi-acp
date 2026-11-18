// Standalone ACP probe: spawn pi-acp over stdio (newline-delimited JSON-RPC 2.0)
// and run one prompt. Proves the wire format before it goes into the DSH plugin.
// PI_ACP_ENTRY may point at pi-acp/dist/index.js elsewhere.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PI_ACP_ENTRY =
  process.env.PI_ACP_ENTRY ??
  ['C:/nvm4w/nodejs/node_modules/pi-acp/dist/index.js', '/usr/local/lib/node_modules/pi-acp/dist/index.js'].find((entry) =>
    existsSync(entry),
  ) ??
  'pi-acp/dist/index.js'
const CWD = process.argv[2] ?? process.cwd()
const TEXT = process.argv[3] ?? '回答两个字：收到。不要调用任何工具。'

const child = spawn(process.execPath, [PI_ACP_ENTRY], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' },
})

let nextId = 1
const pending = new Map()
const events = []
let buf = ''

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[stderr] ${chunk}`)
})

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let index
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim()
    buf = buf.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`[non-json] ${line}`)
      continue
    }
    handle(message)
  }
})

child.on('exit', (code, signal) => {
  console.log(`[exit] code=${code} signal=${signal}`)
})

function send(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  child.stdin.write(`${JSON.stringify(payload)}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method })
  })
}

function reply(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, code, message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message} (${message.error.code})`))
    else entry.resolve(message.result)
    return
  }
  if (message.method === 'session/update') {
    const update = message.params?.update ?? {}
    events.push(update)
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text : ''
      if (text !== '') process.stdout.write(text)
    } else if (kind === 'tool_call') {
      console.log(`\n[tool_call] ${update.title ?? update.toolCallId} ${update.kind ?? ''}`)
    } else if (kind === 'tool_call_update') {
      if (update.status) console.log(`[tool_call_update] ${update.toolCallId} → ${update.status}`)
    } else if (kind === 'available_commands_update') {
      console.log(`\n[commands] ${(update.availableCommands ?? []).map((c) => c.name).join(', ')}`)
    } else {
      console.log(`\n[${kind}] ${JSON.stringify(update).slice(0, 300)}`)
    }
    return
  }
  if (message.id !== undefined) {
    // Agent → client request.
    if (message.method === 'session/request_permission') {
      const options = message.params?.options ?? []
      const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0]
      console.log(`\n[permission] ${message.params?.toolCall?.title ?? ''} → ${allow?.optionId ?? 'cancel'}`)
      reply(message.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } })
      return
    }
    console.log(`\n[unhandled request] ${message.method}`)
    replyError(message.id, -32601, `Method not found: ${message.method}`)
    return
  }
  console.log(`\n[notification] ${message.method} ${JSON.stringify(message.params).slice(0, 200)}`)
}

async function main() {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { 'terminal-auth': false },
    },
  })
  console.log(`[init] ${JSON.stringify(init.agentInfo)} protocol=${init.protocolVersion}`)
  console.log(`[caps] ${JSON.stringify(init.agentCapabilities)}`)

  const session = await send('session/new', { cwd: CWD, mcpServers: [] })
  console.log(`[session] ${session.sessionId}`)
  console.log(`[models] ${JSON.stringify(session.models ?? null).slice(0, 400)}`)

  const started = Date.now()
  const response = await send('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: TEXT }],
  })
  console.log(`\n\n[prompt done] stopReason=${response.stopReason} elapsed=${Date.now() - started}ms updates=${events.length}`)
  const chunks = events
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (u.content?.type === 'text' ? u.content.text : ''))
    .join('')
  console.log(`[final text]\n${chunks}`)
  child.stdin.end()
  setTimeout(() => child.kill(), 300)
}

main().catch((error) => {
  console.error(`[fatal] ${error?.stack ?? error}`)
  child.kill()
  process.exitCode = 1
})
