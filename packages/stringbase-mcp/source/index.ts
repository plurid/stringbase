import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Workspace, createAgentTools } from '@plurid/stringbase/agent';

export interface ServerOptions { readonly directory: string; readonly actor: string; readonly runIds?: readonly string[] }

export async function createStringbaseServer(options: ServerOptions) {
    const workspace = await Workspace.open({ directory: options.directory });
    try {
        const agent = createAgentTools(workspace, { actor: options.actor, ...(options.runIds ? { runIds: options.runIds } : {}) });
        const server = new Server({ name: 'stringbase', version: '0.0.0-1' }, { capabilities: { tools: {} },
            instructions: 'Use describe, fork, query, plan, apply, diff, and submit. Your changes stay isolated until a trusted host approves and promotes them. Stored scalar values are strings.' });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: agent.tools }));
        server.setRequestHandler(CallToolRequestSchema, async request => {
            const response = await agent.call(request.params.name, request.params.arguments ?? {});
            return { ...response, content: [...response.content] };
        });
        server.onclose = () => { void workspace.close().catch(error => process.stderr.write(String(error) + '\n')); };
        return { server, workspace, async close() { await server.close(); await workspace.close(); } };
    } catch (cause) { await workspace.close(); throw cause; }
}
