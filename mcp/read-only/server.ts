import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createProductionToolService, registerProductionTools } from '@/mcp/production/tools';
import { createReadOnlyToolService, registerReadOnlyTools } from './tools';

export function createReadOnlyMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'explainer-local-mcp',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  registerReadOnlyTools(server, createReadOnlyToolService());
  registerProductionTools(server, createProductionToolService());
  return server;
}

async function main(): Promise<void> {
  const server = createReadOnlyMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Failed to start local MCP server: ${message}`);
  process.exit(1);
});
