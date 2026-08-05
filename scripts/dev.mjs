import { spawn } from 'node:child_process'
import process from 'node:process'

/* `optional: true` means this one exiting does NOT take the others down.
 *
 * Only the gate is marked so, and the reason is specific: it needs remote R2 (a real bucket, since
 * the pipeline uploads through the S3 API and Wrangler's simulated bucket can never see those
 * bytes), which in turn needs a Cloudflare login and a registered workers.dev subdomain. On a fresh
 * machine, or offline, it will not start — and the portal is built to run without it: no
 * VITE_CDN_GATE_URL, or an unreachable one, degrades to "no gated delivery" rather than breaking
 * (see web/.../services/cdnGate.ts). Letting it stop `npm run dev` would make the whole dev
 * environment depend on Cloudflare being reachable, for a feature that is optional by design. */
const services = [
  { name: 'desktop', color: '\x1b[36m', args: ['--prefix', 'desktop', 'run', 'tauri', 'dev'] },
  { name: 'web', color: '\x1b[35m', args: ['run', 'dev', '--workspace=web/apps/client-hub'] },
  { name: 'docs', color: '\x1b[33m', args: ['--prefix', 'docs', 'run', 'dev'] },
  { name: 'gate', color: '\x1b[32m', args: ['run', 'dev:gate'], optional: true },
]

const reset = '\x1b[0m'
const children = new Set()
let shuttingDown = false

function prefixOutput(stream, target, label) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) target.write(`${label} ${line}\n`)
  })
  stream.on('end', () => {
    if (pending) target.write(`${label} ${pending}\n`)
  })
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
  }, 5000).unref()
}

for (const service of services) {
  const label = `${service.color}[${service.name.padEnd(7)}]${reset}`
  const child = spawn('npm', service.args, {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  children.add(child)
  prefixOutput(child.stdout, process.stdout, label)
  prefixOutput(child.stderr, process.stderr, label)

  child.on('error', error => {
    console.error(`${label} failed to start: ${error.message}`)
    if (service.optional) return
    process.exitCode = 1
    stopAll()
  })

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown || (code === 0 && !signal)) return
    if (service.optional) {
      console.error(
        `${label} exited (${signal ?? `code ${code}`}) — carrying on without it. ` +
        'Gated thumbnails and downloads will not load; everything else is unaffected. ' +
        'Needs `wrangler login` and a workers.dev subdomain on the account.',
      )
      return
    }
    console.error(`${label} exited unexpectedly (${signal ?? `code ${code}`}); stopping the other apps.`)
    process.exitCode = code || 1
    stopAll()
  })
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

process.on('exit', () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
})
