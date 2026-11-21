#!/usr/bin/env node
// Fake continentept-mcp for tests: speaks MCP over stdio, records every tool call it receives
// (JSON lines in FAKE_MCP_LOG) and never talks to Continente.
// FAKE_MCP_MODE: "hang" (never answers a call) | "ok" (default) | "not_authenticated" | "sign_in" (continentept-mcp 0.15.0's robot-check
// error, with its terminal command and session.json text) | "crash_once" (exits on the first call
// of each process until FAKE_MCP_STATE exists).
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = ['search_products', 'get_product', 'get_product_labels', 'choose_products', 'list_favorites', 'get_cart',
  'preview_cart_changes', 'add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart', 'list_orders',
  'get_order', 'list_frequently_bought_products', 'get_session_status'];
if (process.env.FAKE_EXTRA_TOOLS) TOOLS.push(...process.env.FAKE_EXTRA_TOOLS.split(','));
const mode = process.env.FAKE_MCP_MODE ?? 'ok';
// Whether this process got a password from its environment (never the value): 'unset', 'empty' or 'set'.
const password = () => (process.env.CONTINENTE_PASSWORD === undefined ? 'unset' : process.env.CONTINENTE_PASSWORD === '' ? 'empty' : 'set');
// Verbatim from continentept-mcp 0.15.0 (dist/mcp/shopping.js) for a robot check where no window can open.
const SIGN_IN_HELP = 'Sign-in needs you: Continente asks you to confirm you are not a robot, and no sign-in window can open where this server '
  + 'runs (for example in Docker or on a server without a screen). On a computer with a screen, run '
  + '`npx -y continentept-mcp login --show-browser` with the same account, tick "Não sou um robô" and press "Avançar". If that is '
  + 'another computer, copy session.json from its data directory (~/.continentept-mcp) to this server\'s data directory '
  + '(CONTINENTE_DATA_DIR). Then try again. Searching and product details work without signing in.';
const SIGN_IN = { credentials: 'configured', action: 'confirm_not_a_robot', signInWindow: 'not_available',
  settings: { environment: ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'], claudeDesktopExtension: ['email', 'password'] },
  command: 'npx -y continentept-mcp login --show-browser', guide: 'https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md',
  publicTools: ['search_products', 'get_product'] };
const server = new Server({ name: 'fake-continentept-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ name, args, pid: process.pid, password: password(), env: Object.keys(process.env).sort() }) + '\n');
  if (mode === 'hang') return new Promise(() => undefined);
  if (mode === 'crash_once' && !existsSync(process.env.FAKE_MCP_STATE)) {
    writeFileSync(process.env.FAKE_MCP_STATE, 'crashed');
    process.exit(1);
  }
  let result;
  if (mode === 'sign_in' && name !== 'search_products') {
    const mutation = name.includes('cart_item') || name === 'clear_cart' ? { mutation: { outcome: 'not_applied' } } : {};
    result = { status: 'error', error: { code: 'not_authenticated', message: SIGN_IN_HELP, retryable: false }, ...mutation, signIn: SIGN_IN };
    const note = mutation.mutation ? '\nThe cart was not changed.' : '';
    return { content: [{ type: 'text', text: `Error (not_authenticated): ${SIGN_IN_HELP}${note}` }], structuredContent: { result }, isError: true };
  }
  if (mode === 'not_authenticated' && name !== 'search_products') {
    result = { status: 'error', error: { code: 'not_authenticated', message: 'sign in', retryable: false } };
  } else if (name === 'search_products') {
    result = { status: 'success', data: { products: [{ productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa' }] } };
  } else if (TOOLS.includes(name)) {
    result = { status: 'success', data: { tool: name, outcome: name.includes('cart_item') || name === 'clear_cart' ? 'confirmed' : undefined } };
  } else {
    result = { status: 'error', error: { code: 'invalid_input', message: 'unknown tool' } };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result }, isError: result.status === 'error' };
});

await server.connect(new StdioServerTransport());
