import React, { useEffect } from 'react'
import { Canvas } from './components/Canvas'
import { Toolbar } from './components/Toolbar'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useOrchestrator } from './hooks/useOrchestrator'
import { useCanvasStore, selectProjectPath, selectActiveTab } from './stores/canvasStore'

export default function App() {
  useClaudeEvents()
  useOrchestrator()

  const setBackgroundImage = useCanvasStore(s => s.setBackgroundImage)
  const setProjectInfo = useCanvasStore(s => s.setProjectInfo)
  const setCodexVersion = useCanvasStore(s => s.setCodexVersion)
  const projectPath = useCanvasStore(selectProjectPath)
  const claudeVersion = useCanvasStore(s => s.claudeVersion)

  // Tab state
  const tabs = useCanvasStore(s => s.tabs)
  const activeTabId = useCanvasStore(s => s.activeTabId)
  const addProjectTab = useCanvasStore(s => s.addProjectTab)
  const removeProjectTab = useCanvasStore(s => s.removeProjectTab)
  const switchTab = useCanvasStore(s => s.switchTab)

  useEffect(() => {
    const init = async () => {
      try {
        const info = await window.canvas.start()
        setProjectInfo(info.projectPath, info.version)
        const bgData = await window.canvas.getBackground(info.projectPath)
        if (bgData) setBackgroundImage(bgData)
      } catch (err) {
        console.error('Init error:', err)
      }

      try {
        const codex = await window.canvas.codexCheck()
        if (codex.installed) {
          setCodexVersion(codex.version)
        }
      } catch {}
    }
    init()
  }, [])

  const handleChangeBg = () => {
    window.canvas.selectBackground().then(bg => {
      useCanvasStore.getState().setBackgroundImage(bg)
    })
  }

  const handleChangeDir = () => {
    window.canvas.selectDirectory().then(dir => {
      if (dir) {
        useCanvasStore.getState().setProjectInfo(dir, claudeVersion || '')
        window.canvas.getBackground(dir).then(bg => {
          useCanvasStore.getState().setBackgroundImage(bg)
        })
      }
    })
  }

  const handleNewTab = () => {
    window.canvas.selectDirectory().then(dir => {
      if (dir) {
        const name = dir.split('/').pop() || 'Project'
        addProjectTab(name, dir)
      }
    })
  }

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    removeProjectTab(tabId)
  }

  return (
    <div className="w-full h-full relative flex flex-col">
      {/* Title bar — draggable, hosts traffic lights + title */}
      <div
        className="shrink-0 flex items-center justify-between pl-4 pr-6"
        style={{
          height: 42,
          WebkitAppRegion: 'drag' as any,
        }}
      >
        {/* Left: traffic-light spacer */}
        <div style={{ width: 68 }} />

        {/* Center: title */}
        <div className="flex items-center gap-3 absolute left-1/2 -translate-x-1/2">
          <span className="text-[11px] font-medium tracking-wide select-none" style={{ color: 'hsl(0 0% 100% / 0.35)' }}>
            agent monitor
          </span>
        </div>

        {/* Right: header buttons */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' as any, marginRight: 8 }}>
          <button
            onClick={handleChangeBg}
            className="text-[10px] px-2.5 py-1 btn-subtle"
            style={{ borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)' }}
          >
            background
          </button>
          <button
            onClick={handleChangeDir}
            className="text-[10px] px-2.5 py-1 btn-subtle"
            style={{ borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)' }}
          >
            change dir
          </button>
        </div>
      </div>

      {/* Tab bar — browser-style */}
      <div className="shrink-0 flex items-center gap-0.5 px-2" style={{
        height: 32,
        background: 'hsl(var(--surface) / 0.3)',
        borderBottom: '1px solid hsl(var(--border) / 0.2)',
        WebkitAppRegion: 'no-drag' as any,
      }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-btn ${tab.id === activeTabId ? 'tab-btn-active' : ''}`}
            onClick={() => switchTab(tab.id)}
            title={tab.projectPath || tab.name}
          >
            <span className="tab-btn-name">{tab.name}</span>
            {tabs.length > 1 && (
              <span
                className="tab-btn-close"
                onClick={e => handleCloseTab(tab.id, e)}
              >
                ×
              </span>
            )}
          </button>
        ))}
        <button
          className="tab-btn-new"
          onClick={handleNewTab}
          title="New project tab"
        >
          +
        </button>
      </div>

      {/* Canvas fills remaining height */}
      <div className="flex-1 min-h-0 relative">
        <Canvas />
        <Toolbar />
      </div>
    </div>
  )
}
