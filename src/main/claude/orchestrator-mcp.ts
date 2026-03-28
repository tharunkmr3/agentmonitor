/**
 * Orchestrator MCP Server
 *
 * Runs as a stdio MCP server that each Claude process connects to.
 * Exposes tools for creating/closing/messaging other agent nodes on the canvas.
 *
 * Architecture:
 *   Claude process → (stdio MCP) → this server → IPC callback → main process → renderer store
 */

import { createServer } from 'net'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('OrchestratorMCP', msg)
}

// ─── Types ───

interface AgentInfo {
  id: string
  title: string
  status: string
  messageCount: number
}

export interface OrchestratorCallbacks {
  createAgent: (title: string, prompt?: string) => Promise<{ nodeId: string; title: string }>
  closeAgent: (nodeId: string) => Promise<boolean>
  listAgents: (callerNodeId?: string) => AgentInfo[]
  sendMessage: (nodeId: string, prompt: string) => Promise<boolean>
  getAgentMessages: (nodeId: string, lastN?: number) => Array<{ role: string; content: string }>
}

// ─── MCP Protocol helpers ───

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: any
  error?: { code: number; message: string; data?: any }
}

const TOOLS = [
  {
    name: 'create_agent',
    description: 'Create a new agent node on the canvas. Optionally send it an initial prompt to start working on immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Display title for the new agent node' },
        prompt: { type: 'string', description: 'Initial prompt to send to the new agent. If omitted, the agent is created idle.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'close_agent',
    description: 'Close and remove an agent node from the canvas. Stops any running work.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'The ID of the agent node to close' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all agent nodes currently on the canvas with their status and message count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'send_message',
    description: 'Send a prompt/message to another agent node on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'The ID of the target agent node' },
        prompt: { type: 'string', description: 'The message/prompt to send to the agent' },
      },
      required: ['node_id', 'prompt'],
    },
  },
  {
    name: 'read_agent_messages',
    description: 'Read recent messages from another agent node to check its progress or output.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'The ID of the agent node to read from' },
        last_n: { type: 'number', description: 'Number of recent messages to return (default: 10)' },
      },
      required: ['node_id'],
    },
  },
]

// ─── Stdio MCP Server ───

/**
 * Creates a stdio-based MCP server script content.
 * This is written to a temp file and spawned as a subprocess by Claude.
 */
export function createOrchestratorScript(httpPort: number, secret: string): string {
  // The MCP server connects to our HTTP bridge to execute callbacks
  return `#!/usr/bin/env node
'use strict';

const http = require('http');
const readline = require('readline');

const BRIDGE_PORT = ${httpPort};
const BRIDGE_SECRET = '${secret}';

function callBridge(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: '/rpc/' + BRIDGE_SECRET,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const TOOLS = ${JSON.stringify(TOOLS)};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'canvas-orchestrator', version: '1.0.0' },
      });
    } else if (msg.method === 'notifications/initialized') {
      // No response needed for notifications
    } else if (msg.method === 'tools/list') {
      respond(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      try {
        const result = await callBridge(name, args || {});
        respond(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        respond(msg.id, {
          content: [{ type: 'text', text: 'Error: ' + (err.message || String(err)) }],
          isError: true,
        });
      }
    } else if (msg.method === 'ping') {
      respond(msg.id, {});
    } else {
      respondError(msg.id, -32601, 'Method not found: ' + msg.method);
    }
  } catch (e) {
    // Ignore parse errors
  }
});

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\\n');
}
`;
}

// ─── HTTP Bridge Server ───
// Receives RPC calls from the MCP script and routes them to callbacks

export class OrchestratorBridge {
  private server: ReturnType<typeof createServer> | null = null
  private port: number = 0
  private secret: string = ''
  private callbacks: OrchestratorCallbacks | null = null

  getSecret(): string { return this.secret }

  async start(callbacks: OrchestratorCallbacks): Promise<number> {
    this.callbacks = callbacks
    // Per-launch secret — MCP scripts must include this in requests
    this.secret = require('crypto').randomUUID()

    return new Promise((resolve, reject) => {
      const { createServer: createHttpServer } = require('http')
      this.server = createHttpServer(async (req: any, res: any) => {
        // Security: require secret in URL path
        if (req.method !== 'POST' || req.url !== `/rpc/${this.secret}`) {
          res.writeHead(404)
          res.end()
          return
        }

        let body = ''
        req.on('data', (c: string) => body += c)
        req.on('end', async () => {
          try {
            const { method, params } = JSON.parse(body)
            const result = await this.handleCall(method, params)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      })

      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server as any).address().port
        log(`Orchestrator bridge listening on port ${this.port}`)
        resolve(this.port)
      })

      this.server!.on('error', reject)
    })
  }

  getPort(): number {
    return this.port
  }

  private async handleCall(method: string, params: any): Promise<any> {
    if (!this.callbacks) throw new Error('No callbacks registered')

    log(`RPC call: ${method} ${JSON.stringify(params).substring(0, 200)}`)

    switch (method) {
      case 'create_agent': {
        const result = await this.callbacks.createAgent(params.title, params.prompt)
        return { success: true, node_id: result.nodeId, title: result.title }
      }
      case 'close_agent': {
        const ok = await this.callbacks.closeAgent(params.node_id)
        return { success: ok }
      }
      case 'list_agents': {
        const agents = this.callbacks.listAgents()
        return { agents }
      }
      case 'send_message': {
        const ok = await this.callbacks.sendMessage(params.node_id, params.prompt)
        return { success: ok }
      }
      case 'read_agent_messages': {
        const messages = this.callbacks.getAgentMessages(params.node_id, params.last_n || 10)
        return { messages }
      }
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      log('Orchestrator bridge stopped')
    }
  }
}
