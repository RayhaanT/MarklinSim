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
    private gpioSocket: net.Socket | null = null;
    private readonly decoder: McpDecoder;
    private readonly handler: Cs3Handler;

    constructor(controller?: MarklinController) {
        this.decoder = new McpDecoder();
        this.handler = new Cs3Handler();

        if (controller) {
            this.handler.setController(controller);
        }

        this.decoder.setTxFrameCallback((frame: CanFrame) => {
            // TX buffer becomes empty - trigger interrupt if TX0IE is enabled
            if (this.decoder.shouldTriggerInterrupt()) {
                this.triggerGpioInterrupt();
            }

            const ackFrames = this.handler.handleTxFrame(frame);
            if (ackFrames.length > 0) {
                this.decoder.queueRxFrames(ackFrames);
                // RX frames queued - trigger interrupt if RX0IE is enabled
                if (this.decoder.shouldTriggerInterrupt()) {
                    this.triggerGpioInterrupt();
                }
            }
        });
    }

    public connect(host: string = 'localhost', port: number = 5555, gpioPort: number = 5556): void {
        console.log(`[MCP IO] Connecting to QEMU SPI at ${host}:${port}...`);

        this.socket = net.createConnection({ host, port }, () => {
            this.socket!.setNoDelay(true);
            console.log(`[MCP IO] Connected to SPI.`);
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
            console.log('[MCP IO] SPI disconnected. Exiting...');
            process.exit(0);
        });

        this.socket.on('error', (err: Error) => {
            console.error(`[MCP IO] SPI error: ${err.message}`);
        });

        // Connect to GPIO chardev for triggering interrupts
        console.log(`[MCP IO] Connecting to QEMU GPIO at ${host}:${gpioPort}...`);
        this.gpioSocket = net.createConnection({ host, port: gpioPort }, () => {
            this.gpioSocket!.setNoDelay(true);
            console.log(`[MCP IO] Connected to GPIO.`);
        });

        this.gpioSocket.on('close', () => {
            console.log('[MCP IO] GPIO disconnected. Exiting...');
            process.exit(0);
        });

        this.gpioSocket.on('error', (err: Error) => {
            console.error(`[MCP IO] GPIO error: ${err.message}`);
        });
    }

    /**
     * Trigger a GPIO interrupt on pin 17.
     * Sends a rising edge (pin 17 = 1), then falling edge (pin 17 = 0)
     * to trigger the MCP2515 interrupt handler in the kernel.
     */
    private triggerGpioInterrupt(): void {
        if (!this.gpioSocket) {
            return;
        }
        // Protocol: [pin_number, level]
        // Rising edge on pin 17
        console.log('[MCP IO] Interrupting on GPIO pin');
        this.gpioSocket.write(Buffer.from([17, 1]));
        // Falling edge on pin 17 (clear interrupt line)
        this.gpioSocket.write(Buffer.from([17, 0]));
    }
}

// Standalone mode
if (require.main === module) {
    const host = process.argv[2] || 'localhost';
    const port = parseInt(process.argv[3] || '5555', 10);
    const io = new McpIO();
    io.connect(host, port);
}
