import { EventEmitter } from 'events'
import { CodexRunManager } from './codex-run-manager'
import type { CodexRunOptions } from './codex-run-manager'
import { log as _log } from '../logger'
import type { TabStatus, NormalizedEvent, EnrichedError } from '../../shared/types'

function log(msg: string): void {
  _log('CodexControlPlane', msg)
}

interface CodexTabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  createdAt: number
  lastActivityAt: number
}

interface InflightRequest {
  requestId: string
  tabId: string
  promise: Promise<void>
  resolve: (value: void) => void
  reject: (reason: Error) => void
}

/**
 * CodexControlPlane: fully separate control plane for Codex tabs.
 * Does not share any state with the Claude ControlPlane.
 *
 * Events emitted:
 *  - 'event' (tabId, NormalizedEvent)
 *  - 'tab-status-change' (tabId, newStatus, oldStatus)
 *  - 'error' (tabId, EnrichedError)
 */
export class CodexControlPlane extends EventEmitter {
  private tabs = new Map<string, CodexTabEntry>()
  private inflightRequests = new Map<string, InflightRequest>()
  private runManager: CodexRunManager

  constructor() {
    super()
    this.runManager = new CodexRunManager()

    // Wire normalized events
    this.runManager.on('normalized', (requestId: string, event: NormalizedEvent) => {
      const tabId = this._findTabByRequest(requestId)
      if (!tabId) return

      const tab = this.tabs.get(tabId)
      if (!tab) return

      tab.lastActivityAt = Date.now()

      if (event.type === 'session_init' && tab.status === 'connecting') {
        this._setTabStatus(tabId, 'running')
      }

      this.emit('event', tabId, event)
    })

    // Wire exit events
    this.runManager.on('exit', (requestId: string, code: number | null, signal: string | null) => {
      const tabId = this._findTabByRequest(requestId)
      const inflight = this.inflightRequests.get(requestId)

      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.resolve()
          this.inflightRequests.delete(requestId)
        }
        return
      }

      const tab = this.tabs.get(tabId)!
      tab.activeRequestId = null

      if (code === 0) {
        this._setTabStatus(tabId, 'completed')
      } else if (signal === 'SIGINT' || signal === 'SIGKILL') {
        this._setTabStatus(tabId, 'failed')
      } else {
        const enriched = this.runManager.getEnrichedError(requestId, code)
        this.emit('error', tabId, enriched)
        this._setTabStatus(tabId, code === null ? 'dead' : 'failed')
      }

      if (inflight) {
        inflight.resolve()
        this.inflightRequests.delete(requestId)
      }
    })

    // Wire error events
    this.runManager.on('error', (requestId: string, err: Error) => {
      const tabId = this._findTabByRequest(requestId)
      const inflight = this.inflightRequests.get(requestId)

      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.reject(err)
          this.inflightRequests.delete(requestId)
        }
        return
      }

      const tab = this.tabs.get(tabId)!
      tab.activeRequestId = null

      this._setTabStatus(tabId, 'dead')
      const enriched = this.runManager.getEnrichedError(requestId, null)
      enriched.message = err.message
      this.emit('error', tabId, enriched)

      if (inflight) {
        inflight.reject(err)
        this.inflightRequests.delete(requestId)
      }
    })
  }

  // ─── Tab Lifecycle ───

  createTab(): string {
    const tabId = `codex-${crypto.randomUUID()}`
    const entry: CodexTabEntry = {
      tabId,
      status: 'idle',
      activeRequestId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    }
    this.tabs.set(tabId, entry)
    log(`Codex tab created: ${tabId}`)
    return tabId
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    if (tab.activeRequestId) {
      this.runManager.cancel(tab.activeRequestId)
      const inflight = this.inflightRequests.get(tab.activeRequestId)
      if (inflight) {
        inflight.reject(new Error('Tab closed'))
        this.inflightRequests.delete(tab.activeRequestId)
      }
    }

    this.tabs.delete(tabId)
    log(`Codex tab closed: ${tabId}`)
  }

  // ─── Submit Prompt ───

  async submitPrompt(tabId: string, requestId: string, options: CodexRunOptions): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Codex tab ${tabId} does not exist`)

    if (tab.activeRequestId) {
      throw new Error('Codex tab is busy — one prompt at a time')
    }

    tab.activeRequestId = requestId
    tab.lastActivityAt = Date.now()
    this._setTabStatus(tabId, 'connecting')

    try {
      this.runManager.startRun(requestId, options)
    } catch (err) {
      tab.activeRequestId = null
      this._setTabStatus(tabId, 'failed')
      throw err
    }

    let resolve!: (value: void) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })

    this.inflightRequests.set(requestId, { requestId, tabId, promise, resolve, reject })
    return promise
  }

  // ─── Cancel ───

  cancelTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab?.activeRequestId) return false
    return this.runManager.cancel(tab.activeRequestId)
  }

  // ─── Utility ───

  getVersion(): string | null {
    return this.runManager.getVersion()
  }

  isInstalled(): boolean {
    return this.runManager.isInstalled()
  }

  // ─── Internal ───

  private _findTabByRequest(requestId: string): string | null {
    const inflight = this.inflightRequests.get(requestId)
    if (inflight) return inflight.tabId
    for (const [tabId, tab] of this.tabs) {
      if (tab.activeRequestId === requestId) return tabId
    }
    return null
  }

  private _setTabStatus(tabId: string, newStatus: TabStatus): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const oldStatus = tab.status
    if (oldStatus === newStatus) return
    tab.status = newStatus
    log(`Codex tab ${tabId}: ${oldStatus} → ${newStatus}`)
    this.emit('tab-status-change', tabId, newStatus, oldStatus)
  }

  shutdown(): void {
    log('Shutting down Codex control plane')
    for (const [tabId] of this.tabs) {
      this.closeTab(tabId)
    }
  }
}
