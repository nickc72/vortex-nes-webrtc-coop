import {
  CartridgeDefinition,
  INPUT_FIRE,
  INPUT_JUMP,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
  NetcodeTelemetry,
  NetFramePacket,
  VortexVMState,
} from './types';
import {
  cloneVMState,
  computeStateChecksum,
  createInitialVMState,
  stepVortexVM,
} from './vm';
import { apu } from './apu';

const RING_BUFFER_SIZE = 120; // 2 full seconds of 60Hz snapshots
const MAX_ROLLBACK_FRAMES = 15;

interface FrameSnapshot {
  frame: number;
  state: VortexVMState;
  inputs: [number, number];
  remoteConfirmed: boolean;
}

/**
 * GGPO-Style Rollback Netcode + WebRTC Peer-to-Peer Coordinator
 * Supports:
 * 1. SOLO (1P local)
 * 2. LOCAL_2P (2P shared keyboard/gamepads)
 * 3. SANDBOX_ROLLBACK (1P + autonomous AI/ghost partner routed through a simulated lag & jitter queue to test real Rollback re-simulation live!)
 * 4. WEBRTC_P2P (Real 2-player online P2P over WebRTC RTCDataChannel with WebSocket signaling & automatic WS relay fallback)
 */
export class RollbackNetcodeEngine {
  private cartridge: CartridgeDefinition;
  private seed: number = 1337420;
  private state: VortexVMState;
  private snapshots: FrameSnapshot[] = [];

  // Input history indexed by frame number
  private confirmedInputs: [Map<number, number>, Map<number, number>] = [
    new Map(),
    new Map(),
  ];
  private predictedInputs: [Map<number, number>, Map<number, number>] = [
    new Map(),
    new Map(),
  ];

  // WebSocket Signaling & WebRTC Peer Connection
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

  // Simulated lag queue for Rollback Sandbox testing
  private sandboxPacketQueue: { deliverAt: number; packet: NetFramePacket }[] = [];

  public telemetry: NetcodeTelemetry = {
    mode: 'SANDBOX_ROLLBACK',
    connectionState: 'DISCONNECTED',
    roomCode: null,
    localPlayerIndex: 0,
    fps: 60,
    frameTimeMs: 1.4,
    pingRttMs: 42,
    rollbackFramesLastSecond: 0,
    totalRollbacks: 0,
    maxRollbackDepth: 0,
    frameAdvantage: 0,
    predictionAccuracyPct: 100,
    packetsSent: 0,
    packetsReceived: 0,
    simulatedLagMs: 45,
    checksumMatch: true,
  };

  private predictionHits = 0;
  private predictionTotal = 0;
  private rollbackCountWindow: number[] = [];
  private onTelemetryUpdate?: (t: NetcodeTelemetry) => void;
  private onCartridgeSynced?: (cart: CartridgeDefinition) => void;

  constructor(
    initialCartridge: CartridgeDefinition,
    onTelemetryUpdate?: (t: NetcodeTelemetry) => void,
    onCartridgeSynced?: (cart: CartridgeDefinition) => void
  ) {
    this.cartridge = initialCartridge;
    this.onTelemetryUpdate = onTelemetryUpdate;
    this.onCartridgeSynced = onCartridgeSynced;
    this.state = createInitialVMState(initialCartridge, this.seed, true);
    this.resetHistory(true);
  }

  public getState(): VortexVMState {
    return this.state;
  }

  public getCartridge(): CartridgeDefinition {
    return this.cartridge;
  }

  public setMode(mode: NetcodeTelemetry['mode']): void {
    this.telemetry.mode = mode;
    const twoPlayers = mode !== 'SOLO';
    this.resetSession(this.cartridge, this.seed, twoPlayers);
    this.notifyTelemetry();
  }

  public setSimulatedLag(lagMs: number): void {
    this.telemetry.simulatedLagMs = Math.max(0, Math.min(200, lagMs));
    this.telemetry.pingRttMs = this.telemetry.simulatedLagMs * 2;
    this.notifyTelemetry();
  }

  public loadCartridge(cartridge: CartridgeDefinition, broadcastToPeer = true): void {
    this.cartridge = cartridge;
    const twoPlayers = this.telemetry.mode !== 'SOLO';
    this.resetSession(cartridge, this.seed, twoPlayers);

    if (
      broadcastToPeer &&
      this.telemetry.mode === 'WEBRTC_P2P' &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      this.ws.send(
        JSON.stringify({
          type: 'cartridge:sync',
          cartridgeId: cartridge.id,
          cartridge,
          seed: this.seed,
        })
      );
    }
  }

  public resetSession(
    cartridge = this.cartridge,
    seed = this.seed,
    twoPlayerActive = this.telemetry.mode !== 'SOLO'
  ): void {
    this.cartridge = cartridge;
    this.seed = seed;
    this.state = createInitialVMState(cartridge, seed, twoPlayerActive);
    this.resetHistory(twoPlayerActive);
  }

  private resetHistory(twoPlayerActive: boolean): void {
    this.snapshots = [];
    this.confirmedInputs = [new Map(), new Map()];
    this.predictedInputs = [new Map(), new Map()];
    this.sandboxPacketQueue = [];
    this.confirmedInputs[0].set(0, 0);
    this.confirmedInputs[1].set(0, 0);
    this.snapshots.push({
      frame: 0,
      state: cloneVMState(this.state),
      inputs: [0, 0],
      remoteConfirmed: !twoPlayerActive,
    });
  }

  /**
   * Main 60Hz Tick called from requestAnimationFrame accumulator
   */
  public tickFrame(localP1Mask: number, localP2Mask: number): VortexVMState {
    const t0 = performance.now();
    const nextFrame = this.state.frame + 1;
    const mode = this.telemetry.mode;

    if (mode === 'SOLO') {
      this.state = stepVortexVM(this.state, this.cartridge, localP1Mask, 0);
      this.playFrameAudio(this.state);
      this.recordFrameMetrics(t0);
      return this.state;
    }

    if (mode === 'LOCAL_2P') {
      this.state = stepVortexVM(
        this.state,
        this.cartridge,
        localP1Mask,
        localP2Mask
      );
      this.playFrameAudio(this.state);
      this.recordFrameMetrics(t0);
      return this.state;
    }

    // Rollback Netcode Path (SANDBOX_ROLLBACK or WEBRTC_P2P)
    const localIdx = this.telemetry.localPlayerIndex;
    const remoteIdx: 0 | 1 = localIdx === 0 ? 1 : 0;
    const myInput = localIdx === 0 ? localP1Mask : localP1Mask || localP2Mask;

    this.confirmedInputs[localIdx].set(nextFrame, myInput);

    if (mode === 'SANDBOX_ROLLBACK') {
      // Generate deterministic synthetic co-op partner input and enqueue with simulated network lag
      const botInput = this.computeSyntheticPartnerInput(nextFrame);
      const packet: NetFramePacket = {
        frame: nextFrame,
        playerIndex: 1,
        inputs: [botInput],
        timestamp: performance.now(),
        stateChecksum: computeStateChecksum(this.state),
      };
      const jitter = ((nextFrame * 17) % 14) - 7;
      const delay = Math.max(0, this.telemetry.simulatedLagMs + jitter);
      this.sandboxPacketQueue.push({
        deliverAt: performance.now() + delay,
        packet,
      });

      // Deliver any packets whose simulated network latency has elapsed
      const now = performance.now();
      while (
        this.sandboxPacketQueue.length > 0 &&
        this.sandboxPacketQueue[0].deliverAt <= now
      ) {
        const item = this.sandboxPacketQueue.shift()!;
        this.receiveRemotePacket(item.packet);
      }
    } else if (mode === 'WEBRTC_P2P') {
      this.sendLocalInputPacket(nextFrame, localIdx);
    }

    // Predict remote input if not yet confirmed for `nextFrame`
    let remoteInput = this.confirmedInputs[remoteIdx].get(nextFrame);
    if (remoteInput === undefined) {
      // Repeat last known confirmed input from remote peer (standard GGPO zero-order hold prediction)
      remoteInput = this.getLastConfirmedInput(remoteIdx, nextFrame - 1);
      this.predictedInputs[remoteIdx].set(nextFrame, remoteInput);
    }

    const p1Mask = localIdx === 0 ? myInput : remoteInput;
    const p2Mask = localIdx === 1 ? myInput : remoteInput;

    this.state = stepVortexVM(this.state, this.cartridge, p1Mask, p2Mask);
    this.playFrameAudio(this.state);

    // Save snapshot into ring buffer
    this.snapshots.push({
      frame: nextFrame,
      state: cloneVMState(this.state),
      inputs: [p1Mask, p2Mask],
      remoteConfirmed: this.confirmedInputs[remoteIdx].has(nextFrame),
    });
    if (this.snapshots.length > RING_BUFFER_SIZE) {
      this.snapshots.shift();
    }

    this.recordFrameMetrics(t0);
    return this.state;
  }

  /**
   * Process incoming remote input packet and trigger GGPO Rollback + Re-simulation if a past prediction was wrong
   */
  private receiveRemotePacket(packet: NetFramePacket): void {
    this.telemetry.packetsReceived += 1;
    const remoteIdx = packet.playerIndex;
    const localIdx: 0 | 1 = remoteIdx === 0 ? 1 : 0;

    let earliestMispredictedFrame: number | null = null;

    // Unpack sliding window of redundant inputs
    for (let offset = 0; offset < packet.inputs.length; offset++) {
      const f = packet.frame - offset;
      if (f <= 0) continue;
      const actualInput = packet.inputs[offset];

      if (!this.confirmedInputs[remoteIdx].has(f)) {
        this.confirmedInputs[remoteIdx].set(f, actualInput);

        const predicted = this.predictedInputs[remoteIdx].get(f);
        if (predicted !== undefined) {
          this.predictionTotal += 1;
          if (predicted === actualInput) {
            this.predictionHits += 1;
          } else if (
            f <= this.state.frame &&
            (earliestMispredictedFrame === null || f < earliestMispredictedFrame)
          ) {
            earliestMispredictedFrame = f;
          }
        }
      }
    }

    if (this.predictionTotal > 0) {
      this.telemetry.predictionAccuracyPct = Math.round(
        (this.predictionHits / this.predictionTotal) * 100
      );
    }

    this.telemetry.frameAdvantage = this.state.frame - packet.frame;

    // Execute Rollback & Fast-Forward Re-Simulation if prediction diverged
    if (
      earliestMispredictedFrame !== null &&
      this.state.frame - earliestMispredictedFrame <= MAX_ROLLBACK_FRAMES
    ) {
      const targetRestoreFrame = earliestMispredictedFrame - 1;
      const snapshotIdx = this.snapshots.findIndex(
        (s) => s.frame === targetRestoreFrame
      );

      if (snapshotIdx !== -1) {
        const currentTargetFrame = this.state.frame;
        const depth = currentTargetFrame - targetRestoreFrame;
        this.telemetry.totalRollbacks += 1;
        this.telemetry.maxRollbackDepth = Math.max(
          this.telemetry.maxRollbackDepth,
          depth
        );
        this.rollbackCountWindow.push(performance.now());

        // Restore VM state to `targetRestoreFrame`
        let simState = cloneVMState(this.snapshots[snapshotIdx].state);
        // Trim snapshots after restore point
        this.snapshots = this.snapshots.slice(0, snapshotIdx + 1);

        // Fast-forward re-simulate up to `currentTargetFrame`
        for (let f = targetRestoreFrame + 1; f <= currentTargetFrame; f++) {
          const myIn = this.confirmedInputs[localIdx].get(f) ?? 0;
          let remIn = this.confirmedInputs[remoteIdx].get(f);
          if (remIn === undefined) {
            remIn = this.getLastConfirmedInput(remoteIdx, f - 1);
            this.predictedInputs[remoteIdx].set(f, remIn);
          }

          const p1In = localIdx === 0 ? myIn : remIn;
          const p2In = localIdx === 1 ? myIn : remIn;

          simState = stepVortexVM(simState, this.cartridge, p1In, p2In);
          this.snapshots.push({
            frame: f,
            state: cloneVMState(simState),
            inputs: [p1In, p2In],
            remoteConfirmed: this.confirmedInputs[remoteIdx].has(f),
          });
        }

        this.state = simState;
      }
    }
  }

  private getLastConfirmedInput(playerIdx: 0 | 1, fromFrame: number): number {
    for (let f = fromFrame; f >= Math.max(0, fromFrame - 20); f--) {
      const val = this.confirmedInputs[playerIdx].get(f);
      if (val !== undefined) return val;
    }
    return 0;
  }

  private computeSyntheticPartnerInput(frame: number): number {
    const p2 = this.state.players[1];
    const p1 = this.state.players[0];
    if (!p2 || !p2.active) return 0;

    let mask = INPUT_FIRE;
    if (p2.x < p1.x - 45) {
      mask |= INPUT_RIGHT;
    } else if (p2.x > p1.x + 65) {
      mask |= INPUT_LEFT;
    } else if (Math.sin(frame * 0.05) > 0.25) {
      mask |= INPUT_RIGHT;
    }

    if (frame % 75 === 0) {
      mask |= INPUT_JUMP;
    }
    if (frame % 45 < 15) {
      mask |= INPUT_UP;
    }
    return mask;
  }

  /**
   * Connect to WebSocket Signaling Server & Establish WebRTC Peer-to-Peer DataChannel
   */
  public connectRoom(action: 'CREATE' | 'JOIN', roomCodeToJoin?: string): void {
    this.disconnectRoom();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws-signaling`;
    this.ws = new WebSocket(wsUrl);
    this.telemetry.mode = 'WEBRTC_P2P';
    this.telemetry.connectionState = 'SIGNALING';
    this.notifyTelemetry();

    this.ws.onopen = () => {
      if (!this.ws) return;
      if (action === 'CREATE') {
        this.ws.send(
          JSON.stringify({
            type: 'room:create',
            cartridgeId: this.cartridge.id,
          })
        );
      } else {
        this.ws.send(
          JSON.stringify({
            type: 'room:join',
            code: roomCodeToJoin,
          })
        );
      }
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'room:created': {
          this.telemetry.roomCode = msg.code;
          this.telemetry.localPlayerIndex = 0;
          this.seed = msg.seed;
          this.resetSession(this.cartridge, this.seed, true);
          this.notifyTelemetry();
          break;
        }
        case 'room:joined': {
          this.telemetry.roomCode = msg.code;
          this.telemetry.localPlayerIndex = 1;
          this.seed = msg.seed;
          this.telemetry.connectionState = 'WS_RELAY';
          this.resetSession(this.cartridge, this.seed, true);
          this.initPeerConnection(false);
          this.notifyTelemetry();
          break;
        }
        case 'peer:ready': {
          this.seed = msg.seed;
          this.telemetry.connectionState = 'WS_RELAY';
          this.resetSession(this.cartridge, this.seed, true);
          await this.initPeerConnection(true);
          this.notifyTelemetry();
          break;
        }
        case 'webrtc:signal': {
          await this.handleWebRTCSignal(msg.signalData);
          break;
        }
        case 'netplay:relay': {
          if (msg.packet) {
            this.receiveRemotePacket(msg.packet);
          }
          break;
        }
        case 'cartridge:sync': {
          if (msg.cartridge) {
            this.seed = msg.seed || this.seed;
            this.loadCartridge(msg.cartridge, false);
            if (this.onCartridgeSynced) {
              this.onCartridgeSynced(msg.cartridge);
            }
          }
          break;
        }
        case 'peer:disconnected': {
          this.telemetry.connectionState = 'SIGNALING';
          this.notifyTelemetry();
          break;
        }
      }
    };
  }

  private async initPeerConnection(isInitiator: boolean): Promise<void> {
    if (this.pc) {
      this.pc.close();
    }

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'webrtc:signal',
            signalData: { candidate: e.candidate },
          })
        );
      }
    };

    if (isInitiator) {
      const dc = this.pc.createDataChannel('vortex-netplay', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.setupDataChannel(dc);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'webrtc:signal',
            signalData: { sdp: this.pc.localDescription },
          })
        );
      }
    } else {
      this.pc.ondatachannel = (e) => {
        this.setupDataChannel(e.channel);
      };
    }
  }

  private setupDataChannel(dc: RTCDataChannel): void {
    this.dataChannel = dc;
    dc.onopen = () => {
      this.telemetry.connectionState = 'WEBRTC_DIRECT';
      this.notifyTelemetry();
    };
    dc.onclose = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.telemetry.connectionState = 'WS_RELAY';
      } else {
        this.telemetry.connectionState = 'DISCONNECTED';
      }
      this.notifyTelemetry();
    };
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          dc.send(JSON.stringify({ type: 'pong', t: msg.t }));
        } else if (msg.type === 'pong') {
          this.telemetry.pingRttMs = Math.max(1, Math.round(performance.now() - msg.t));
        } else if (msg.type === 'frame') {
          this.receiveRemotePacket(msg.packet);
        }
      } catch {
        // Ignore malformed datagram
      }
    };
  }

  private async handleWebRTCSignal(signalData: {
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  }): Promise<void> {
    if (!this.pc) {
      await this.initPeerConnection(false);
    }
    if (!this.pc) return;

    if (signalData.sdp) {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      if (signalData.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              type: 'webrtc:signal',
              signalData: { sdp: this.pc.localDescription },
            })
          );
        }
      }
    } else if (signalData.candidate) {
      await this.pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
    }
  }

  private sendLocalInputPacket(frame: number, playerIndex: 0 | 1): void {
    // Pack current frame + up to 8 previous frames of inputs for UDP packet-loss immunity
    const inputs: number[] = [];
    for (let i = 0; i < 8; i++) {
      const f = frame - i;
      if (f < 0) break;
      inputs.push(this.confirmedInputs[playerIndex].get(f) ?? 0);
    }

    const packet: NetFramePacket = {
      frame,
      playerIndex,
      inputs,
      timestamp: performance.now(),
      stateChecksum: computeStateChecksum(this.state),
    };

    this.telemetry.packetsSent += 1;

    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'frame', packet }));
      if (frame % 30 === 0) {
        this.dataChannel.send(JSON.stringify({ type: 'ping', t: performance.now() }));
      }
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'netplay:relay', packet }));
    }
  }

  public disconnectRoom(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.telemetry.connectionState = 'DISCONNECTED';
    this.telemetry.roomCode = null;
    this.notifyTelemetry();
  }

  private playFrameAudio(state: VortexVMState): void {
    for (const cue of state.soundEvents) {
      apu.playCue(cue);
    }
  }

  private recordFrameMetrics(t0: number): void {
    const dt = performance.now() - t0;
    this.telemetry.frameTimeMs = Number((this.telemetry.frameTimeMs * 0.85 + dt * 0.15).toFixed(2));
    const now = performance.now();
    this.rollbackCountWindow = this.rollbackCountWindow.filter((t) => now - t <= 1000);
    this.telemetry.rollbackFramesLastSecond = this.rollbackCountWindow.length;

    if (this.state.frame % 15 === 0) {
      this.notifyTelemetry();
    }
  }

  private notifyTelemetry(): void {
    if (this.onTelemetryUpdate) {
      this.onTelemetryUpdate({ ...this.telemetry });
    }
  }
}
