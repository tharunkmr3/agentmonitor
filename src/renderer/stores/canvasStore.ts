import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { NormalizedEvent, TabStatus } from '../../shared/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  toolId?: string
  toolInput?: string
  toolStatus?: 'running' | 'completed' | 'error'
  permissionOptions?: Array<{ id: string; label: string; kind?: string }>
  questionId?: string
  tabId?: string
  permissionAnswered?: boolean
  timestamp: number
  attachments?: Array<{ type: 'image' | 'document'; name: string; previewUrl?: string }>
}

export type Engine = 'claude' | 'codex'

export interface GridNode {
  id: string
  tabId: string | null
  title: string
  status: TabStatus | 'new'
  messages: ChatMessage[]
  sessionId: string | null
  model: string | null
  engine: Engine
  createdAt: number
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

interface ClosedNode {
  node: GridNode
  closedAt: number
}

// ─── Project Tab ───
export interface ProjectTab {
  id: string
  name: string
  projectPath: string | null
  backgroundImage: string | null
  nodes: GridNode[]
  closedNodes: ClosedNode[]
  selectedNodeId: string | null
  fullscreenNodeId: string | null
}

const MAX_COLS = 5
const MAX_ROWS = 4
const MAX_NODES = MAX_COLS * MAX_ROWS

interface AppState {
  // Tabs
  tabs: ProjectTab[]
  activeTabId: string

  // Grid (shared across tabs)
  columns: number
  rows: number

  // Voice
  voiceActive: boolean

  // Versions
  claudeVersion: string | null
  codexVersion: string | null

  // ─── Tab actions ───
  addProjectTab: (name?: string, projectPath?: string) => string
  removeProjectTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  setTabProjectPath: (tabId: string, path: string) => void
  setTabBackground: (tabId: string, bg: string | null) => void

  // ─── Node actions (operate on active tab) ───
  addNode: (title?: string, engine?: Engine) => string
  removeNode: (id: string) => void
  restoreNode: (closedIndex: number) => string | null
  clearClosedNodes: () => void
  selectNode: (id: string | null) => void
  updateNode: (id: string, updates: Partial<GridNode>) => void
  setGridSize: (cols: number, rows: number) => void
  setFullscreenNode: (id: string | null) => void
  resizeNode: (id: string, edge: 'right' | 'bottom', delta: number) => void
  swapNodePositions: (idA: string, idB: string) => void

  // Chat
  addMessage: (nodeId: string, message: ChatMessage) => void
  appendToLastMessage: (nodeId: string, text: string) => void
  appendToToolInput: (nodeId: string, toolId: string, partial: string) => void
  answerPermission: (nodeId: string, questionId: string) => void

  // Background (active tab)
  setBackgroundImage: (path: string | null) => void

  // Voice
  setVoiceActive: (active: boolean) => void

  // Project (active tab)
  setProjectInfo: (path: string, version: string) => void
  setCodexVersion: (version: string | null) => void

  // Helpers (search ALL tabs)
  findNodeByTabId: (tabId: string) => GridNode | undefined
}

let nodeCounter = 0

function generateNodeId(): string {
  return `node-${Date.now()}-${++nodeCounter}`
}

function generateTabId(): string {
  return `ptab-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
}

function findNextSlot(nodes: GridNode[], cols: number): { row: number; col: number } | null {
  const occupied = new Set<string>()
  for (const n of nodes) {
    for (let r = n.row; r < n.row + n.rowSpan; r++) {
      for (let c = n.col; c < n.col + n.colSpan; c++) {
        occupied.add(`${r},${c}`)
      }
    }
  }
  for (let r = 0; r < MAX_ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      if (!occupied.has(`${r},${c}`)) return { row: r, col: c }
    }
  }
  return null // grid full
}

function createDefaultTab(name?: string, projectPath?: string): ProjectTab {
  return {
    id: generateTabId(),
    name: name || 'Project',
    projectPath: projectPath || null,
    backgroundImage: null,
    nodes: [],
    closedNodes: [],
    selectedNodeId: null,
    fullscreenNodeId: null,
  }
}

// Helper: update a specific tab in the tabs array
function updateTab(tabs: ProjectTab[], tabId: string, updater: (tab: ProjectTab) => Partial<ProjectTab>): ProjectTab[] {
  return tabs.map(t => t.id === tabId ? { ...t, ...updater(t) } : t)
}

// Helper: get active tab
function activeTab(state: { tabs: ProjectTab[]; activeTabId: string }): ProjectTab {
  return state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0]
}

const defaultTab = createDefaultTab()

// ─── Selectors for active tab state ───
export const selectActiveTab = (state: AppState): ProjectTab =>
  state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0]
export const selectNodes = (state: AppState) => selectActiveTab(state).nodes
export const selectClosedNodes = (state: AppState) => selectActiveTab(state).closedNodes
export const selectSelectedNodeId = (state: AppState) => selectActiveTab(state).selectedNodeId
export const selectFullscreenNodeId = (state: AppState) => selectActiveTab(state).fullscreenNodeId
export const selectProjectPath = (state: AppState) => selectActiveTab(state).projectPath
export const selectBackgroundImage = (state: AppState) => selectActiveTab(state).backgroundImage

export const useCanvasStore = create<AppState>()(
  persist(
    (set, get) => ({
  tabs: [defaultTab],
  activeTabId: defaultTab.id,
  columns: 3,
  rows: 2,
  voiceActive: false,
  claudeVersion: null,
  codexVersion: null,

  // ─── Tab CRUD ───
  addProjectTab: (name, projectPath) => {
    const tab = createDefaultTab(name, projectPath)
    set(state => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }))
    return tab.id
  },

  removeProjectTab: (tabId) => {
    set(state => {
      if (state.tabs.length <= 1) return state // can't remove last tab
      const remaining = state.tabs.filter(t => t.id !== tabId)
      return {
        tabs: remaining,
        activeTabId: state.activeTabId === tabId ? remaining[0].id : state.activeTabId,
      }
    })
  },

  switchTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  renameTab: (tabId, name) => {
    set(state => ({ tabs: updateTab(state.tabs, tabId, () => ({ name })) }))
  },

  setTabProjectPath: (tabId, path) => {
    set(state => ({ tabs: updateTab(state.tabs, tabId, () => ({ projectPath: path })) }))
  },

  setTabBackground: (tabId, bg) => {
    set(state => ({ tabs: updateTab(state.tabs, tabId, () => ({ backgroundImage: bg })) }))
  },

  // ─── Node actions (scoped to active tab) ───
  addNode: (title, engine = 'claude') => {
    const id = generateNodeId()
    const state = get()
    const tab = activeTab(state)

    if (tab.nodes.length >= MAX_NODES) {
      // Can't add — max nodes reached
      return ''
    }

    const slot = findNextSlot(tab.nodes, state.columns)
    if (!slot) return '' // grid full

    const node: GridNode = {
      id,
      tabId: null,
      title: title || `Agent ${tab.nodes.length + 1}`,
      status: 'new',
      messages: [],
      sessionId: null,
      model: null,
      engine,
      createdAt: Date.now(),
      row: slot.row,
      col: slot.col,
      rowSpan: 1,
      colSpan: 1,
    }

    set({
      tabs: updateTab(state.tabs, state.activeTabId, t => ({
        nodes: [...t.nodes, node],
        selectedNodeId: id,
      })),
      rows: Math.max(state.rows, slot.row + 1),
    })

    return id
  },

  removeNode: (id) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, t => {
        const node = t.nodes.find(n => n.id === id)
        const closedNodes = node
          ? [{ node: { ...node, tabId: null, status: 'idle' as const }, closedAt: Date.now() }, ...t.closedNodes].slice(0, 20)
          : t.closedNodes
        return {
          nodes: t.nodes.filter(n => n.id !== id),
          closedNodes,
          selectedNodeId: t.selectedNodeId === id ? null : t.selectedNodeId,
        }
      }),
    }))
  },

  restoreNode: (closedIndex) => {
    const state = get()
    const tab = activeTab(state)
    const entry = tab.closedNodes[closedIndex]
    if (!entry) return null

    if (tab.nodes.length >= MAX_NODES) return null

    const slot = findNextSlot(tab.nodes, state.columns)
    if (!slot) return null

    const restoredNode: GridNode = {
      ...entry.node,
      row: slot.row,
      col: slot.col,
      rowSpan: 1,
      colSpan: 1,
      status: entry.node.messages.length > 0 ? 'idle' : 'new',
      tabId: null,
    }

    set({
      tabs: updateTab(state.tabs, state.activeTabId, t => ({
        nodes: [...t.nodes, restoredNode],
        closedNodes: t.closedNodes.filter((_, i) => i !== closedIndex),
        selectedNodeId: restoredNode.id,
      })),
      rows: Math.max(state.rows, slot.row + 1),
    })

    return restoredNode.id
  },

  clearClosedNodes: () => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, () => ({ closedNodes: [] })),
    }))
  },

  selectNode: (id) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, () => ({ selectedNodeId: id })),
    }))
  },

  updateNode: (id, updates) => {
    set(state => ({
      tabs: state.tabs.map(t => ({
        ...t,
        nodes: t.nodes.map(n => n.id === id ? { ...n, ...updates } : n),
      })),
    }))
  },

  setGridSize: (cols, rows) => {
    set({ columns: Math.max(1, Math.min(MAX_COLS, cols)), rows: Math.max(1, Math.min(MAX_ROWS, rows)) })
  },

  setFullscreenNode: (id) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, () => ({ fullscreenNodeId: id })),
    }))
  },

  resizeNode: (id, edge, delta) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, t => {
        const nodes = t.nodes.map(n => ({ ...n }))
        const node = nodes.find(n => n.id === id)
        if (!node) return {}

        if (edge === 'right') {
          const newColSpan = Math.max(1, node.colSpan + delta)
          if (newColSpan > state.columns - node.col) return {}
          const rightCol = node.col + node.colSpan
          for (const n of nodes) {
            if (n.id !== id && n.row === node.row && n.col === rightCol) {
              n.colSpan = Math.max(1, n.colSpan - delta)
              n.col += delta
            }
          }
          node.colSpan = newColSpan
        } else if (edge === 'bottom') {
          const newRowSpan = Math.max(1, node.rowSpan + delta)
          const bottomRow = node.row + node.rowSpan
          for (const n of nodes) {
            if (n.id !== id && n.col === node.col && n.row === bottomRow) {
              n.rowSpan = Math.max(1, n.rowSpan - delta)
              n.row += delta
            }
          }
          node.rowSpan = newRowSpan
        }

        return { nodes }
      }),
    }))
  },

  swapNodePositions: (idA, idB) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, t => {
        const nodes = t.nodes.map(n => ({ ...n }))
        const a = nodes.find(n => n.id === idA)
        const b = nodes.find(n => n.id === idB)
        if (!a || !b) return {}
        const [aRow, aCol, aRowSpan, aColSpan] = [a.row, a.col, a.rowSpan, a.colSpan]
        a.row = b.row; a.col = b.col; a.rowSpan = b.rowSpan; a.colSpan = b.colSpan
        b.row = aRow; b.col = aCol; b.rowSpan = aRowSpan; b.colSpan = aColSpan
        return { nodes }
      }),
    }))
  },

  // ─── Chat actions (search all tabs for nodeId) ───
  addMessage: (nodeId, message) => {
    set(state => ({
      tabs: state.tabs.map(t => ({
        ...t,
        nodes: t.nodes.map(n =>
          n.id === nodeId ? { ...n, messages: [...n.messages, message] } : n
        ),
      })),
    }))
  },

  appendToLastMessage: (nodeId, text) => {
    set(state => ({
      tabs: state.tabs.map(t => ({
        ...t,
        nodes: t.nodes.map(n => {
          if (n.id !== nodeId) return n
          const msgs = [...n.messages]
          if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + text }
          }
          return { ...n, messages: msgs }
        }),
      })),
    }))
  },

  appendToToolInput: (nodeId, toolId, partial) => {
    set(state => ({
      tabs: state.tabs.map(t => ({
        ...t,
        nodes: t.nodes.map(n => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            messages: n.messages.map(m =>
              m.toolId === toolId ? { ...m, toolInput: (m.toolInput || '') + partial } : m
            ),
          }
        }),
      })),
    }))
  },

  answerPermission: (nodeId, questionId) => {
    set(state => ({
      tabs: state.tabs.map(t => ({
        ...t,
        nodes: t.nodes.map(n => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            messages: n.messages.map(m =>
              m.questionId === questionId ? { ...m, permissionAnswered: true } : m
            ),
          }
        }),
      })),
    }))
  },

  setBackgroundImage: (path) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, () => ({ backgroundImage: path })),
    }))
  },

  setVoiceActive: (active) => set({ voiceActive: active }),

  setProjectInfo: (path, version) => {
    set(state => ({
      tabs: updateTab(state.tabs, state.activeTabId, () => ({ projectPath: path })),
      claudeVersion: version,
    }))
  },

  setCodexVersion: (version) => set({ codexVersion: version }),

  findNodeByTabId: (tabId) => {
    for (const t of get().tabs) {
      const node = t.nodes.find(n => n.tabId === tabId)
      if (node) return node
    }
    return undefined
  },
    }),
    {
      name: 'agent-monitor-state',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        columns: state.columns,
        rows: state.rows,
      }),
      migrate: (persisted: any, fromVersion: number) => {
        if (fromVersion < 2 && persisted.columns < 3) {
          persisted.columns = 3
        }
        // v2 → v3: migrate flat state into tabs
        if (fromVersion < 3) {
          const tab: ProjectTab = {
            id: generateTabId(),
            name: 'Project',
            projectPath: persisted.projectPath || null,
            backgroundImage: null,
            nodes: persisted.nodes || [],
            closedNodes: persisted.closedNodes || [],
            selectedNodeId: null,
            fullscreenNodeId: null,
          }
          persisted.tabs = [tab]
          persisted.activeTabId = tab.id
          delete persisted.nodes
          delete persisted.closedNodes
          delete persisted.projectPath
        }
        return persisted
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (!state.tabs || state.tabs.length === 0) {
          state.tabs = [createDefaultTab()]
          state.activeTabId = state.tabs[0].id
        }
        state.tabs = state.tabs.map(t => ({
          ...t,
          closedNodes: t.closedNodes || [],
          nodes: t.nodes.map(n => ({
            ...n,
            tabId: null,
            engine: n.engine || 'claude',
            status: n.messages.length > 0 ? 'idle' : ('new' as const),
          })),
          selectedNodeId: null,
          fullscreenNodeId: null,
        }))
      },
    }
  )
)
