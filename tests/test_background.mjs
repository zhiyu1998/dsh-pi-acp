// End-to-end check of the new background mode, against the real pi CLI, with no
// DSH restart involved: mount the bundle on a fake ctx, call pi_run with
// background: true, then poll pi_session output/wait.
const BUNDLE = new URL('../index.js', import.meta.url).href

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
const run = tools.get('pi_run')
const session = tools.get('pi_session')
const render = (tool, args, value) => tool.output.render(args, value)[0].text

const cwd = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace'

console.log('=== pi_run background: true ===')
const t0 = Date.now()
const started = await run.execute({
  task: '只输出两个字：后台。不要调用任何工具。',
  cwd,
  background: true,
  timeoutMs: 180_000,
})
console.log(`returned in ${Date.now() - t0}ms`)
console.log(render(run, {}, started))
const handle = started.session

console.log('\n=== pi_session output (immediately) ===')
const first = await session.execute({ action: 'output', session: handle })
console.log(render(session, {}, first))

await new Promise((resolve) => setTimeout(resolve, 4000))

console.log('\n=== pi_session output (after 4s) ===')
const second = await session.execute({ action: 'output', session: handle })
console.log(render(session, {}, second))

console.log('\n=== pi_session wait ===')
const waited = await session.execute({ action: 'wait', session: handle, waitMs: 120_000 })
console.log(render(session, {}, waited))
console.log(`\n[status] ${waited.status} · answer=${JSON.stringify(waited.answer)}`)

console.log('\n=== pi_session list ===')
console.log(render(session, {}, await session.execute({ action: 'list' })))

console.log('\n=== pi_session close ===')
console.log(render(session, {}, await session.execute({ action: 'close', session: handle })))

const ok = waited.status === 'done' && waited.answer.includes('后台')
console.log(`\n[RESULT] ${ok ? 'PASS' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
