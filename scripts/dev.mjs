import { spawn } from 'node:child_process'
import process from 'node:process'

const services = [
  { name: 'desktop', color: '\x1b[36m', args: ['--prefix', 'desktop', 'run', 'tauri', 'dev'] },
  { name: 'web', color: '\x1b[35m', args: ['--prefix', 'web', 'run', 'dev'] },
  { name: 'docs', color: '\x1b[33m', args: ['--prefix', 'docs', 'run', 'dev'] },
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
  })
  children.add(child)
  prefixOutput(child.stdout, process.stdout, label)
  prefixOutput(child.stderr, process.stderr, label)

  child.on('error', error => {
    console.error(`${label} failed to start: ${error.message}`)
    process.exitCode = 1
    stopAll()
  })

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && (code !== 0 || signal)) {
      console.error(`${label} exited unexpectedly (${signal ?? `code ${code}`}); stopping the other apps.`)
      process.exitCode = code || 1
      stopAll()
    }
  })
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

process.on('exit', () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
})
