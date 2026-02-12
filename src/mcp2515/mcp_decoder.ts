/**
 * Decodes MCP2515 SPI byte stream into CAN frames.
 *
 * The MCP2515 SPI protocol uses these instructions:
 *   0x02 (WRITE):       [instruction, register, data...]
 *   0x03 (READ):        [instruction, register, dummy...]
 *   0x05 (BIT_MODIFY):  [instruction, register, mask, data]
 *   0xA0 (READ_STATUS): [instruction, dummy]
 *
 * CAN TX frames are detected as multi-byte WRITEs to register 0x31 (TXB0 SIDH).
 * The data layout is: [SIDH, SIDL, EID8, EID0, DLC, D0, ..., Dn]
 *
 * This decoder processes bytes one at a time (like MarklinDecoder) and uses
 * MCP2515 protocol knowledge to determine transaction boundaries. Multi-byte
 * READs are not fully tracked since their length is not encoded in the stream.
 */

export interface CanFrame {
    id: number;
    eid: number;
    dlc: number;
    data: number[];
}

// MCP2515 SPI instructions
const INSTRUCTION_WRITE       = 0x02;
const INSTRUCTION_READ        = 0x03;
const INSTRUCTION_BIT_MODIFY  = 0x05;
const INSTRUCTION_READ_STATUS = 0xA0;

// TX buffer 0 register addresses
const TXB0_SIDH = 0x31;

const enum State {
    IDLE,
    WRITE_ADDR,
    WRITE_SINGLE,
    TX_HEADER,
    TX_DATA,
    READ_ADDR,
    READ_DUMMY,
    BIT_MODIFY_ADDR,
    BIT_MODIFY_MASK,
    BIT_MODIFY_DATA,
    READ_STATUS_DUMMY,
}

export class McpDecoder {
    private state: State = State.IDLE;
    private txHeader: number[] = [];
    private txData: number[] = [];
    private txDlc: number = 0;

    /**
     * Process a single byte from the SPI stream.
     * Returns a CanFrame when a complete TX frame is decoded, null otherwise.
     */
    public decode(byte: number): CanFrame | null {
        switch (this.state) {
            case State.IDLE:
                return this.decodeInstruction(byte);

            case State.WRITE_ADDR:
                if (byte === TXB0_SIDH) {
                    this.state = State.TX_HEADER;
                    this.txHeader = [];
                } else {
                    this.state = State.WRITE_SINGLE;
                }
                return null;

            case State.WRITE_SINGLE:
                this.state = State.IDLE;
                return null;

            case State.TX_HEADER:
                this.txHeader.push(byte);
                if (this.txHeader.length === 5) {
                    this.txDlc = this.txHeader[4] & 0x0F;
                    if (this.txDlc === 0) {
                        return this.emitCanFrame();
                    }
                    this.txData = [];
                    this.state = State.TX_DATA;
                }
                return null;

            case State.TX_DATA:
                this.txData.push(byte);
                if (this.txData.length === this.txDlc) {
                    return this.emitCanFrame();
                }
                return null;

            case State.READ_ADDR:
                this.state = State.READ_DUMMY;
                return null;

            case State.READ_DUMMY:
                this.state = State.IDLE;
                return null;

            case State.BIT_MODIFY_ADDR:
                this.state = State.BIT_MODIFY_MASK;
                return null;

            case State.BIT_MODIFY_MASK:
                this.state = State.BIT_MODIFY_DATA;
                return null;

            case State.BIT_MODIFY_DATA:
                this.state = State.IDLE;
                return null;

            case State.READ_STATUS_DUMMY:
                this.state = State.IDLE;
                return null;
        }
    }

    private decodeInstruction(byte: number): null {
        switch (byte) {
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
                // Unknown byte in IDLE state; skip it.
                break;
        }
        return null;
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

        this.state = State.IDLE;
        return frame;
    }
}
