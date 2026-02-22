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
    private readonly controller: MarklinController | null = null;
    private sensorStates: Map<number, boolean> = new Map();
    private sensorPollInterval: ReturnType<typeof setInterval> | null = null;

    constructor(controller?: MarklinController) {
        this.decoder = new McpDecoder();
        this.handler = new Cs3Handler();

        if (controller) {
            this.handler.setController(controller);
            this.controller = controller;
        }

        // INT pin updates automatically when CANINTF changes in the decoder.
        // No manual trigger calls needed.
        this.decoder.setIntPinChangeCallback((asserted: boolean) => {
            this.setGpioIntPin(asserted);
        });

        this.decoder.setTxFrameCallback((frame: CanFrame) => {
            const ackFrames = this.handler.handleTxFrame(frame);
            if (ackFrames.length > 0) {
                this.decoder.queueRxFrames(ackFrames);
            }
        });
    }

    public connect(host: string = 'localhost', port: number = 5555, gpioPort: number = 5556): void {
        console.log(`[MCP IO] Connecting to QEMU SPI at ${host}:${port}...`);

        this.socket = net.createConnection({ host, port }, () => {
            this.socket!.setNoDelay(true);
            console.log(`[MCP IO] Connected to SPI.`);

            // Connect to GPIO AFTER SPI is established.
            // QEMU blocks on SPI port (wait=on), so GPIO port isn't open until
            // the SPI connection unblocks QEMU.
            console.log(`[MCP IO] Connecting to QEMU GPIO at ${host}:${gpioPort}...`);
            this.gpioSocket = net.createConnection({ host, port: gpioPort }, () => {
                this.gpioSocket!.setNoDelay(true);
                console.log(`[MCP IO] Connected to GPIO.`);
                // Initialize INT pin to de-asserted (HIGH).
                // GPIO pin 17 defaults to LOW in QEMU, so we must set it HIGH
                // first, otherwise the first assert (LOW) won't be a level change.
                this.gpioSocket!.write(Buffer.from([17, 1]));
                this.startSensorPolling();
            });

            this.gpioSocket.on('close', () => {
                console.log('[MCP IO] GPIO disconnected. Exiting...');
                this.stopSensorPolling();
                process.exit(0);
            });

            this.gpioSocket.on('error', (err: Error) => {
                console.error(`[MCP IO] GPIO error: ${err.message}`);
            });
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
            this.stopSensorPolling();
            process.exit(0);
        });

        this.socket.on('error', (err: Error) => {
            console.error(`[MCP IO] SPI error: ${err.message}`);
        });
    }

    /**
     * Set the MCP2515 INT pin level on GPIO pin 17.
     * INT is active-low: asserted=true means pin LOW, asserted=false means pin HIGH.
     */
    private setGpioIntPin(asserted: boolean): void {
        if (!this.gpioSocket) {
            return;
        }
        // Protocol: [pin_number, level]
        // Active-low: asserted -> pin LOW (0), de-asserted -> pin HIGH (1)
        const level = asserted ? 0 : 1;
        console.log(`[MCP IO] INT pin ${asserted ? 'asserted (LOW)' : 'de-asserted (HIGH)'}`);
        this.gpioSocket.write(Buffer.from([17, level]));
    }

    /**
     * Start polling sensors for state changes.
     * Checks sensor states every 100ms and sends CAN frames for any changes.
     */
    private startSensorPolling(): void {
        if (!this.controller || this.sensorPollInterval) {
            return;
        }

        console.log('[MCP IO] Starting sensor polling');

        // Poll every 100ms
        this.sensorPollInterval = setInterval(() => {
            this.pollSensors();
        }, 100);
    }

    /**
     * Stop polling sensors and clean up.
     */
    private stopSensorPolling(): void {
        if (this.sensorPollInterval) {
            clearInterval(this.sensorPollInterval);
            this.sensorPollInterval = null;
        }
    }

    /**
     * Check all trains for sensor triggers and send events for state changes.
     */
    private pollSensors(): void {
        if (!this.controller) {
            return;
        }

        // Build current sensor states
        const currentStates = new Map<number, boolean>();
        for (const train of this.controller.getTrains()) {
            for (const sensor of train.getTriggeredSensors()) {
                currentStates.set(sensor.id, true);
            }
        }

        // Detect changes
        const events: CanFrame[] = [];

        // Check for newly triggered sensors
        for (const [sensorId, newState] of currentStates) {
            const oldState = this.sensorStates.get(sensorId) ?? false;
            if (newState !== oldState) {
                console.log(`[MCP IO] Sensor ${sensorId}: ${oldState ? 'triggered' : 'idle'} -> ${newState ? 'triggered' : 'idle'}`);
                events.push(this.handler.makeSensorEvent(sensorId, oldState, newState));
            }
        }

        // Check for newly released sensors
        for (const [sensorId, oldState] of this.sensorStates) {
            if (!currentStates.has(sensorId)) {
                // Sensor was triggered, now released
                console.log(`[MCP IO] Sensor ${sensorId}: triggered -> idle`);
                events.push(this.handler.makeSensorEvent(sensorId, oldState, false));
            }
        }

        // Update tracked state
        this.sensorStates = currentStates;

        // Queue sensor events — INT pin updates automatically via decoder callback
        if (events.length > 0) {
            this.decoder.queueRxFrames(events);
        }
    }
}

// Standalone mode
if (require.main === module) {
    const host = process.argv[2] || 'localhost';
    const port = parseInt(process.argv[3] || '5555', 10);
    const io = new McpIO();
    io.connect(host, port);
}
