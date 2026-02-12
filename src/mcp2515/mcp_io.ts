/**
 * Standalone bridge: connects to QEMU's SPI chardev TCP port
 * and runs the MCP2515 decoder/encoder on the byte stream.
 *
 * Usage:
 *   npx tsx src/mcp2515/mcp_io.ts [host] [port]
 *
 * Start QEMU first (make test in the a0 directory), then run this.
 */
import * as net from 'net';
import { McpDecoder } from './mcp_decoder';

const host = process.argv[2] || 'localhost';
const port = parseInt(process.argv[3] || '5555', 10);

const decoder = new McpDecoder();

console.log(`[MCP IO] Connecting to QEMU SPI at ${host}:${port}...`);

const socket = net.createConnection({ host, port }, () => {
    socket.setNoDelay(true);
    console.log(`[MCP IO] Connected.`);
});

socket.on('data', (data: Buffer) => {
    const rxBuf = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        const result = decoder.decode(data[i]);
        rxBuf[i] = result.rx;
    }
    socket.write(rxBuf);
});

socket.on('close', () => {
    console.log('[MCP IO] Disconnected.');
    process.exit(0);
});

socket.on('error', (err: Error) => {
    console.error(`[MCP IO] ${err.message}`);
    process.exit(1);
});
