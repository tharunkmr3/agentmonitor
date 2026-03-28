import { useEffect } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import type { NormalizedEvent } from '../../shared/types'

export function useClaudeEvents(): void {
  const addMessage = useCanvasStore(s => s.addMessage)
  const appendToLastMessage = useCanvasStore(s => s.appendToLastMessage)
  const appendToToolInput = useCanvasStore(s => s.appendToToolInput)
  const updateNode = useCanvasStore(s => s.updateNode)
  const findNodeByTabId = useCanvasStore(s => s.findNodeByTabId)

  useEffect(() => {
    const unsubEvent = window.canvas.onEvent((tabId: string, event: NormalizedEvent) => {
      const node = useCanvasStore.getState().findNodeByTabId(tabId)
      if (!node) return

      switch (event.type) {
        case 'session_init':
          updateNode(node.id, {
            sessionId: event.sessionId,
            model: event.model,
            status: 'running',
          })
          break

        case 'text_chunk':
          // Append to the last assistant message or create a new one
          const lastMsg = node.messages[node.messages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.toolName) {
            appendToLastMessage(node.id, event.text)
          } else {
            addMessage(node.id, {
              id: `msg-${Date.now()}`,
              role: 'assistant',
              content: event.text,
              timestamp: Date.now(),
            })
          }
          break

        case 'tool_call':
          addMessage(node.id, {
            id: `tool-${event.toolId}`,
            role: 'tool',
            content: '',
            toolName: event.toolName,
            toolId: event.toolId,
            toolStatus: 'running',
            timestamp: Date.now(),
          })
          break

        case 'tool_call_update':
          appendToToolInput(node.id, event.toolId, event.partialInput)
          break

        case 'tool_call_complete': {
          const state = useCanvasStore.getState()
          const currentNode = state.nodes.find(n => n.id === node.id)
          if (currentNode) {
            const msgs = currentNode.messages.map(m =>
              m.role === 'tool' && m.toolStatus === 'running'
                ? { ...m, toolStatus: 'completed' as const }
                : m
            )
            updateNode(node.id, { messages: msgs })
          }
          break
        }

        case 'task_complete':
          updateNode(node.id, { status: 'completed' })
          addMessage(node.id, {
            id: `result-${Date.now()}`,
            role: 'system',
            content: `Completed in ${(event.durationMs / 1000).toFixed(1)}s`,
            timestamp: Date.now(),
          })
          break

        case 'error':
          updateNode(node.id, { status: 'failed' })
          addMessage(node.id, {
            id: `error-${Date.now()}`,
            role: 'system',
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          })
          break

        case 'permission_request':
          addMessage(node.id, {
            id: `perm-${event.questionId}`,
            role: 'system',
            content: event.toolName,
            questionId: event.questionId,
            tabId,
            permissionOptions: event.options,
            permissionAnswered: false,
            timestamp: Date.now(),
          })
          break
      }
    })

    const unsubStatus = window.canvas.onTabStatusChange((tabId, newStatus) => {
      const node = useCanvasStore.getState().findNodeByTabId(tabId)
      if (node) {
        updateNode(node.id, { status: newStatus as any })
      }
    })

    const unsubError = window.canvas.onError((tabId, error) => {
      const node = useCanvasStore.getState().findNodeByTabId(tabId)
      if (node) {
        updateNode(node.id, { status: 'failed' })
        addMessage(node.id, {
          id: `err-${Date.now()}`,
          role: 'system',
          content: `Error: ${error.message}`,
          timestamp: Date.now(),
        })
      }
    })

    return () => {
      unsubEvent()
      unsubStatus()
      unsubError()
    }
  }, [])
}
