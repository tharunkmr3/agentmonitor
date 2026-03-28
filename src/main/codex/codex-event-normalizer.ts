import type { NormalizedEvent } from '../../shared/types'

/**
 * Normalizes Codex `exec --json` JSONL events into the same NormalizedEvent
 * shape used by Claude Code, so the renderer can handle both identically.
 *
 * Actual Codex JSONL event types:
 *  - thread.started  { thread_id }
 *  - turn.started
 *  - item.started    { item: { id, type, command?, status } }
 *  - item.completed  { item: { id, type, text?, command?, exit_code?, status } }
 *  - turn.completed  { usage: { input_tokens, output_tokens, cached_input_tokens } }
 */
export function normalizeCodexEvent(raw: any): NormalizedEvent[] {
  if (!raw || !raw.type) return []

  switch (raw.type) {
    case 'thread.started':
      return [{
        type: 'session_init',
        sessionId: raw.thread_id || '',
        tools: [],
        model: 'codex',
        mcpServers: [],
        skills: [],
        version: 'codex',
      }]

    case 'item.started':
      return normalizeItemStarted(raw.item)

    case 'item.completed':
      return normalizeItemCompleted(raw.item)

    case 'turn.completed':
      return normalizeTurnCompleted(raw)

    case 'turn.started':
      // No-op, turn lifecycle handled by started/completed items
      return []

    default:
      return []
  }
}

function normalizeItemStarted(item: any): NormalizedEvent[] {
  if (!item) return []

  switch (item.type) {
    case 'command_execution': {
      const toolId = item.id || `cmd-${Date.now()}`
      const events: NormalizedEvent[] = [
        { type: 'tool_call', toolName: 'Bash', toolId, index: 0 },
      ]
      if (item.command) {
        events.push({ type: 'tool_call_update', toolId, partialInput: item.command })
      }
      return events
    }

    case 'file_change':
    case 'fileChange': {
      const toolId = item.id || `file-${Date.now()}`
      const kind = item.kind || 'update'
      const toolName = kind === 'add' ? 'Write' : 'Edit'
      const events: NormalizedEvent[] = [
        { type: 'tool_call', toolName, toolId, index: 0 },
      ]
      if (item.file_path || item.filename) {
        events.push({ type: 'tool_call_update', toolId, partialInput: item.file_path || item.filename })
      }
      return events
    }

    default:
      return []
  }
}

function normalizeItemCompleted(item: any): NormalizedEvent[] {
  if (!item) return []

  switch (item.type) {
    case 'agent_message':
    case 'agentMessage': {
      const text = item.text || item.content || ''
      if (!text) return []
      return [{ type: 'text_chunk', text }]
    }

    case 'command_execution': {
      const toolId = item.id || ''
      const events: NormalizedEvent[] = []
      // If this is a completed command that we may not have seen started
      // (edge case: both started+completed arrive), emit tool_call first
      if (item.command) {
        events.push({ type: 'tool_call', toolName: 'Bash', toolId, index: 0 })
        events.push({ type: 'tool_call_update', toolId, partialInput: item.command })
      }
      // Show output if any
      if (item.aggregated_output) {
        events.push({ type: 'tool_call_update', toolId, partialInput: '\n' + item.aggregated_output })
      }
      events.push({ type: 'tool_call_complete', index: 0 })
      return events
    }

    case 'file_change':
    case 'fileChange': {
      const toolId = item.id || ''
      const events: NormalizedEvent[] = []
      const kind = item.kind || 'update'
      const toolName = kind === 'add' ? 'Write' : 'Edit'
      if (item.file_path || item.filename) {
        events.push({ type: 'tool_call', toolName, toolId, index: 0 })
        events.push({ type: 'tool_call_update', toolId, partialInput: item.file_path || item.filename })
      }
      events.push({ type: 'tool_call_complete', index: 0 })
      return events
    }

    case 'mcp_tool_call':
    case 'mcpToolCall': {
      const toolId = item.id || `mcp-${Date.now()}`
      const toolName = item.tool_name || item.name || 'MCP'
      const events: NormalizedEvent[] = [
        { type: 'tool_call', toolName, toolId, index: 0 },
      ]
      if (item.arguments || item.input) {
        events.push({ type: 'tool_call_update', toolId, partialInput: JSON.stringify(item.arguments || item.input) })
      }
      events.push({ type: 'tool_call_complete', index: 0 })
      return events
    }

    default:
      return []
  }
}

function normalizeTurnCompleted(raw: any): NormalizedEvent[] {
  const usage = raw.usage || {}
  return [{
    type: 'task_complete',
    result: '',
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cached_input_tokens || 0,
    },
    sessionId: '',
  }]
}
