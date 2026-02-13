/**
 * CS3 CAN protocol handler.
 *
 * Interprets CAN frames from the kernel's MCP2515 driver,
 * dispatches commands to MarklinController, and generates
 * correct ACK response frames.
 */
import { CanFrame } from './mcp_decoder';
import { MarklinController } from '../marklin/marklin_controller';
import { SwitchDirection } from '../model/switch';

// CS3 command codes (from kernel train.cpp)
const SYSTEM_CMD    = 0x00;
const SPEED_CMD     = 0x04;
const DIRECTION_CMD = 0x05;
const LIGHT_CMD     = 0x06;
const SWITCH_CMD    = 0x0B;

// System sub-commands
const STOP_SUBCMD = 0x00;
const GO_SUBCMD   = 0x01;
const HALT_SUBCMD = 0x02;

const CS3_MAX_SPEED = 1000;
const SIM_MAX_SPEED = 14;

const SUBCMD_NAME: Record<number, string> = {
    [STOP_SUBCMD]: 'STOP',
    [GO_SUBCMD]:   'GO',
    [HALT_SUBCMD]: 'HALT',
};

function decodeCommand(frame: CanFrame): number {
    return ((frame.id << 1) & 0xFE) | ((frame.eid >> 17) & 0x01);
}

function makeAck(frame: CanFrame): CanFrame {
    return {
        id:   frame.id,
        eid:  frame.eid | 0x10000,
        dlc:  frame.dlc,
        data: frame.data.slice(),
    };
}

function readId(data: number[]): number {
    return ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
}

function cs3SpeedToSim(cs3Speed: number): number {
    if (cs3Speed <= 0) return 0;
    if (cs3Speed >= CS3_MAX_SPEED) return SIM_MAX_SPEED;
    return Math.round((cs3Speed / CS3_MAX_SPEED) * SIM_MAX_SPEED);
}

function decodeSwitchId(encodedId: number): number {
    return encodedId - 0x3000 + 1;
}

export class Cs3Handler {
    private controller: MarklinController | null = null;
    private trainLights: Map<number, boolean> = new Map();

    public setController(controller: MarklinController): void {
        this.controller = controller;
    }

    public handleTxFrame(frame: CanFrame): CanFrame[] {
        const command = decodeCommand(frame);
        const ack = makeAck(frame);

        switch (command) {
            case SYSTEM_CMD:    return this.handleSystem(frame, ack);
            case SPEED_CMD:     return this.handleSpeed(frame, ack);
            case DIRECTION_CMD: return this.handleDirection(frame, ack);
            case LIGHT_CMD:     return this.handleLight(frame, ack);
            case SWITCH_CMD:    return this.handleSwitch(frame, ack);
            default:
                console.log(`[CS3] Unknown command: 0x${command.toString(16).padStart(2, '0')}`);
                return [ack];
        }
    }

    private handleSystem(frame: CanFrame, ack: CanFrame): CanFrame[] {
        const subcmd = frame.data[4];
        console.log(`[CS3] SYSTEM ${SUBCMD_NAME[subcmd] ?? subcmd}`);
        return [ack];
    }

    private handleSpeed(frame: CanFrame, ack: CanFrame): CanFrame[] {
        const trainId = readId(frame.data);

        if (frame.dlc <= 4) {
            console.log(`[CS3] SPEED QUERY train=${trainId}`);
            return [ack];
        }

        const cs3Speed = (frame.data[4] << 8) | frame.data[5];
        const simSpeed = cs3SpeedToSim(cs3Speed);
        const light = this.trainLights.get(trainId) ?? false;
        console.log(`[CS3] SET SPEED train=${trainId} cs3=${cs3Speed} sim=${simSpeed}`);

        if (this.controller) {
            this.controller.setTrainSpeed(trainId, simSpeed, light);
        }
        return [ack];
    }

    private handleDirection(frame: CanFrame, ack: CanFrame): CanFrame[] {
        const trainId = readId(frame.data);
        console.log(`[CS3] REVERSE train=${trainId}`);

        if (this.controller) {
            this.controller.reverseTrain(trainId);
        }
        return [ack];
    }

    private handleLight(frame: CanFrame, ack: CanFrame): CanFrame[] {
        const trainId = readId(frame.data);
        const on = frame.data[5] !== 0;
        console.log(`[CS3] LIGHT train=${trainId} on=${on}`);

        this.trainLights.set(trainId, on);
        return [ack];
    }

    private handleSwitch(frame: CanFrame, ack: CanFrame): CanFrame[] {
        const encodedId = readId(frame.data);
        const switchId = decodeSwitchId(encodedId);
        const position = frame.data[4];
        // Kernel: CURVED=0, STRAIGHT=1 in data[4]
        // Sim: SwitchDirection.Straight=0, SwitchDirection.Curve=1
        const direction = position ? SwitchDirection.Straight : SwitchDirection.Curve;
        console.log(`[CS3] SWITCH id=${switchId} ${position ? 'STRAIGHT' : 'CURVED'}`);

        if (this.controller) {
            this.controller.changeSwitchDirection(switchId, direction);
        }
        return [ack, ack];
    }
}
