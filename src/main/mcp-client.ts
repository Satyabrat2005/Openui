/**
 * mcp-client.ts — Model Context Protocol (MCP) client for the OpenUI main process.
 *
 * Supports two transport types:
 *   stdio — spawns a local MCP server process and communicates over stdin/stdout.
 *   sse   — connects to a remote SSE-based MCP server over HTTP.
 *
 * Exports consumed by agent.ts and index.ts:
 *   connectMcpServer(config)   — establish a connection and cache the client.
 *   getMcpToolSchemas()        — ToolSchema[] for every tool on all connected servers.
 *   callMcpTool(name, args)    — call a named MCP tool and return a uniform ToolResult.
 *   disconnectAll()            — close all connections (call on app quit).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { ToolResult, ToolSchema } from './tools'

export interface McpServerConfig {
  /** Human-readable identifier used to key the connection. */
  name: string
  type: 'stdio' | 'sse'
  // stdio fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse fields
  url?: string
}

interface ConnectedServer {
  client: Client
  schemas: ToolSchema[]
}

// Active clients keyed by server name
const servers = new Map<string, ConnectedServer>()

// Tool-name → server-name reverse index for fast dispatch
const toolOwner = new Map<string, string>()

/**
 * Convert an MCP tool definition to the ToolSchema format used by agent.ts.
 * MCP inputSchema is a JSON Schema object; we flatten it to the simplified
 * property-map shape that OpenUI's agent loop expects.
 */
function toToolSchema(tool: {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}): ToolSchema {
  const props: Record<string, { type: string; description: string; enum?: string[] }> = {}
  const inputSchema = tool.inputSchema ?? {}
  const rawProps = (inputSchema.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: string[] }
  >
  for (const [key, spec] of Object.entries(rawProps)) {
    props[key] = {
      type: typeof spec.type === 'string' ? spec.type : 'string',
      description: typeof spec.description === 'string' ? spec.description : '',
      ...(Array.isArray(spec.enum) ? { enum: spec.enum as string[] } : {})
    }
  }
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: {
      type: 'object',
      properties: props,
      required: Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : []
    }
  }
}

/**
 * Connect to an MCP server described by `config`.
 * If a server with the same name is already connected it is replaced.
 */
export async function connectMcpServer(
  config: McpServerConfig
): Promise<{ ok: boolean; error?: string; toolCount?: number }> {
  if (typeof config !== 'object' || config === null || !config.type) {
    return { ok: false, error: 'Invalid MCP server config: must include "type".' }
  }

  const serverName = config.name || `mcp-server-${servers.size}`

  // Tear down any existing connection with the same name.
  const existing = servers.get(serverName)
  if (existing) {
    try {
      await existing.client.close()
    } catch {
      // ignore cleanup errors
    }
    for (const [toolName, owner] of toolOwner.entries()) {
      if (owner === serverName) toolOwner.delete(toolName)
    }
    servers.delete(serverName)
  }

  let transport: StdioClientTransport | SSEClientTransport

  try {
    if (config.type === 'stdio') {
      if (!config.command) {
        return { ok: false, error: 'stdio MCP server requires a "command" field.' }
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env
      })
    } else if (config.type === 'sse') {
      if (!config.url) {
        return { ok: false, error: 'sse MCP server requires a "url" field.' }
      }
      transport = new SSEClientTransport(new URL(config.url))
    } else {
      return {
        ok: false,
        error: `Unknown MCP transport type "${String((config as McpServerConfig).type)}". Use "stdio" or "sse".`
      }
    }

    const client = new Client({ name: 'openui', version: '1.0.0' })
    await client.connect(transport)

    const toolsResult = await client.listTools()
    const schemas = toolsResult.tools.map(toToolSchema)

    servers.set(serverName, { client, schemas })
    for (const schema of schemas) {
      toolOwner.set(schema.name, serverName)
    }

    console.log(`[mcp] Connected to "${serverName}" — ${schemas.length} tool(s) available.`)
    return { ok: true, toolCount: schemas.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Return ToolSchema[] for every tool exposed by all connected MCP servers. */
export function getMcpToolSchemas(): ToolSchema[] {
  const all: ToolSchema[] = []
  for (const { schemas } of servers.values()) {
    all.push(...schemas)
  }
  return all
}

/**
 * Call an MCP tool by name. Returns a uniform ToolResult so the agent loop
 * can treat MCP calls identically to built-in tool calls.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const serverName = toolOwner.get(toolName)
  if (!serverName) {
    return { ok: false, error: `No connected MCP server exposes a tool named "${toolName}".` }
  }
  const server = servers.get(serverName)
  if (!server) {
    return { ok: false, error: `MCP server "${serverName}" is no longer connected.` }
  }

  try {
    const result = await server.client.callTool({ name: toolName, arguments: args })
    const content = result.content
    const text = Array.isArray(content)
      ? content
          .map((c) => {
            if (typeof c === 'object' && c !== null && 'text' in c) return String(c.text)
            return ''
          })
          .filter(Boolean)
          .join('\n')
      : String(content ?? '')

    return result.isError === true
      ? { ok: false, error: text || 'MCP tool returned an error.' }
      : { ok: true, output: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Close all active MCP connections. Call on app quit. */
export function disconnectAll(): void {
  for (const [name, { client }] of servers.entries()) {
    client.close().catch(() => {})
    servers.delete(name)
  }
  toolOwner.clear()
  console.log('[mcp] All connections closed.')
}
