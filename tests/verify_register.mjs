// Offline proof that the plugin's three tool definitions survive DSH's own
// tools.register() validation (output shape + supported-JSON-Schema subset),
// plus output-value validation for realistic return payloads.
//
// Needs the host's @deepseek-ai/dsh-tools. Point DSH_TOOLS_ENTRY at its
// lib/index.js when DSH is installed somewhere other than the default path.
import { existsSync } from 'node:fs'

const TOOLS_CANDIDATES = [
  process.env.DSH_TOOLS_ENTRY,
  'file:///C:/DeepSeekHarness/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
]
const MOD = TOOLS_CANDIDATES.find((entry) => typeof entry === 'string' && entry !== '' && existsSync(entry.replace('file:///', '')))
if (MOD === undefined) {
  throw new Error('找不到 @deepseek-ai/dsh-tools/lib/index.js：请设置 DSH_TOOLS_ENTRY 指向该文件')
}
const BUNDLE = new URL('../index.js', import.meta.url).href
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(MOD)

const tools = new Map()
const ctx = {
  logger: { error: (m) => console.log('[logger.error]', m) },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : undefined
  },
  inject(_deps, mount) {
    mount(ctx)
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
}

const bundle = await import(BUNDLE)
bundle.apply(ctx, {})
console.log(`[mount] registered: ${[...tools.keys()].join(', ') || '(none)'}\n`)

// Mirrors lib/index.js register(): output.render must be a function, the output
// schema must stay inside the supported subset, timeoutMs must be positive.
const checkDefinition = (definition) => {
  const problems = []
  const output = definition.output
  if (output === undefined || typeof output !== 'object') problems.push('missing output')
  else {
    if (typeof output.render !== 'function') problems.push('output.render is not a function')
    try {
      assertSupportedJsonSchema(output.schema)
    } catch (error) {
      problems.push(`output.schema: ${error.message}`)
    }
  }
  if (definition.timeoutMs !== undefined && !(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0)) {
    problems.push('timeoutMs must be a positive finite number')
  }
  if (definition.name === 'run_code') problems.push('reserved name')
  return problems
}

const samples = {
  pi_run: {
    session: 'pi1',
    piSessionId: '01a1ed39-d122',
    cwd: 'C:/Users/Administrator/Downloads',
    model: null,
    thinking: null,
    stopReason: 'end_turn',
    answer: '收到。',
    answerTruncated: false,
    elapsedMs: 3304,
    updates: 8,
    toolCalls: [{ title: 'echo PI-BASH-OK', kind: 'execute', status: 'completed' }],
    usage: { used: 2348, size: 1048576 },
    log: ['[usage] 2174/1048576'],
  },
  pi_session: {
    action: 'list',
    sessions: [
      {
        session: 'pi1',
        piSessionId: '01a1ed39-d122',
        cwd: 'C:/Users/Administrator/Downloads',
        model: null,
        thinking: 'high',
        busy: false,
        turns: 2,
        idleSeconds: 12,
        alive: true,
      },
    ],
  },
  pi_status: {
    ok: true,
    entry: 'C:/nvm4w/nodejs/node_modules/pi-acp/dist/index.js',
    node: null,
    source: 'global',
    versions: { piAcp: '0.0.34', pi: '1.2.3' },
    agent: null,
    capabilities: null,
    models: ['magpie/auto/deepseek-v4.1-flash'],
    thinking: ['off', 'high'],
    sessions: ['pi1'],
  },
}

let failed = 0
for (const [name, definition] of tools) {
  const problems = checkDefinition(definition)
  if (problems.length === 0) {
    console.log(`[ok] ${name} definition accepted by DSH rules`)
  } else {
    failed += 1
    console.log(`[FAIL] ${name}: ${problems.join(' | ')}`)
  }
  const sample = samples[name]
  if (sample === undefined) continue
  try {
    const validated = validateJsonSchemaValue(definition.output.schema, sample)
    console.log(`[ok] ${name} sample output validates${validated === false ? ' (validator returned false)' : ''}`)
  } catch (error) {
    failed += 1
    console.log(`[FAIL] ${name} sample output: ${error?.message ?? error}`)
  }
  try {
    const rendered = definition.output.render({}, sample)
    const text = Array.isArray(rendered) ? rendered.map((part) => part?.text ?? '').join('') : ''
    console.log(`[ok] ${name} render → ${JSON.stringify(text.slice(0, 90))}…`)
  } catch (error) {
    failed += 1
    console.log(`[FAIL] ${name} render: ${error?.message ?? error}`)
  }
}

console.log(`\n[failed checks] ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
