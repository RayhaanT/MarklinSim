/**
 * SPI bridge: connects to QEMU's SPI chardev TCP port,
 * decodes MCP2515 traffic, and dispatches CS3 CAN commands
 * to the MarklinSim controller.
 *
 * Can be used standalone (just ACKs, no sim) or integrated
 * into the main app with a MarklinController.
 *
 * Standalone usage:
 *   npx tsx src/mcp2515/mcp_io.ts [host] [port]
 */
import * as net from 'net';
import { McpDecoder, CanFrame } from './mcp_decoder';
import { Cs3Handler } from './cs3_handler';
import { MarklinController } from '../marklin/marklin_controller';

export class McpIO {
    private socket: net.Socket | null = null;
    private readonly decoder: McpDecoder;
    private readonly handler: Cs3Handler;

    constructor(controller?: MarklinController) {
        this.decoder = new McpDecoder();
        this.handler = new Cs3Handler();

        if (controller) {
            this.handler.setController(controller);
        }

        this.decoder.setTxFrameCallback((frame: CanFrame) => {
            const ackFrames = this.handler.handleTxFrame(frame);
            if (ackFrames.length > 0) {
                this.decoder.queueRxFrames(ackFrames);
            }
        });
    }

    public connect(host: string = 'localhost', port: number = 5555): void {
        console.log(`[MCP IO] Connecting to QEMU SPI at ${host}:${port}...`);

        this.socket = net.createConnection({ host, port }, () => {
            this.socket!.setNoDelay(true);
            console.log(`[MCP IO] Connected.`);
        });

        this.socket.on('data', (data: Buffer) => {
            const rxBuf = Buffer.alloc(data.length);
            for (let i = 0; i < data.length; i++) {
                const result = this.decoder.decode(data[i]);
                rxBuf[i] = result.rx;
            }
            this.socket!.write(rxBuf);
        });

        this.socket.on('close', () => {
            console.log('[MCP IO] Disconnected.');
        });

        this.socket.on('error', (err: Error) => {
            console.error(`[MCP IO] ${err.message}`);
        });
    }
}

// Standalone mode
if (require.main === module) {
    const host = process.argv[2] || 'localhost';
    const port = parseInt(process.argv[3] || '5555', 10);
    const io = new McpIO();
    io.connect(host, port);
}
