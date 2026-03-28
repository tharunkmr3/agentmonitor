import { spawn, execSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'
import { normalizeCodexEvent } from './codex-event-normalizer'
import { log as _log } from '../logger'
import { getCliEnv } from '../cli-env'
import type { NormalizedEvent, EnrichedError } from '../../shared/types'

const MAX_RING_LINES = 100

function log(msg: string): void {
  _log('CodexRunManager', msg)
}

export interface CodexRunOptions {
  prompt: string
  projectPath: string
  model?: string
  fullAuto?: boolean
}

export interface CodexRunHandle {
  runId: string
  process: ChildProcess
  pid: number | null
  startedAt: number
  stderrTail: string[]
  stdoutTail: string[]
  toolCallCount: number
}

/**
 * CodexRunManager: spawns `codex exec --json` processes, parses JSONL,
 * emits normalized events compatible with the Claude Code pipeline.
 *
 * Events emitted:
 *  - 'normalized' (runId, NormalizedEvent)
 *  - 'exit' (runId, code, signal, sessionId)
 *  - 'error' (runId, Error)
 */
export class CodexRunManager extends EventEmitter {
  private activeRuns = new Map<string, CodexRunHandle>()
  private finishedRuns = new Map<string, CodexRunHandle>()
  private codexBinary: string

  constructor() {
    super()
    this.codexBinary = this._findCodexBinary()
    log(`Codex binary: ${this.codexBinary}`)
  }

  private _findCodexBinary(): string {
    const candidates = [
      join(homedir(), '.bun/bin/codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      join(homedir(), '.npm-global/bin/codex'),
    ]

    for (const c of candidates) {
      try {
        execSync(`test -x "${c}"`, { stdio: 'ignore' })
        return c
      } catch {}
    }

    try {
      return execSync('/bin/zsh -ilc "whence -p codex"', { encoding: 'utf-8', env: getCliEnv() }).trim()
    } catch {}

    try {
      return execSync('/bin/bash -lc "which codex"', { encoding: 'utf-8', env: getCliEnv() }).trim()
    } catch {}

    return 'codex'
  }

  private _getEnv(): NodeJS.ProcessEnv {
    const env = getCliEnv()
    const binDir = this.codexBinary.substring(0, this.codexBinary.lastIndexOf('/'))
    if (env.PATH && !env.PATH.includes(binDir)) {
      env.PATH = `${binDir}:${env.PATH}`
    }
    return env
  }

  startRun(requestId: string, options: CodexRunOptions): CodexRunHandle {
    const cwd = options.projectPath === '~' ? homedir() : options.projectPath

    const args: string[] = [
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--color', 'never',
    ]

    if (options.model) {
      args.push('-m', options.model)
    }

    // Prompt as positional argument
    args.push(options.prompt)

    log(`Starting codex run ${requestId}: ${this.codexBinary} ${args.join(' ')}`)

    const child = spawn(this.codexBinary, args, {
      cwd,
      env: this._getEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const handle: CodexRunHandle = {
      runId: requestId,
      process: child,
      pid: child.pid || null,
      startedAt: Date.now(),
      stderrTail: [],
      stdoutTail: [],
      toolCallCount: 0,
    }

    this.activeRuns.set(requestId, handle)

    // Parse JSONL from stdout
    let stdoutBuf = ''
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Keep ring buffer
        handle.stdoutTail.push(trimmed)
        if (handle.stdoutTail.length > MAX_RING_LINES) handle.stdoutTail.shift()

        try {
          const parsed = JSON.parse(trimmed)
          const events = normalizeCodexEvent(parsed)
          for (const ev of events) {
            if (ev.type === 'tool_call') handle.toolCallCount++
            this.emit('normalized', requestId, ev)
          }
        } catch {
          // Non-JSON line — might be plain text output from codex
          // Emit as text chunk so it shows up in the UI
          if (trimmed.length > 0 && !trimmed.startsWith('{')) {
            this.emit('normalized', requestId, { type: 'text_chunk', text: trimmed + '\n' } as NormalizedEvent)
          }
        }
      }
    })

    // Collect stderr
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      const lines = chunk.split('\n')
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        handle.stderrTail.push(t)
        if (handle.stderrTail.length > MAX_RING_LINES) handle.stderrTail.shift()
      }
    })

    child.on('exit', (code, signal) => {
      log(`Codex run ${requestId} exited: code=${code} signal=${signal}`)
      // Flush remaining stdout
      if (stdoutBuf.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuf.trim())
          const events = normalizeCodexEvent(parsed)
          for (const ev of events) {
            this.emit('normalized', requestId, ev)
          }
        } catch {}
      }

      this.activeRuns.delete(requestId)
      this.finishedRuns.set(requestId, handle)
      this.emit('exit', requestId, code, signal ? String(signal) : null, null)
    })

    child.on('error', (err) => {
      log(`Codex run ${requestId} error: ${err.message}`)
      this.activeRuns.delete(requestId)
      this.finishedRuns.set(requestId, handle)
      this.emit('error', requestId, err)
    })

    return handle
  }

  cancel(requestId: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false
    try {
      handle.process.kill('SIGINT')
      return true
    } catch {
      return false
    }
  }

  isRunning(requestId: string): boolean {
    return this.activeRuns.has(requestId)
  }

  getEnrichedError(requestId: string, exitCode: number | null): EnrichedError {
    const handle = this.activeRuns.get(requestId) || this.finishedRuns.get(requestId)
    return {
      message: 'Codex process error',
      stderrTail: handle?.stderrTail || [],
      stdoutTail: handle?.stdoutTail || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
    }
  }

  getVersion(): string | null {
    try {
      return execSync(`"${this.codexBinary}" --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        env: this._getEnv(),
      }).trim()
    } catch {
      return null
    }
  }

  isInstalled(): boolean {
    try {
      execSync(`test -x "${this.codexBinary}"`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}
