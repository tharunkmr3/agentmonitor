import React, { useState, useRef, useEffect } from 'react'
import { useCanvasStore, selectNodes, selectClosedNodes } from '../stores/canvasStore'

function formatTimeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function Toolbar() {
  const addNode = useCanvasStore(s => s.addNode)
  const updateNode = useCanvasStore(s => s.updateNode)
  const columns = useCanvasStore(s => s.columns)
  const setGridSize = useCanvasStore(s => s.setGridSize)
  const nodes = useCanvasStore(selectNodes)
  const closedNodes = useCanvasStore(selectClosedNodes)
  const restoreNode = useCanvasStore(s => s.restoreNode)
  const claudeVersion = useCanvasStore(s => s.claudeVersion)
  const codexVersion = useCanvasStore(s => s.codexVersion)
  const rows = useCanvasStore(s => s.rows)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [historyOpen])

  const handleNewAgent = async () => {
    const nodeId = addNode()
    try {
      const { tabId } = await window.canvas.createTab()
      useCanvasStore.getState().updateNode(nodeId, { tabId })
    } catch (err) {
      console.error('Failed to create tab:', err)
    }
  }

  const handleNewCodexAgent = async () => {
    const nodeId = addNode(undefined, 'codex')
    try {
      const { tabId } = await window.canvas.codexCreateTab()
      useCanvasStore.getState().updateNode(nodeId, { tabId })
    } catch (err) {
      console.error('Failed to create codex tab:', err)
    }
  }

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2" role="toolbar" aria-label="Agent controls">
      {/* Main toolbar */}
      <div className="node-glass flex items-center gap-2" style={{ borderRadius: 'var(--radius-xl)', height: 42, padding: '0 8px' }}>
        {/* New Agent */}
        <button
          onClick={handleNewAgent}
          className="flex items-center gap-2 text-[13px] font-medium btn-accent"
          style={{ borderRadius: 9999, padding: '7px 14px' }}
          aria-label="Create new agent"
          title="New Agent (Cmd+N)"
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          <span>Claude</span>
        </button>

        {codexVersion && (
          <button
            onClick={handleNewCodexAgent}
            className="flex items-center gap-2 text-[13px] font-medium"
            style={{
              borderRadius: 9999,
              padding: '7px 14px',
              background: 'hsl(142 70% 45% / 0.15)',
              color: 'hsl(142 70% 60%)',
              border: 'none',
              cursor: 'pointer',
            }}
            aria-label="Create new Codex agent"
            title="New Codex Agent"
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
            <span>Codex</span>
          </button>
        )}

        <div className="w-px mx-1" style={{ height: 20, background: 'hsl(var(--border) / 0.5)' }} />

        {/* Grid columns control */}
        <div className="flex items-center gap-1" style={{ padding: '0 4px' }}>
          <button
            onClick={() => setGridSize(columns - 1, rows)}
            disabled={columns <= 1}
            className="w-7 h-7 flex items-center justify-center btn-ghost disabled:opacity-20 text-base leading-none"
            style={{ borderRadius: 'var(--radius-sm)' }}
            aria-label="Fewer columns"
            title="Fewer columns"
          >
            −
          </button>
          <span className="w-12 text-center text-[10px] tabular-nums" style={{ color: 'hsl(var(--text-muted))', fontFamily: 'var(--font-mono)' }}>
            {columns} col{columns !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setGridSize(columns + 1, rows)}
            disabled={columns >= 5}
            className="w-7 h-7 flex items-center justify-center btn-ghost disabled:opacity-20 text-base leading-none"
            style={{ borderRadius: 'var(--radius-sm)' }}
            aria-label="More columns"
            title="More columns"
          >
            +
          </button>
        </div>

        {/* History button */}
        {closedNodes.length > 0 && (
          <>
            <div className="w-px mx-1" style={{ height: 20, background: 'hsl(var(--border) / 0.5)' }} />
            <div className="relative" ref={historyRef}>
              <button
                onClick={() => setHistoryOpen(o => !o)}
                className="flex items-center gap-1.5 text-[11px] btn-ghost"
                style={{ borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
                title="Recently closed agents"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                <span>{closedNodes.length}</span>
              </button>
              {historyOpen && (
                <div className="history-dropdown">
                  <div className="history-title">Recently closed</div>
                  {closedNodes.map((entry, i) => {
                    const ago = formatTimeAgo(entry.closedAt)
                    return (
                      <button
                        key={entry.node.id + '-' + i}
                        className="history-item"
                        onClick={() => {
                          restoreNode(i)
                          setHistoryOpen(false)
                        }}
                      >
                        <span className="history-item-title">{entry.node.title}</span>
                        <span className="history-item-meta">
                          {entry.node.messages.length} msg · {ago}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Status pill — same height as main toolbar */}
      <div className="node-glass flex items-center gap-2.5" style={{ borderRadius: 'var(--radius-xl)', height: 42, padding: '0 14px' }}>
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'hsl(var(--accent))' }} />
        <span className="text-[11px] tabular-nums" style={{ color: 'hsl(var(--text-muted))', fontFamily: 'var(--font-mono)' }}>
          {nodes.length} agent{nodes.length !== 1 ? 's' : ''}
        </span>
        {claudeVersion && (
          <>
            <div className="w-px" style={{ height: 14, background: 'hsl(var(--border) / 0.4)' }} />
            <span className="text-[11px]" style={{ color: 'hsl(var(--text-muted) / 0.6)', fontFamily: 'var(--font-mono)' }}>
              {claudeVersion}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
