// Narrow stdio MCP transport. The coordinator owns Chromium; agents never get eval or files.
import { createInterface } from 'node:readline';
const endpoint = process.env.BRAINROT_AUDIT_ENDPOINT;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}$/.test(endpoint)) process.exit(2);
const tools = [
  { name: 'snapshot', description: 'Read the visible page accessibility tree.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'click', description: 'Click one visible button or link by its exact accessible name from snapshot.', inputSchema: { type: 'object', properties: { role: { enum: ['button', 'link'] }, name: { type: 'string', maxLength: 150 } }, required: ['role', 'name'], additionalProperties: false } },
  { name: 'press', description: 'Press a keyboard navigation key on the page.', inputSchema: { type: 'object', properties: { key: { enum: ['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] } }, required: ['key'], additionalProperties: false } },
  { name: 'wait', description: 'Wait one second for visible content, then read the page.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!('id' in message)) continue;
  let result;
  try {
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'brainrot-disposable-audit', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(message.params), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Browser tool unavailable');
      result = { content: [{ type: 'text', text: await response.text() }] };
    } else throw Error('Unsupported method');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Audit browser operation unavailable' } }) + '\n');
  }
}
