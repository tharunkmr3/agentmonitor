import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { useCanvasStore, selectNodes, selectBackgroundImage, selectFullscreenNodeId } from '../stores/canvasStore'
import { ChatNode } from './ChatNode'

const GAP = 8
const TOOLBAR_H = 52

export function Canvas() {
  const nodes = useCanvasStore(selectNodes)
  const columns = useCanvasStore(s => s.columns)
  const backgroundImage = useCanvasStore(selectBackgroundImage)
  const selectNode = useCanvasStore(s => s.selectNode)
  const addNode = useCanvasStore(s => s.addNode)
  const updateNode = useCanvasStore(s => s.updateNode)
  const swapNodePositions = useCanvasStore(s => s.swapNodePositions)
  const fullscreenNodeId = useCanvasStore(selectFullscreenNodeId)
  const setFullscreenNode = useCanvasStore(s => s.setFullscreenNode)

  const [colWidths, setColWidths] = useState<number[]>([])
  const [rowHeights, setRowHeights] = useState<number[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // ─── Drag-to-reorder state ───
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null) // node id or "empty:row,col"
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null)
  const [ghostSize, setGhostSize] = useState<{ w: number; h: number }>({ w: 280, h: 180 })
  const ghostRef = useRef<HTMLDivElement>(null)
  const cellRectsRef = useRef<Map<string, DOMRect>>(new Map())

  useEffect(() => { setColWidths(Array(columns).fill(1)) }, [columns])

  const maxRow = Math.max(1, ...nodes.map(n => n.row + n.rowSpan))
  useEffect(() => {
    setRowHeights(prev => {
      if (prev.length === maxRow) return prev
      const next = Array(maxRow).fill(1)
      for (let i = 0; i < Math.min(prev.length, maxRow); i++) next[i] = prev[i]
      return next
    })
  }, [maxRow])

  // Build occupied set for empty cell detection
  const occupied = new Set<string>()
  for (const n of nodes) {
    for (let r = n.row; r < n.row + n.rowSpan; r++) {
      for (let c = n.col; c < n.col + n.colSpan; c++) {
        occupied.add(`${r},${c}`)
      }
    }
  }

  // Empty cells in the current grid
  const emptyCells: { row: number; col: number }[] = []
  for (let r = 0; r < maxRow; r++) {
    for (let c = 0; c < columns; c++) {
      if (!occupied.has(`${r},${c}`)) emptyCells.push({ row: r, col: c })
    }
  }

  // ─── Column divider drag ───
  const handleColDividerDrag = useCallback((colIndex: number, e: React.MouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const totalW = rect.width - GAP * (columns - 1)
    const startX = e.clientX
    const startWidths = [...colWidths.length === columns ? colWidths : Array(columns).fill(1)]
    const totalFr = startWidths.reduce((a, b) => a + b, 0)

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX
      const dxFr = (dx / totalW) * totalFr
      const next = [...startWidths]
      next[colIndex] = Math.max(0.3, startWidths[colIndex] + dxFr)
      next[colIndex + 1] = Math.max(0.3, startWidths[colIndex + 1] - dxFr)
      setColWidths(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [colWidths, columns])

  // ─── Row divider drag ───
  const handleRowDividerDrag = useCallback((rowIndex: number, e: React.MouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const totalH = rect.height - TOOLBAR_H - GAP * (maxRow - 1)
    const startY = e.clientY
    const startHeights = [...rowHeights.length === maxRow ? rowHeights : Array(maxRow).fill(1)]
    const totalFr = startHeights.reduce((a, b) => a + b, 0)

    const onMove = (me: MouseEvent) => {
      const dy = me.clientY - startY
      const dyFr = (dy / totalH) * totalFr
      const next = [...startHeights]
      next[rowIndex] = Math.max(0.3, startHeights[rowIndex] + dyFr)
      next[rowIndex + 1] = Math.max(0.3, startHeights[rowIndex + 1] - dyFr)
      setRowHeights(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rowHeights, maxRow])

  // ─── Node drag-to-reorder ───
  const handleHeaderMouseDown = useCallback((nodeId: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()

    // Snapshot all cell rects (nodes + empty cells) for hit testing
    const rects = new Map<string, DOMRect>()
    document.querySelectorAll<HTMLElement>('[data-cell-id]').forEach(el => {
      rects.set(el.dataset.cellId!, el.getBoundingClientRect())
    })
    cellRectsRef.current = rects

    // Capture thumbnail from the source node's DOM
    const sourceRect = rects.get(nodeId)
    if (sourceRect) {
      setGhostSize({ w: sourceRect.width, h: sourceRect.height })
    }

    // Clone the node DOM into the ghost container
    const sourceEl = document.querySelector<HTMLElement>(`[data-cell-id="${nodeId}"]`)
    if (sourceEl && ghostRef.current) {
      const clone = sourceEl.cloneNode(true) as HTMLElement
      clone.style.width = '100%'
      clone.style.height = '100%'
      clone.style.pointerEvents = 'none'
      ghostRef.current.innerHTML = ''
      ghostRef.current.appendChild(clone)
    }

    setDragId(nodeId)
    setGhostPos({ x: e.clientX, y: e.clientY })
    document.body.style.cursor = 'grabbing'

    const onMove = (me: MouseEvent) => {
      setGhostPos({ x: me.clientX, y: me.clientY })

      // Hit-test which cell the cursor is over
      let hit: string | null = null
      cellRectsRef.current.forEach((rect, id) => {
        if (id !== nodeId && me.clientX >= rect.left && me.clientX <= rect.right && me.clientY >= rect.top && me.clientY <= rect.bottom) {
          hit = id
        }
      })
      setDropTargetId(hit)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''

      // Perform swap or move
      setDragId(currentDragId => {
        setDropTargetId(currentDropId => {
          if (currentDragId && currentDropId && currentDragId !== currentDropId) {
            if (currentDropId.startsWith('empty:')) {
              // Move to empty cell
              const [, coords] = currentDropId.split(':')
              const [row, col] = coords.split(',').map(Number)
              useCanvasStore.getState().updateNode(currentDragId, { row, col, rowSpan: 1, colSpan: 1 })
            } else {
              // Swap with another node
              swapNodePositions(currentDragId, currentDropId)
            }
          }
          return null
        })
        return null
      })
      setGhostPos(null)
      // Clear ghost clone
      if (ghostRef.current) ghostRef.current.innerHTML = ''
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [swapNodePositions])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (useCanvasStore.getState().fullscreenNodeId) {
          setFullscreenNode(null)
        } else {
          selectNode(null)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        const nodeId = addNode()
        window.canvas.createTab().then(({ tabId }) => {
          useCanvasStore.getState().updateNode(nodeId, { tabId })
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectNode, addNode])

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.canvas) selectNode(null)
  }, [selectNode])

  const gridTemplateCols = (colWidths.length === columns ? colWidths : Array(columns).fill(1))
    .map(w => `${w}fr`).join(' ')

  const gridTemplateRows = (rowHeights.length === maxRow ? rowHeights : Array(maxRow).fill(1))
    .map(h => `${h}fr`).join(' ')

  // Scale for thumbnail ghost
  const thumbScale = Math.min(0.45, 200 / Math.max(ghostSize.w, 1))

  return (
    <div ref={containerRef} className="w-full h-full overflow-hidden relative" role="main" onClick={handleBackgroundClick} style={{ background: 'hsl(var(--surface))' }}>
      {/* Background image */}
      {backgroundImage && (
        <div className="absolute inset-0" style={{
          backgroundImage: `url(${backgroundImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }} />
      )}

      {/* Dim overlay */}
      <div className="absolute inset-0" style={{ background: 'hsl(var(--overlay) / 0.55)' }} />

      {/* Content */}
      <div
        className="relative w-full h-full"
        style={{ padding: GAP, paddingBottom: TOOLBAR_H }}
        data-canvas="true"
      >
        {nodes.length === 0 ? (
          <div className="flex items-center justify-center h-full pointer-events-none">
            <div className="text-center">
              <div className="text-[42px] font-light tracking-tight" style={{ color: 'hsl(0 0% 100% / 0.05)' }}>
                agent monitor
              </div>
              <div className="text-[11px] font-light tracking-[0.2em] uppercase mt-1" style={{ color: 'hsl(0 0% 100% / 0.07)' }}>
                claude code dashboard
              </div>
              <div className="mt-5 text-[11px]" style={{ color: 'hsl(0 0% 100% / 0.15)', fontFamily: 'var(--font-mono)' }}>
                cmd+n to create an agent
              </div>
            </div>
          </div>
        ) : (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            {/* Grid */}
            <LayoutGroup>
              <div style={{
                display: 'grid',
                gridTemplateColumns: gridTemplateCols,
                gridTemplateRows: gridTemplateRows,
                gap: GAP,
                height: '100%',
              }}>
                {nodes.map(node => (
                  <motion.div
                    key={node.id}
                    layout
                    layoutId={node.id}
                    data-cell-id={node.id}
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                    style={{
                      gridColumn: `${node.col + 1} / span ${node.colSpan}`,
                      gridRow: `${node.row + 1} / span ${node.rowSpan}`,
                      minHeight: 0, minWidth: 0,
                    }}
                  >
                    <ChatNode
                      node={node}
                      drag={{
                        onHeaderMouseDown: (e) => handleHeaderMouseDown(node.id, e),
                        isDragSource: dragId === node.id,
                        isDropTarget: dropTargetId === node.id,
                      }}
                    />
                  </motion.div>
                ))}

                {/* Empty grid cells — visible drop targets during drag */}
                {emptyCells.map(({ row, col }) => {
                  const cellKey = `empty:${row},${col}`
                  const isTarget = dropTargetId === cellKey
                  return (
                    <div
                      key={cellKey}
                      data-cell-id={cellKey}
                      style={{
                        gridColumn: col + 1,
                        gridRow: row + 1,
                        minHeight: 0, minWidth: 0,
                        borderRadius: 'var(--radius-lg)',
                        border: dragId
                          ? `1.5px dashed hsl(var(--${isTarget ? 'accent' : 'border'}) / ${isTarget ? '0.7' : '0.2'})`
                          : 'none',
                        background: isTarget ? 'hsl(var(--accent) / 0.08)' : 'transparent',
                        transition: 'border-color 0.15s ease, background 0.15s ease',
                      }}
                    />
                  )
                })}
              </div>
            </LayoutGroup>

            {/* Drag ghost — scaled thumbnail following cursor */}
            <div
              ref={ghostRef}
              style={{
                position: 'fixed',
                left: ghostPos ? ghostPos.x : -9999,
                top: ghostPos ? ghostPos.y : -9999,
                width: ghostSize.w,
                height: ghostSize.h,
                transform: `translate(-50%, -50%) scale(${thumbScale})`,
                transformOrigin: 'center center',
                pointerEvents: 'none',
                zIndex: 9999,
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: dragId ? '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px hsl(var(--accent) / 0.25)' : 'none',
                opacity: dragId ? 0.9 : 0,
                transition: 'opacity 0.15s ease',
              }}
            />

            {/* Column dividers */}
            {Array.from({ length: columns - 1 }, (_, i) => {
              const ws = colWidths.length === columns ? colWidths : Array(columns).fill(1)
              const totalFr = ws.reduce((a: number, b: number) => a + b, 0)
              const leftFraction = ws.slice(0, i + 1).reduce((a: number, b: number) => a + b, 0) / totalFr
              return (
                <div
                  key={`col-div-${i}`}
                  className="divider-col"
                  style={{ position: 'absolute', top: 0, bottom: TOOLBAR_H, left: `calc(${leftFraction * 100}% - 4px)`, width: 8, zIndex: 20 }}
                  onMouseDown={e => handleColDividerDrag(i, e)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize between column ${i + 1} and ${i + 2}`}
                >
                  <div className="divider-line w-px h-full mx-auto" />
                </div>
              )
            })}

            {/* Row dividers */}
            {Array.from({ length: maxRow - 1 }, (_, i) => {
              const hs = rowHeights.length === maxRow ? rowHeights : Array(maxRow).fill(1)
              const totalFr = hs.reduce((a: number, b: number) => a + b, 0)
              const topFraction = hs.slice(0, i + 1).reduce((a: number, b: number) => a + b, 0) / totalFr
              return (
                <div
                  key={`row-div-${i}`}
                  className="divider-row"
                  style={{ position: 'absolute', left: 0, right: 0, top: `calc(${topFraction * 100}% - 4px)`, height: 8, zIndex: 20 }}
                  onMouseDown={e => handleRowDividerDrag(i, e)}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={`Resize between row ${i + 1} and ${i + 2}`}
                >
                  <div className="divider-line h-px w-full" style={{ marginTop: 3 }} />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Fullscreen overlay */}
      <AnimatePresence>
        {fullscreenNodeId && (() => {
          const fsNode = nodes.find(n => n.id === fullscreenNodeId)
          if (!fsNode) return null
          return (
            <motion.div
              key="fullscreen-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 100,
                background: 'hsl(var(--overlay) / 0.7)',
                backdropFilter: 'blur(8px)',
              }}
              onClick={() => setFullscreenNode(null)}
            >
              <motion.div
                key="fullscreen-card"
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.85, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                style={{
                  position: 'absolute',
                  top: 16,
                  left: 16,
                  right: 16,
                  bottom: 16,
                }}
                onClick={e => e.stopPropagation()}
              >
                <ChatNode node={fsNode} />
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>
    </div>
  )
}
