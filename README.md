# Agent Monitor

**A grid-based desktop dashboard for running multiple Claude Code agents in parallel.**

Run up to 20 AI coding agents on one screen, organized in a 5x4 grid. Each agent is a full Claude Code session with markdown rendering, tool calls, and permission handling. Agents can orchestrate each other through a built-in MCP server.

![Agent Monitor Screenshot](docs/screenshot.png)
<!-- Replace with an actual screenshot -->

## Features

- **Multi-agent grid** -- Run up to 20 Claude Code agents (5 columns x 4 rows) simultaneously on a single canvas
- **Project tabs** -- Browser-style tabs scope agents to different project directories; switch context without losing state
- **Agent orchestration via MCP** -- Any agent can spawn, close, message, and monitor other agents using built-in MCP tools (`create_agent`, `close_agent`, `send_message`, `list_agents`, `read_agent_messages`)
- **Full chat experience** -- Markdown rendering, syntax-highlighted code blocks with copy button, streaming responses, tool call display, and permission request UI
- **Session persistence** -- Nodes, chats, layout, and project paths are saved across app restarts. Claude sessions resume via `sessionId`
- **Closed node history** -- Recently closed agents can be restored from the toolbar history menu
- **Image and document attachments** -- Attach files via the paperclip button, paste images from clipboard, or drag and drop
- **Custom backgrounds** -- Set any image as the canvas background
- **Drag-to-reorder** -- Rearrange agent nodes by dragging headers; resize columns and rows with dividers
- **Dual engine support** -- Run both Claude Code and Codex agents side by side

## Quick Start

### Prerequisites

- Node.js 18+
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)

### Install and Run

```bash
# Clone the repository
git clone https://github.com/tharunkmr3/agentmonitor.git
cd agentmonitor

# Install dependencies
npm install

# Build the app
npm run build

# Launch
npx electron .
```

### Development

```bash
# Start in dev mode with hot reload
npm run dev
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Electron Main                   │
│                                                  │
│  ControlPlane                                    │
│  ├── Tab Registry (project paths)                │
│  ├── Process Manager (spawn/kill Claude CLIs)    │
│  ├── Request Queue (serialized per agent)        │
│  └── Health Monitor                              │
│                                                  │
│  MCP Orchestrator                                │
│  ├── Local HTTP Bridge                           │
│  └── stdio MCP script (--mcp-config per agent)   │
├─────────────────────────────────────────────────┤
│                Electron Renderer                 │
│                                                  │
│  React + Zustand                                 │
│  ├── Canvas (grid layout, drag/resize)           │
│  ├── AgentNode (chat UI, tool calls, perms)      │
│  ├── Toolbar (tabs, history, backgrounds)        │
│  └── MessageComposer (attachments, submit)       │
└─────────────────────────────────────────────────┘
```

Each agent runs as a separate `claude` process using `--input-format stream-json`. The ControlPlane manages process lifecycles, routes messages, and handles health checks. The MCP orchestrator exposes agent management tools so any Claude session can coordinate with the others.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron |
| Build tooling | electron-vite |
| UI framework | React, TypeScript |
| State management | Zustand |
| Terminal bridge | node-pty |
| Markdown | react-markdown, remark-gfm |
| Code highlighting | react-syntax-highlighter |
| Animations | Framer Motion |

## License

MIT
