/**
 * Decodes and encodes MCP2515 SPI traffic.
 *
 * Processes the SPI byte stream one byte at a time, maintaining internal
 * register state. For each TX byte from the kernel, returns an RX response
 * byte (encoder) and optionally a decoded CAN frame (decoder).
 *
 * MCP2515 SPI instructions:
 *   0x02 (WRITE):       [instruction, register, data...]
 *   0x03 (READ):        [instruction, register, dummy...]
 *   0x05 (BIT_MODIFY):  [instruction, register, mask, data]
 *   0xA0 (READ_STATUS): [instruction, dummy]
 *
 * For READs, successive dummy bytes (non-instruction values) return
 * successive register values with auto-incrementing address.
 * For WRITEs, successive data bytes write to successive registers.
 */

export interface CanFrame {
    id: number;
    eid: number;
    dlc: number;
    data: number[];
}

export interface DecodeResult {
    rx: number;
    frame: CanFrame | null;
}

// MCP2515 SPI instructions
const INSTRUCTION_WRITE       = 0x02;
const INSTRUCTION_READ        = 0x03;
const INSTRUCTION_BIT_MODIFY  = 0x05;
const INSTRUCTION_READ_STATUS = 0xA0;

const INSTRUCTION_NAME: Record<number, string> = {
    [INSTRUCTION_WRITE]:       'WRITE',
    [INSTRUCTION_READ]:        'READ',
    [INSTRUCTION_BIT_MODIFY]:  'BIT_MODIFY',
    [INSTRUCTION_READ_STATUS]: 'READ_STATUS',
};

function hex(n: number): string { return '0x' + n.toString(16).padStart(2, '0'); }

// TX buffer 0 start register
const TXB0_SIDH = 0x31;

// RX buffer 0 start register
const RXB0_SIDH = 0x61;

// Registers used for READ_STATUS computation
const CANINTE  = 0x2B;
const CANINTF  = 0x2C;
const TXB0CTRL = 0x30;
const TXB1CTRL = 0x40;
const TXB2CTRL = 0x50;

// CANINTF/CANINTE bit definitions
const RX0IF = 0x01;  // RX Buffer 0 Full Interrupt Flag
const RX1IF = 0x02;  // RX Buffer 1 Full Interrupt Flag
const TX0IF = 0x04;  // TX Buffer 0 Empty Interrupt Flag
const TX1IF = 0x08;  // TX Buffer 1 Empty Interrupt Flag
const TX2IF = 0x10;  // TX Buffer 2 Empty Interrupt Flag

const enum State {
    IDLE,
    WRITE_ADDR,
    WRITE_DATA,
    TX_HEADER,
    TX_DATA,
    READ_ADDR,
    READ_DATA,
    BIT_MODIFY_ADDR,
    BIT_MODIFY_MASK,
    BIT_MODIFY_DATA,
    READ_STATUS_DUMMY,
}

export type TxFrameCallback = (frame: CanFrame) => void;
export type IntPinChangeCallback = (asserted: boolean) => void;

export class McpDecoder {
    private state: State = State.IDLE;
    private register: number = 0;
    private bitModifyMask: number = 0;
    private txHeader: number[] = [];
    private txData: number[] = [];
    private txDlc: number = 0;

    private readonly registers = new Uint8Array(256);
    private txFrameCallback: TxFrameCallback | null = null;
    private intPinChangeCallback: IntPinChangeCallback | null = null;
    private rxQueue: CanFrame[] = [];
    private intPinAsserted: boolean = false;

    public setTxFrameCallback(cb: TxFrameCallback): void {
        this.txFrameCallback = cb;
    }

    public setIntPinChangeCallback(cb: IntPinChangeCallback): void {
        this.intPinChangeCallback = cb;
    }

    /** Update INT pin state based on CANINTF & CANINTE. Calls callback on change. */
    private updateIntPin(): void {
        const shouldAssert = this.shouldTriggerInterrupt();
        if (shouldAssert !== this.intPinAsserted) {
            this.intPinAsserted = shouldAssert;
            if (this.intPinChangeCallback) {
                this.intPinChangeCallback(shouldAssert);
            }
        }
    }

    /** Queue CAN frames to be loaded into RXB0 as they become available. */
    public queueRxFrames(frames: CanFrame[]): void {
        for (const f of frames) {
            this.rxQueue.push(f);
        }
        this.tryLoadNextRxFrame();
    }

    /** If RXB0 is free (CANINTF.RX0IF clear) and queue non-empty, load next frame. */
    private tryLoadNextRxFrame(): void {
        if ((this.registers[CANINTF] & RX0IF) === 0 && this.rxQueue.length > 0) {
            this.loadFrameToRxb0(this.rxQueue.shift()!);
        }
    }

    /** Encode a CAN frame into RXB0 registers and set CANINTF.RX0IF. */
    private loadFrameToRxb0(frame: CanFrame): void {
        this.registers[RXB0_SIDH]     = (frame.id >> 3) & 0xFF;
        this.registers[RXB0_SIDH + 1] = ((frame.id & 0x07) << 5) | 0x08 | ((frame.eid >> 16) & 0x03);
        this.registers[RXB0_SIDH + 2] = (frame.eid >> 8) & 0xFF;
        this.registers[RXB0_SIDH + 3] = frame.eid & 0xFF;
        this.registers[RXB0_SIDH + 4] = frame.dlc;
        for (let i = 0; i < frame.dlc; i++) {
            this.registers[RXB0_SIDH + 5 + i] = frame.data[i];
        }
        this.registers[CANINTF] |= RX0IF;
        this.updateIntPin();
    }

    /**
     * Check if the INT pin should be asserted.
     * INT is active-low and asserts when any enabled interrupt flag is set.
     * Returns true if interrupt should be triggered.
     */
    public shouldTriggerInterrupt(): boolean {
        return (this.registers[CANINTF] & this.registers[CANINTE]) !== 0;
    }

    /**
     * Process a single TX byte from the SPI stream.
     * Returns the RX response byte and any decoded CAN frame.
     */
    public decode(txByte: number): DecodeResult {
        switch (this.state) {
            case State.IDLE:
                return this.handleInstruction(txByte);

            case State.WRITE_ADDR:
                this.register = txByte;
                if (txByte === TXB0_SIDH) {
                    this.state = State.TX_HEADER;
                    this.txHeader = [];
                } else {
                    this.state = State.WRITE_DATA;
                }
                return { rx: 0, frame: null };

            case State.WRITE_DATA:
                if (this.isInstruction(txByte)) {
                    return this.handleInstruction(txByte);
                }
                console.log(`  WRITE reg[${hex(this.register)}] = ${hex(txByte)}`);
                this.registers[this.register & 0xFF] = txByte;
                // Auto-clear TXREQ when kernel requests transmit —
                // simulates MCP2515 completing the transmission instantly.
                if (this.register === TXB0CTRL && (txByte & 0x08)) {
                    this.registers[TXB0CTRL] &= ~0x08;
                }
                // When kernel writes CANINTF, update INT pin and load next queued RX frame.
                if ((this.register & 0xFF) === CANINTF) {
                    this.updateIntPin();
                    this.tryLoadNextRxFrame();
                }
                this.register = (this.register + 1) & 0xFF;
                return { rx: 0, frame: null };

            case State.TX_HEADER:
                this.registers[(TXB0_SIDH + this.txHeader.length) & 0xFF] = txByte;
                this.txHeader.push(txByte);
                if (this.txHeader.length === 5) {
                    this.txDlc = this.txHeader[4] & 0x0F;
                    if (this.txDlc === 0) {
                        return { rx: 0, frame: this.emitCanFrame() };
                    }
                    this.txData = [];
                    this.state = State.TX_DATA;
                }
                return { rx: 0, frame: null };

            case State.TX_DATA:
                this.registers[(TXB0_SIDH + 5 + this.txData.length) & 0xFF] = txByte;
                this.txData.push(txByte);
                if (this.txData.length === this.txDlc) {
                    return { rx: 0, frame: this.emitCanFrame() };
                }
                return { rx: 0, frame: null };

            case State.READ_ADDR:
                this.register = txByte;
                this.state = State.READ_DATA;
                return { rx: 0, frame: null };

            case State.READ_DATA:
                if (this.isInstruction(txByte)) {
                    return this.handleInstruction(txByte);
                }
                const val = this.registers[this.register & 0xFF];
                console.log(`  READ reg[${hex(this.register)}] -> ${hex(val)}`);
                this.register = (this.register + 1) & 0xFF;
                return { rx: val, frame: null };

            case State.BIT_MODIFY_ADDR:
                this.register = txByte;
                this.state = State.BIT_MODIFY_MASK;
                return { rx: 0, frame: null };

            case State.BIT_MODIFY_MASK:
                this.bitModifyMask = txByte;
                this.state = State.BIT_MODIFY_DATA;
                return { rx: 0, frame: null };

            case State.BIT_MODIFY_DATA: {
                const addr = this.register & 0xFF;
                const oldVal = this.registers[addr];
                this.registers[addr] =
                    (oldVal & ~this.bitModifyMask) |
                    (txByte & this.bitModifyMask);
                console.log(`  BIT_MODIFY reg[${hex(addr)}] mask=${hex(this.bitModifyMask)} data=${hex(txByte)}: ${hex(oldVal)} -> ${hex(this.registers[addr])}`);
                if (addr === CANINTF) {
                    this.updateIntPin();
                    this.tryLoadNextRxFrame();
                }
                this.state = State.IDLE;
                return { rx: 0, frame: null };
            }

            case State.READ_STATUS_DUMMY: {
                this.state = State.IDLE;
                const status = this.computeStatus();
                return { rx: status, frame: null };
            }
        }
    }

    public setRegister(addr: number, value: number): void {
        this.registers[addr & 0xFF] = value;
    }

    public getRegister(addr: number): number {
        return this.registers[addr & 0xFF];
    }

    private isInstruction(byte: number): boolean {
        return byte === INSTRUCTION_WRITE
            || byte === INSTRUCTION_READ
            || byte === INSTRUCTION_BIT_MODIFY
            || byte === INSTRUCTION_READ_STATUS;
    }

    private handleInstruction(txByte: number): DecodeResult {
        if (txByte !== INSTRUCTION_READ_STATUS) {
            const name = INSTRUCTION_NAME[txByte];
            if (name) {
                console.log(`[MCP2515] ${name} (${hex(txByte)})`);
            }
        }
        switch (txByte) {
            case INSTRUCTION_WRITE:
                this.state = State.WRITE_ADDR;
                break;
            case INSTRUCTION_READ:
                this.state = State.READ_ADDR;
                break;
            case INSTRUCTION_BIT_MODIFY:
                this.state = State.BIT_MODIFY_ADDR;
                break;
            case INSTRUCTION_READ_STATUS:
                this.state = State.READ_STATUS_DUMMY;
                break;
            default:
                break;
        }
        return { rx: 0, frame: null };
    }

    /**
     * Compute READ_STATUS (0xA0) response from register state.
     *
     * Bit 0: CANINTF.RX0IF    Bit 1: CANINTF.RX1IF
     * Bit 2: TXB0CTRL.TXREQ   Bit 3: CANINTF.TX0IF
     * Bit 4: TXB1CTRL.TXREQ   Bit 5: CANINTF.TX1IF
     * Bit 6: TXB2CTRL.TXREQ   Bit 7: CANINTF.TX2IF
     */
    private computeStatus(): number {
        const canintf = this.registers[CANINTF];
        return ((canintf >> 0) & 1)
             | (((canintf >> 1) & 1) << 1)
             | (((this.registers[TXB0CTRL] >> 3) & 1) << 2)
             | (((canintf >> 2) & 1) << 3)
             | (((this.registers[TXB1CTRL] >> 3) & 1) << 4)
             | (((canintf >> 3) & 1) << 5)
             | (((this.registers[TXB2CTRL] >> 3) & 1) << 6)
             | (((canintf >> 4) & 1) << 7);
    }

    /**
     * Decode CAN frame from accumulated TX buffer header + data.
     *
     * Header layout (from mcp2515_try_send):
     *   [0] SIDH = (id >> 3) & 0xFF
     *   [1] SIDL = ((id & 0x07) << 5) | 0x08 | (eid >> 16) & 0xFF
     *   [2] EID8 = (eid >> 8) & 0xFF
     *   [3] EID0 = eid & 0xFF
     *   [4] DLC
     */
    private emitCanFrame(): CanFrame {
        const sidh = this.txHeader[0];
        const sidl = this.txHeader[1];
        const eid8 = this.txHeader[2];
        const eid0 = this.txHeader[3];

        const frame: CanFrame = {
            id:   (sidh << 3) | ((sidl >> 5) & 0x07),
            eid:  ((sidl & 0x03) << 16) | (eid8 << 8) | eid0,
            dlc:  this.txDlc,
            data: this.txData.slice(),
        };

        const dataStr = frame.data.map(hex).join(' ');
        console.log(`[MCP2515] CAN TX: id=${frame.id} eid=${frame.eid} dlc=${frame.dlc} data=[${dataStr}]`);

        // Set TX0IF to indicate transmit buffer is now empty
        this.registers[CANINTF] |= TX0IF;
        this.updateIntPin();

        if (this.txFrameCallback) {
            this.txFrameCallback(frame);
        }

        this.state = State.IDLE;
        return frame;
    }
}
