import { useEffect, useRef } from 'react'
import { useCanvasStore, selectActiveTab } from '../stores/canvasStore'

/**
 * Handles orchestrator MCP events:
 *  - create_agent → addNode + auto-submit prompt
 *  - close_agent → removeNode
 *  - send_message → submit prompt to existing node
 *  - Pushes agent snapshot to main process for list_agents / read_agent_messages
 */
export function useOrchestrator() {
  const snapshotInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Helper: get active tab from current state
    const getTab = () => selectActiveTab(useCanvasStore.getState())

    // ─── Create agent handler ───
    const unsubCreate = window.canvas.onOrchestratorCreateAgent(async (data) => {
      const { title, prompt, responseChannel } = data
      const store = useCanvasStore.getState()
      const nodeId = store.addNode(title)

      if (!nodeId) {
        // Max nodes reached
        window.canvas.orchestratorRespond(responseChannel, { nodeId: '', title, error: 'Maximum nodes reached (20)' })
        return
      }

      if (prompt) {
        setTimeout(async () => {
          try {
            const tab = getTab()
            const node = tab.nodes.find(n => n.id === nodeId)
            if (!node) return

            const result = await window.canvas.createTab()
            const tabId = result.tabId
            useCanvasStore.getState().updateNode(nodeId, { tabId, status: 'connecting' })
            useCanvasStore.getState().addMessage(nodeId, {
              id: `user-${Date.now()}`,
              role: 'user',
              content: prompt,
              timestamp: Date.now(),
            })
            useCanvasStore.getState().updateNode(nodeId, {
              title: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
            })

            const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
            const projectPath = tab.projectPath || '/'
            window.canvas.prompt(tabId, requestId, { prompt, projectPath }).catch(err => {
              console.error('Orchestrator create_agent prompt error:', err)
            })
          } catch (err) {
            console.error('Orchestrator auto-prompt error:', err)
          }
        }, 100)
      }

      window.canvas.orchestratorRespond(responseChannel, { nodeId, title })
    })

    // ─── Close agent handler ───
    const unsubClose = window.canvas.onOrchestratorCloseAgent(async (data) => {
      const { nodeId, responseChannel } = data
      const tab = getTab()
      const node = tab.nodes.find(n => n.id === nodeId)
      if (!node) {
        window.canvas.orchestratorRespond(responseChannel, false)
        return
      }

      if (node.tabId) {
        const isRunning = node.status === 'running' || node.status === 'connecting'
        if (isRunning) window.canvas.stopTab(node.tabId)
        window.canvas.closeTab(node.tabId)
      }
      useCanvasStore.getState().removeNode(nodeId)
      window.canvas.orchestratorRespond(responseChannel, true)
    })

    // ─── Send message handler ───
    const unsubSend = window.canvas.onOrchestratorSendMessage(async (data) => {
      const { nodeId, prompt, responseChannel } = data
      const tab = getTab()
      const node = tab.nodes.find(n => n.id === nodeId)
      if (!node) {
        window.canvas.orchestratorRespond(responseChannel, false)
        return
      }

      try {
        let tabId = node.tabId
        if (!tabId) {
          const result = await window.canvas.createTab()
          tabId = result.tabId
          useCanvasStore.getState().updateNode(nodeId, { tabId, status: 'connecting' })
        }

        useCanvasStore.getState().addMessage(nodeId, {
          id: `user-${Date.now()}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        })
        useCanvasStore.getState().updateNode(nodeId, { status: 'connecting' })

        // Respond immediately
        window.canvas.orchestratorRespond(responseChannel, true)

        const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
        const projectPath = tab.projectPath || '/'
        const sessionId = node.sessionId ?? undefined
        window.canvas.prompt(tabId, requestId, { prompt, projectPath, sessionId }).catch(err => {
          console.error('Orchestrator send_message prompt error:', err)
        })
      } catch {
        window.canvas.orchestratorRespond(responseChannel, false)
      }
    })

    // ─── Push agent snapshot every 2s ───
    snapshotInterval.current = setInterval(() => {
      const tab = getTab()
      const snapshot = tab.nodes.map(n => ({
        id: n.id,
        title: n.title,
        status: n.status,
        messageCount: n.messages.length,
      }))
      const messages: Record<string, Array<{ role: string; content: string }>> = {}
      for (const n of tab.nodes) {
        messages[n.id] = n.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content }))
      }
      window.canvas.pushAgentSnapshot(snapshot, messages)
    }, 2000)

    return () => {
      unsubCreate()
      unsubClose()
      unsubSend()
      if (snapshotInterval.current) clearInterval(snapshotInterval.current)
    }
  }, [])
}
