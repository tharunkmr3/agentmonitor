import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, nativeTheme, shell, session, nativeImage, clipboard } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { createInterface } from 'readline'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { ControlPlane } from './claude/control-plane'
import { CodexControlPlane } from './codex/codex-control-plane'
import { OrchestratorBridge, createOrchestratorScript } from './claude/orchestrator-mcp'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { getCliEnv } from './cli-env'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, EnrichedError } from '../shared/types'

function log(msg: string): void {
  _log('main', msg)
}

let mainWindow: BrowserWindow | null = null
const controlPlane = new ControlPlane(false)
const codexControlPlane = new CodexControlPlane()
const orchestratorBridge = new OrchestratorBridge()

// ─── Orchestrator MCP setup ───
let orchestratorMcpConfigPath: string | null = null

async function setupOrchestrator(): Promise<void> {
  try {
    const port = await orchestratorBridge.start({
      createAgent: async (title, prompt) => {
        // Ask the renderer to create a node and optionally auto-send a prompt
        return new Promise((resolve) => {
          const responseChannel = `orchestrator:create-agent-response-${Date.now()}${Math.random().toString(36).slice(2, 10)}`
          ipcMain.once(responseChannel, (_event, result) => resolve(result))
          broadcast('orchestrator:create-agent', { title, prompt, responseChannel })
        })
      },
      closeAgent: async (nodeId) => {
        return new Promise((resolve) => {
          const responseChannel = `orchestrator:close-agent-response-${Date.now()}${Math.random().toString(36).slice(2, 10)}`
          ipcMain.once(responseChannel, (_event, result) => resolve(result))
          broadcast('orchestrator:close-agent', { nodeId, responseChannel })
        })
      },
      listAgents: () => {
        // Synchronous — we need to request from renderer and wait.
        // Use sendSync pattern via a stored snapshot that renderer pushes.
        return orchestratorAgentSnapshot
      },
      sendMessage: async (nodeId, prompt) => {
        return new Promise((resolve) => {
          const responseChannel = `orchestrator:send-message-response-${Date.now()}${Math.random().toString(36).slice(2, 10)}`
          ipcMain.once(responseChannel, (_event, result) => resolve(result))
          broadcast('orchestrator:send-message', { nodeId, prompt, responseChannel })
        })
      },
      getAgentMessages: (nodeId, lastN) => {
        const snapshot = orchestratorAgentSnapshot.find(a => a.id === nodeId)
        if (!snapshot) return []
        // Messages are pushed with the snapshot
        return (orchestratorMessagesSnapshot[nodeId] || []).slice(-(lastN || 10))
      },
    })

    // Write MCP server script to temp file
    const mcpDir = join(tmpdir(), 'clui-orchestrator')
    mkdirSync(mcpDir, { recursive: true })

    const scriptPath = join(mcpDir, 'mcp-server.js')
    writeFileSync(scriptPath, createOrchestratorScript(port, orchestratorBridge.getSecret()))
    chmodSync(scriptPath, 0o755)

    // Write MCP config JSON
    const configPath = join(mcpDir, 'mcp-config.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'canvas-orchestrator': {
          command: 'node',
          args: [scriptPath],
        },
      },
    }))

    orchestratorMcpConfigPath = configPath
    log(`Orchestrator MCP ready: config=${configPath}`)
  } catch (err) {
    log(`Failed to start orchestrator: ${(err as Error).message}`)
  }
}

// Agent snapshot — updated by renderer periodically
let orchestratorAgentSnapshot: Array<{ id: string; title: string; status: string; messageCount: number }> = []
let orchestratorMessagesSnapshot: Record<string, Array<{ role: string; content: string }>> = {}

ipcMain.on('orchestrator:agent-snapshot', (_event, snapshot, messages) => {
  orchestratorAgentSnapshot = snapshot
  orchestratorMessagesSnapshot = messages
})

// ─── Content Security Policy ───

function getContentSecurityPolicy(): string {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const connectSrc = isDev
    ? "connect-src 'self' ws://localhost:* http://localhost:* https://cdn.jsdelivr.net https://storage.googleapis.com;"
    : "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com;"
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    : "script-src 'self';"

  return [
    "default-src 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: file:",
    "font-src 'self' https://fonts.gstatic.com",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
}

function installContentSecurityPolicy(): void {
  const csp = getContentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

// ─── Wire ControlPlane events → renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// ─── Codex events → same renderer channels ───
codexControlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

codexControlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

codexControlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// ─── Window Creation (fullscreen canvas) ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: screenWidth, height: screenHeight } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  mainWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    x: dx,
    y: dy,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    transparent: false,
    resizable: true,
    fullscreenable: true,
    backgroundColor: '#0a0a0f',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.maximize()
    // DevTools: press Cmd+Shift+I to open manually
    // if (process.env.ELECTRON_RENDERER_URL) {
    //   mainWindow?.webContents.openDevTools({ mode: 'detach' })
    // }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── IPC: Canvas-specific ───

ipcMain.handle('canvas:get-background', async (_event, dirPath?: string) => {
  const targetDir = dirPath || process.cwd()

  // Security: restrict to paths under the user's home directory
  const resolved = require('path').resolve(targetDir)
  const home = homedir()
  if (!resolved.startsWith(home) || resolved.includes('\0') || resolved.includes('\n')) return null

  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp',
  }
  try {
    const files = readdirSync(targetDir)
    const imageFile = files.find(f => imageExts.some(ext => f.toLowerCase().endsWith(ext)))
    if (imageFile) {
      const filePath = join(targetDir, imageFile)
      const ext = imageFile.substring(imageFile.lastIndexOf('.')).toLowerCase()
      const mime = mimeMap[ext] || 'image/png'
      const data = readFileSync(filePath)
      return `data:${mime};base64,${data.toString('base64')}`
    }
  } catch {}
  return null
})

ipcMain.handle('canvas:select-background', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp',
  }
  const mime = mimeMap[ext] || 'image/png'
  const data = readFileSync(filePath)
  return `data:${mime};base64,${data.toString('base64')}`
})

ipcMain.handle('canvas:get-project-path', () => {
  return process.cwd()
})

// ─── IPC: Claude Code Handlers ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START')
  const { execSync } = require('child_process')

  let version = 'unknown'
  try {
    version = execSync('claude -v', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
  } catch {}

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  try {
    const raw = execSync('claude auth status', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
    auth = JSON.parse(raw)
  } catch {}

  return { version, auth, projectPath: process.cwd(), homePath: homedir() }
})

ipcMain.handle(IPC.CREATE_TAB, () => {
  const tabId = controlPlane.createTab()
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  if (!tabId || !requestId) throw new Error('Missing tabId or requestId')
  await controlPlane.submitPrompt(tabId, requestId, options)
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => controlPlane.cancel(requestId))
ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => controlPlane.cancelTab(tabId))

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => controlPlane.getHealth())
ipcMain.handle(IPC.TAB_HEALTH, () => controlPlane.getHealth())
ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => { controlPlane.closeTab(tabId) })

ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, mode: string) => {
  if (mode === 'ask' || mode === 'auto') controlPlane.setPermissionMode(mode)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

// ─── File attachments ───
ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return []
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'xml', 'html'] },
    ],
  })
  if (result.canceled || !result.filePaths.length) return []

  const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', json: 'application/json', xml: 'application/xml',
    html: 'text/html',
  }
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

  return result.filePaths.map(fp => {
    const ext = fp.split('.').pop()?.toLowerCase() || ''
    const mime = MIME[ext] || 'application/octet-stream'
    const data = readFileSync(fp).toString('base64')
    const name = fp.split('/').pop() || fp
    return { type: IMAGE_EXTS.has(ext) ? 'image' : 'document', mimeType: mime, data, name }
  })
})

// ─── Clipboard image paste ───
ipcMain.handle(IPC.PASTE_IMAGE, async () => {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  const png = img.toPNG()
  return { type: 'image', mimeType: 'image/png', data: png.toString('base64'), name: 'pasted-image.png' }
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    // Security: only allow http/https, block localhost and private networks
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
        host.startsWith('10.') || host.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host === '[::1]') {
      return false
    }
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async () => {
  return { error: 'Use Web Speech API', transcript: null }
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  try {
    const cwd = projectPath || process.cwd()
    if (/[\0\r\n]/.test(cwd) || !cwd.startsWith('/')) return []
    const encodedPath = cwd.replace(/\//g, '-')
    const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
    if (!existsSync(sessionsDir)) return []
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastTimestamp: string; size: number }> = []

    for (const file of files) {
      const fileSessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(fileSessionId)) continue
      const filePath = join(sessionsDir, file)
      const stat = statSync(filePath)
      if (stat.size < 100) continue

      const meta = { validated: false, slug: null as string | null, firstMessage: null as string | null, lastTimestamp: null as string | null }

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(filePath) })
        rl.on('line', (line: string) => {
          try {
            const obj = JSON.parse(line)
            if (!meta.validated && obj.type && obj.uuid && obj.timestamp) meta.validated = true
            if (obj.slug && !meta.slug) meta.slug = obj.slug
            if (obj.timestamp) meta.lastTimestamp = obj.timestamp
            if (obj.type === 'user' && !meta.firstMessage) {
              const content = obj.message?.content
              if (typeof content === 'string') meta.firstMessage = content.substring(0, 100)
              else if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text')
                meta.firstMessage = textPart?.text?.substring(0, 100) || null
              }
            }
          } catch {}
        })
        rl.on('close', () => resolve())
      })

      if (meta.validated) {
        sessions.push({
          sessionId: fileSessionId, slug: meta.slug, firstMessage: meta.firstMessage,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(), size: stat.size,
        })
      }
    }

    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    return sessions.slice(0, 20)
  } catch { return [] }
})

// ─── IPC: Codex Handlers (fully separate from Claude Code) ───

ipcMain.handle(IPC.CODEX_CHECK, () => {
  const installed = codexControlPlane.isInstalled()
  const version = installed ? codexControlPlane.getVersion() : null
  return { installed, version }
})

ipcMain.handle(IPC.CODEX_CREATE_TAB, () => {
  const tabId = codexControlPlane.createTab()
  return { tabId }
})

ipcMain.handle(IPC.CODEX_PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: { prompt: string; projectPath: string; model?: string } }) => {
  log(`IPC CODEX PROMPT: tab=${tabId} req=${requestId}`)
  if (!tabId || !requestId) throw new Error('Missing tabId or requestId')
  await codexControlPlane.submitPrompt(tabId, requestId, options)
})

ipcMain.handle(IPC.CODEX_STOP_TAB, (_event, tabId: string) => codexControlPlane.cancelTab(tabId))
ipcMain.handle(IPC.CODEX_CLOSE_TAB, (_event, tabId: string) => { codexControlPlane.closeTab(tabId) })

// Window management stubs
ipcMain.on(IPC.RESIZE_HEIGHT, () => {})
ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {})
ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {})
ipcMain.on(IPC.HIDE_WINDOW, () => { mainWindow?.hide() })
ipcMain.handle(IPC.IS_VISIBLE, () => mainWindow?.isVisible() ?? false)
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, () => {})
ipcMain.on(IPC.START_WINDOW_DRAG, () => {})
ipcMain.on(IPC.RESET_WINDOW_POSITION, () => {})
ipcMain.handle(IPC.GET_THEME, () => ({ isDark: nativeTheme.shouldUseDarkColors }))

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  installContentSecurityPolicy()
  createWindow()

  // Start orchestrator MCP bridge
  await setupOrchestrator()
  if (orchestratorMcpConfigPath) {
    controlPlane.setMcpConfigPath(orchestratorMcpConfigPath)
  }

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else { mainWindow?.show(); mainWindow?.focus() }
  })
})

app.on('window-all-closed', () => {
  orchestratorBridge.stop()
  controlPlane.shutdown()
  codexControlPlane.shutdown()
  flushLogs()
  app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
