// Run one ACP prompt from a UTF-8 file (avoids Windows argv codepage issues).
// Usage: node run_task.mjs <promptFile> [cwd] [logFile]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PI_ACP_ENTRY may point at pi-acp/dist/index.js elsewhere.
const PI_ACP_ENTRY =
  process.env.PI_ACP_ENTRY ??
  ['C:/nvm4w/nodejs/node_modules/pi-acp/dist/index.js', '/usr/local/lib/node_modules/pi-acp/dist/index.js'].find((entry) =>
    existsSync(entry),
  ) ??
  'pi-acp/dist/index.js'
const promptFile = process.argv[2]
const CWD = resolve(process.argv[3] ?? process.cwd())
const LOG = process.argv[4] ?? resolve('run_task.log')

const TEXT = readFileSync(promptFile, 'utf8')
writeFileSync(LOG, '')

const log = (line) => {
  process.stdout.write(line + '\n')
  appendFileSync(LOG, line + '\n', 'utf8')
}

const child = spawn(process.execPath, [PI_ACP_ENTRY], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' },
})

let nextId = 1
const pending = new Map()
const agentText = []
const toolCalls = []
let buf = ''

child.stderr.on('data', (chunk) => log(`[stderr] ${chunk}`))

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
      log(`[non-json] ${line.slice(0, 300)}`)
      continue
    }
    handle(message)
  }
})

child.on('exit', (code, signal) => log(`[exit] code=${code} signal=${signal}`))

function send(method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }))
}

function reply(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
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
    const u = message.params?.update ?? {}
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? u.content.text : ''
        if (text) {
          agentText.push(text)
          log(`[agent] ${text.trimEnd()}`)
        }
        break
      }
      case 'agent_thought_chunk':
        break
      case 'tool_call':
        toolCalls.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status })
        log(`[tool_call] ${u.title ?? u.toolCallId} kind=${u.kind ?? ''} status=${u.status ?? ''}`)
        break
      case 'tool_call_update':
        if (u.status) log(`[tool_update] ${u.toolCallId} → ${u.status}`)
        if (u.content) log(`[tool_out] ${JSON.stringify(u.content).slice(0, 600)}`)
        break
      case 'usage_update':
        log(`[usage] ${u.used}/${u.size}`)
        break
      default:
        break
    }
    return
  }
  if (message.id !== undefined) {
    if (message.method === 'session/request_permission') {
      const options = message.params?.options ?? []
      const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0]
      log(`[permission] ${message.params?.toolCall?.title ?? ''} → ${allow?.optionId ?? 'cancel'}`)
      reply(message.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } })
      return
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })}\n`)
    return
  }
}

async function main() {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  log(`[init] ${JSON.stringify(init.agentInfo)} cwd=${CWD}`)

  const session = await send('session/new', { cwd: CWD, mcpServers: [] })
  log(`[session] ${session.sessionId} model=${session.models?.currentModelId ?? 'default'}`)

  const started = Date.now()
  const response = await send('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: TEXT }],
  })
  log(`\n[prompt done] stopReason=${response.stopReason} elapsed=${Date.now() - started}ms toolCalls=${toolCalls.length}`)
  log(`[final text]\n${agentText.join('')}`)
  child.stdin.end()
  setTimeout(() => child.kill(), 300)
}

main().catch((error) => {
  log(`[fatal] ${error?.stack ?? error}`)
  child.kill()
  process.exitCode = 1
})
