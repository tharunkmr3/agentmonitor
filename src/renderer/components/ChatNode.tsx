import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useCanvasStore, selectFullscreenNodeId, selectSelectedNodeId, type GridNode } from '../stores/canvasStore'
import { MarkdownMessage } from './MarkdownMessage'

interface ChatNodeProps {
  node: GridNode
}

interface PendingAttachment {
  type: 'image' | 'document'
  mimeType: string
  data: string
  name: string
  previewUrl?: string // for image thumbnails
}

interface DragHandlers {
  onHeaderMouseDown: (e: React.MouseEvent) => void
  isDragSource: boolean
  isDropTarget: boolean
}

export function ChatNode({ node, drag }: ChatNodeProps & { drag?: DragHandlers }) {
  const [inputValue, setInputValue] = useState('')
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const selectNode = useCanvasStore(s => s.selectNode)
  const addMessage = useCanvasStore(s => s.addMessage)
  const updateNode = useCanvasStore(s => s.updateNode)
  const removeNode = useCanvasStore(s => s.removeNode)
  const answerPermission = useCanvasStore(s => s.answerPermission)
  const setFullscreenNode = useCanvasStore(s => s.setFullscreenNode)
  const fullscreenNodeId = useCanvasStore(selectFullscreenNodeId)
  const selectedNodeId = useCanvasStore(selectSelectedNodeId)

  const isRunning = node.status === 'running' || node.status === 'connecting'
  const isSelected = selectedNodeId === node.id

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [node.messages.length])

  useEffect(() => {
    if (isSelected && inputRef.current) inputRef.current.focus()
  }, [isSelected])

  // Auto-grow textarea
  const adjustHeight = useCallback(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const prompt = inputValue.trim()
    if (!prompt && attachments.length === 0) return
    const pendingAttachments = [...attachments]
    setInputValue('')
    setAttachments([])
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }

    const isCodex = node.engine === 'codex'

    let tabId = node.tabId
    if (!tabId) {
      const result = isCodex
        ? await window.canvas.codexCreateTab()
        : await window.canvas.createTab()
      tabId = result.tabId
      updateNode(node.id, { tabId, status: 'connecting' })
    }

    const displayContent = prompt
    addMessage(node.id, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
      attachments: pendingAttachments.map(a => ({ type: a.type, name: a.name, previewUrl: a.previewUrl })),
    })
    updateNode(node.id, { status: 'connecting' })
    if (node.messages.length === 0) {
      const titleBase = displayContent || pendingAttachments.map(a => a.name).join(', ')
      updateNode(node.id, { title: titleBase.substring(0, 50) + (titleBase.length > 50 ? '...' : '') })
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const state = useCanvasStore.getState()
    const aTab = state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0]
    const projectPath = aTab.projectPath
    try {
      if (isCodex) {
        await window.canvas.codexPrompt(tabId, requestId, {
          prompt: prompt || ' ',
          projectPath: projectPath || '/',
        })
      } else {
        const sessionId = aTab.nodes.find(n => n.id === node.id)?.sessionId ?? undefined
        await window.canvas.prompt(tabId, requestId, {
          prompt: prompt || ' ',
          projectPath: projectPath || '/',
          sessionId,
          attachments: pendingAttachments.map(a => ({ type: a.type, mimeType: a.mimeType, data: a.data, name: a.name })),
        })
      }
    } catch (err) {
      console.error('Prompt error:', err)
    }
  }, [inputValue, attachments, node.id, node.tabId, node.engine, node.messages.length])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }, [handleSubmit])

  const handleAttachFiles = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    const files = await window.canvas.attachFiles()
    if (!files.length) return
    setAttachments(prev => [
      ...prev,
      ...files.map(f => ({
        type: f.type,
        mimeType: f.mimeType,
        data: f.data,
        name: f.name,
        previewUrl: f.type === 'image' ? `data:${f.mimeType};base64,${f.data}` : undefined,
      })),
    ])
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const hasImageItem = Array.from(e.clipboardData.items).some(item => item.type.startsWith('image/'))
    if (!hasImageItem) return
    e.preventDefault()
    const img = await window.canvas.pasteImage()
    if (!img) return
    setAttachments(prev => [...prev, {
      type: img.type,
      mimeType: img.mimeType,
      data: img.data,
      name: img.name,
      previewUrl: `data:${img.mimeType};base64,${img.data}`,
    }])
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])


  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    // Trigger file dialog as a fallback since we can't read file paths from drag in renderer sandbox
    const files = await window.canvas.attachFiles()
    if (!files.length) return
    setAttachments(prev => [
      ...prev,
      ...files.map(f => ({
        type: f.type,
        mimeType: f.mimeType,
        data: f.data,
        name: f.name,
        previewUrl: f.type === 'image' ? `data:${f.mimeType};base64,${f.data}` : undefined,
      })),
    ])
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleClose = useCallback(() => {
    if (node.tabId) {
      if (node.engine === 'codex') {
        if (isRunning) window.canvas.codexStopTab(node.tabId)
        window.canvas.codexCloseTab(node.tabId)
      } else {
        if (isRunning) window.canvas.stopTab(node.tabId)
        window.canvas.closeTab(node.tabId)
      }
    }
    removeNode(node.id)
  }, [node.id, node.tabId, node.engine, isRunning])

  const handleStop = useCallback(() => {
    if (node.tabId) {
      node.engine === 'codex'
        ? window.canvas.codexStopTab(node.tabId)
        : window.canvas.stopTab(node.tabId)
    }
  }, [node.tabId, node.engine])

  const handleCopyMessage = useCallback((msgId: string, content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedMsgId(msgId)
    setTimeout(() => setCopiedMsgId(null), 1500)
  }, [])

  const handlePermission = useCallback((msg: typeof node.messages[0], optionId: string) => {
    if (!msg.tabId || !msg.questionId) return
    window.canvas.respondPermission(msg.tabId, msg.questionId, optionId)
    answerPermission(node.id, msg.questionId)
  }, [node.id, answerPermission])

  const statusMap: Record<string, { color: string; label: string }> = {
    new:        { color: 'hsl(var(--accent))', label: 'new' },
    idle:       { color: 'hsl(var(--text-muted))', label: 'idle' },
    connecting: { color: 'hsl(var(--accent-warm))', label: 'connecting' },
    running:    { color: 'hsl(var(--accent))', label: 'running' },
    completed:  { color: 'hsl(var(--accent-dim))', label: 'done' },
    failed:     { color: 'hsl(var(--error))', label: 'failed' },
    dead:       { color: 'hsl(var(--error))', label: 'dead' },
  }
  const status = statusMap[node.status] || statusMap.idle

  return (
    <div
      role="region"
      aria-label={`Agent: ${node.title}`}
      className={`node-glass flex flex-col h-full ${isSelected ? 'selected' : ''} ${isRunning ? 'running' : ''} ${isDragging ? 'drag-over' : ''}`}
      style={{
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        transition: `box-shadow var(--duration-normal) ease, border-color var(--duration-normal) ease`,
        opacity: drag?.isDragSource ? 0.35 : 1,
        outline: drag?.isDropTarget ? '2px solid hsl(var(--accent) / 0.5)' : 'none',
        outlineOffset: -2,
      }}
      onClick={() => selectNode(node.id)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header — drag to reorder */}
      <div
        onMouseDown={drag?.onHeaderMouseDown}
        className="flex items-center justify-between shrink-0"
        style={{ padding: '10px 12px 10px 16px', borderBottom: '1px solid hsl(var(--border) / 0.3)', cursor: 'grab' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-2 h-2 rounded-full shrink-0"
            role="status"
            aria-label={`Status: ${status.label}`}
            style={{
              backgroundColor: status.color,
              boxShadow: isRunning ? `0 0 8px ${status.color}` : 'none',
            }}
          />
          <span className="text-[13px] font-medium truncate" style={{ color: 'hsl(var(--text-primary))' }}>
            {node.title}
          </span>
          <span className="text-[10px] shrink-0" style={{ color: 'hsl(var(--text-muted))', fontFamily: 'var(--font-mono)' }}>
            {status.label}
          </span>
          <span className="text-[9px] shrink-0 uppercase tracking-wider" style={{
            color: node.engine === 'codex' ? 'hsl(142 70% 60%)' : 'hsl(var(--accent))',
            fontFamily: 'var(--font-mono)',
            padding: '1px 5px',
            borderRadius: 4,
            border: `1px solid ${node.engine === 'codex' ? 'hsl(142 70% 60% / 0.3)' : 'hsl(var(--accent) / 0.3)'}`,
          }}>
            {node.engine === 'codex' ? 'codex' : 'claude'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={e => {
              e.stopPropagation()
              setFullscreenNode(fullscreenNodeId === node.id ? null : node.id)
            }}
            className="w-7 h-7 rounded-lg flex items-center justify-center btn-ghost"
            aria-label={fullscreenNodeId === node.id ? 'Exit fullscreen' : 'Fullscreen'}
            title={fullscreenNodeId === node.id ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreenNodeId === node.id ? (
              <svg width="10" height="10" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" aria-hidden="true">
                <polyline points="6 1 6 6 1 6" /><polyline points="10 15 10 10 15 10" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" aria-hidden="true">
                <polyline points="1 6 1 1 6 1" /><polyline points="15 10 15 15 10 15" />
              </svg>
            )}
          </button>
          <button
            onClick={e => { e.stopPropagation(); handleClose() }}
            className="w-7 h-7 rounded-lg flex items-center justify-center btn-ghost-danger"
            aria-label="Close agent"
            title="Close"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden chat-scroll min-h-0 space-y-4" style={{ padding: '16px 20px' }}>
        {node.messages.length === 0 && (
          <div className="flex items-center justify-center h-full" style={{ color: 'hsl(var(--text-muted))' }}>
            <div className="text-center">
              <div className="text-[12px] font-light" style={{ fontFamily: 'var(--font-mono)' }}>ready</div>
              <div className="text-[10px] mt-1" style={{ color: 'hsl(var(--text-muted) / 0.6)' }}>
                Type a message and press Enter
              </div>
            </div>
          </div>
        )}

        {node.messages.map(msg => (
          <div key={msg.id} className={`msg-row ${msg.role === 'user' ? 'flex justify-end' : 'group relative'}`}>

            {/* User message */}
            {msg.role === 'user' && (
              <div className="selectable-text inline-block rounded-xl max-w-[88%] text-left text-[13px] leading-relaxed"
                style={{ background: 'hsl(var(--accent) / 0.15)', color: 'hsl(168 85% 65%)', padding: '10px 16px' }}>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="msg-attachments">
                    {msg.attachments.map((att, i) => (
                      att.previewUrl ? (
                        <img key={i} src={att.previewUrl} alt={att.name} className="msg-att-image" title={att.name} />
                      ) : (
                        <div key={i} className="msg-att-doc">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                          </svg>
                          <span>{att.name}</span>
                        </div>
                      )
                    ))}
                  </div>
                )}
                {msg.content && <div>{msg.content}</div>}
              </div>
            )}

            {/* Assistant message — rendered markdown */}
            {msg.role === 'assistant' && (
              <div className="flex flex-col gap-1">
                <MarkdownMessage content={msg.content} />
                {/* Copy action — shown below message on hover */}
                <div className="msg-actions">
                  <button
                    className="msg-action-btn"
                    onClick={() => handleCopyMessage(msg.id, msg.content)}
                    title="Copy message"
                  >
                    {copiedMsgId === msg.id ? (
                      <span>✓ Copied</span>
                    ) : (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Tool call */}
            {msg.role === 'tool' && (
              <ToolMessage msg={msg} />
            )}

            {/* System / permission */}
            {msg.role === 'system' && msg.permissionOptions ? (
              <PermissionMessage msg={msg} onAnswer={handlePermission} />
            ) : msg.role === 'system' && (
              <div className="text-center text-[10px] italic py-0.5"
                style={{ color: 'hsl(var(--text-muted))', fontFamily: 'var(--font-mono)' }}>
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {/* Streaming cursor */}
        {isRunning && node.messages.length > 0 && node.messages[node.messages.length - 1].role === 'assistant' && (
          <span className="streaming-cursor" />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0" style={{ margin: '0 14px 12px', paddingTop: 6 }}>
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="attach-preview-row">
            {attachments.map((att, i) => (
              <div key={i} className="attach-chip">
                {att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} className="attach-thumb" />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, color: 'hsl(var(--text-muted))' }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                )}
                <span className="attach-name">{att.name}</span>
                <button className="attach-remove" onClick={e => { e.stopPropagation(); removeAttachment(i) }} title="Remove">×</button>
              </div>
            ))}
          </div>
        )}
        {/* Input row */}
        <div className="input-row">
          <button
            className="attach-btn"
            onClick={handleAttachFiles}
            disabled={isRunning}
            title="Attach file"
            aria-label="Attach file"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <textarea
            ref={inputRef}
            className="node-input"
            value={inputValue}
            onChange={e => { setInputValue(e.target.value); adjustHeight() }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isRunning ? 'Responding...' : 'Message Claude...'}
            rows={1}
            aria-label={`Send message to ${node.title}`}
            onClick={e => e.stopPropagation()}
          />
          {isRunning ? (
            <button
              className="send-btn stop-btn"
              onClick={e => { e.stopPropagation(); handleStop() }}
              aria-label="Stop"
              title="Stop"
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1.5" /></svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={e => { e.stopPropagation(); handleSubmit() }}
              aria-label="Send"
              title="Send"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tool call row ───
function ToolMessage({ msg }: { msg: any }) {
  const [expanded, setExpanded] = useState(false)
  let parsedInput: Record<string, unknown> | null = null
  if (msg.toolInput) {
    try { parsedInput = JSON.parse(msg.toolInput) } catch {}
  }

  const color = msg.toolStatus === 'running'
    ? 'hsl(var(--accent-warm))'
    : msg.toolStatus === 'completed'
    ? 'hsl(var(--accent))'
    : 'hsl(var(--error))'

  return (
    <div className="tool-row">
      <button
        className="tool-header"
        onClick={() => parsedInput && setExpanded(e => !e)}
        style={{ cursor: parsedInput ? 'pointer' : 'default' }}
      >
        <span className="tool-dot" style={{ background: color, boxShadow: msg.toolStatus === 'running' ? `0 0 6px ${color}` : 'none' }} />
        <span className="tool-name">{msg.toolName}</span>
        {msg.toolStatus === 'running' && <span className="tool-spinner" />}
        {parsedInput && (
          <span className="tool-expand">{expanded ? '▴' : '▾'}</span>
        )}
      </button>
      {expanded && parsedInput && (
        <div className="tool-input-body">
          {Object.entries(parsedInput).map(([k, v]) => (
            <div key={k} className="tool-input-row">
              <span className="tool-input-key">{k}</span>
              <span className="tool-input-val">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Permission request — single-line pill ───
function PermissionMessage({ msg, onAnswer }: { msg: any; onAnswer: (msg: any, optionId: string) => void }) {
  if (msg.permissionAnswered) {
    // Answered — single green line
    return (
      <div className="perm-pill perm-pill-answered">
        <span className="perm-pill-dot" style={{ background: 'hsl(var(--accent))' }} />
        <span className="perm-pill-text">{msg.content}</span>
        <span className="perm-pill-badge">allowed</span>
      </div>
    )
  }

  // Pending — show inline allow/deny
  return (
    <div className="perm-pill perm-pill-pending">
      <span className="perm-pill-dot" style={{ background: 'hsl(var(--accent-warm))' }} />
      <span className="perm-pill-text">{msg.content}</span>
      <div className="perm-pill-actions">
        {msg.permissionOptions?.map((opt: any) => (
          <button
            key={opt.id}
            className={`perm-pill-btn ${opt.kind === 'deny' ? 'perm-pill-btn-deny' : 'perm-pill-btn-allow'}`}
            onClick={() => onAnswer(msg, opt.id)}
          >
            {opt.kind === 'deny' ? '✕' : '✓'}
          </button>
        ))}
      </div>
    </div>
  )
}
