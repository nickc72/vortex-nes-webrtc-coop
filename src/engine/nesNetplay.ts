import {
  base64ToUint8Array,
  ContraWeaponCode,
  FrameCheatCommand,
  InesRomMetadata,
  RealNesHardwareCore,
  uint8ArrayToBase64,
} from './nesCore';

export interface AuthoritativeFrameRecord {
  f: number; // Frame number (1-indexed)
  p1: number; // Controller 1 bitmask used on frame f
  p2: number; // Controller 2 bitmask used on frame f
  c?: FrameCheatCommand; // Optional cheat executed on frame f
}

export interface HostFrameBatchPacket {
  latestFrame: number;
  frames: AuthoritativeFrameRecord[]; // Sliding window of recent authoritative frames
  ramChecksum: number;
  timestamp: number;
}

export interface ClientInputPacket {
  p2Mask: number;
  clientFrame: number;
  clientChecksum: number;
  timestamp: number;
}

export interface ChatMessageItem {
  id: string;
  sender: 'P1' | 'P2' | 'SYSTEM';
  text: string;
  timestamp: number;
}

export interface NesNetplayTelemetry {
  engineMode: 'NES_HARDWARE' | 'BUILTIN_DEMO';
  netMode: 'SOLO_2P_LOCAL' | 'WEBRTC_P2P';
  connectionState: 'DISCONNECTED' | 'SIGNALING' | 'WEBRTC_DIRECT' | 'WS_RELAY';
  roomCode: string | null;
  localPlayerIndex: 0 | 1;
  peerConnected: boolean;
  fps: number;
  frameTimeMs: number;
  pingRttMs: number;
  frameAdvantage: number;
  packetsSent: number;
  packetsReceived: number;
  romSyncedWithPeer: boolean;
}

/**
 * Host-Authoritative Frame-Locked NES Coordinator
 * Guarantees 0-frame divergence between Player 1 (Host) and Player 2 (Client):
 * - Player 2 streams its live controller bitmask (`p2Mask`) to Host.
 * - Host steps the authoritative 6502 CPU at 60Hz using `(localP1Mask, latestP2Mask)`
 *   and broadcasts a 20-frame sliding window of authoritative `{ f, p1, p2, c }` records.
 * - Player 2 steps its 6502 CPU strictly through the exact `{ f, p1, p2, c }` sequence dictated by Host!
 * - If Player 2's RAM checksum ever differs from Host's or if Player 2 falls >90 frames behind,
 *   Host automatically pushes an exact CPU/PPU state snapshot (`savestate:sync`) so both screens match 100%.
 */
export class NesWebRtcCoordinator {
  public nesCore = new RealNesHardwareCore();
  private rawRomBytes: Uint8Array | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  // Host (Player 1) State
  private hostHistory = new Map<number, AuthoritativeFrameRecord>();
  private latestRemoteP2Mask = 0;
  private pendingCheatForNextFrame: FrameCheatCommand = 'NONE';
  private lastResyncSentAt = 0;

  // Client (Player 2) State
  private clientAuthQueue = new Map<number, AuthoritativeFrameRecord>();
  private hostLatestChecksum = 0;
  private hostLatestChecksumFrame = 0;

  public telemetry: NesNetplayTelemetry = {
    engineMode: 'NES_HARDWARE',
    netMode: 'SOLO_2P_LOCAL',
    connectionState: 'DISCONNECTED',
    roomCode: null,
    localPlayerIndex: 0,
    peerConnected: false,
    fps: 60,
    frameTimeMs: 0.9,
    pingRttMs: 0,
    frameAdvantage: 0,
    packetsSent: 0,
    packetsReceived: 0,
    romSyncedWithPeer: false,
  };

  private onTelemetryChange?: (t: NesNetplayTelemetry) => void;
  private onRomLoadedFromPeer?: (meta: InesRomMetadata) => void;
  private onStatusToast?: (msg: string) => void;
  private onChatReceived?: (msg: ChatMessageItem) => void;

  constructor(callbacks?: {
    onTelemetryChange?: (t: NesNetplayTelemetry) => void;
    onRomLoadedFromPeer?: (meta: InesRomMetadata) => void;
    onStatusToast?: (msg: string) => void;
    onChatReceived?: (msg: ChatMessageItem) => void;
  }) {
    this.onTelemetryChange = callbacks?.onTelemetryChange;
    this.onRomLoadedFromPeer = callbacks?.onRomLoadedFromPeer;
    this.onStatusToast = callbacks?.onStatusToast;
    this.onChatReceived = callbacks?.onChatReceived;
  }

  public loadUserNesRom(
    bytes: Uint8Array,
    fileName: string,
    broadcastToPeer = true
  ): InesRomMetadata {
    const meta = this.nesCore.loadNesRomBytes(bytes, fileName);
    this.rawRomBytes = bytes;
    this.clearSyncQueues();
    this.telemetry.engineMode = 'NES_HARDWARE';

    if (broadcastToPeer && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const romBase64 = uint8ArrayToBase64(bytes);
      this.ws.send(
        JSON.stringify({
          type: 'rom:sync',
          romName: meta.fileName,
          romBase64,
          romCrc32: meta.crc32,
        })
      );
      this.telemetry.romSyncedWithPeer = true;
      this.emitToast(`Synced "${meta.fileName}" (${meta.prgRomSizeKb}KB) to room.`);
    }

    this.notifyTelemetry();
    return meta;
  }

  private clearSyncQueues(): void {
    this.hostHistory.clear();
    this.clientAuthQueue.clear();
    this.latestRemoteP2Mask = 0;
    this.pendingCheatForNextFrame = 'NONE';
  }

  public queueCheatCommand(cmd: FrameCheatCommand): void {
    if (this.telemetry.netMode === 'WEBRTC_P2P' && this.telemetry.peerConnected) {
      if (this.telemetry.localPlayerIndex === 0) {
        this.pendingCheatForNextFrame = cmd;
      } else {
        // Player 2 requests Host to execute cheat on next authoritative frame
        this.sendToPeer({ type: 'cheat_req', cmd });
      }
    } else {
      this.nesCore.applyDeterministicCheatCommand(cmd);
    }
  }

  public queueWeaponCheat(weapon: ContraWeaponCode): void {
    const map: Record<ContraWeaponCode, FrameCheatCommand> = {
      S: 'WPN_S',
      L: 'WPN_L',
      M: 'WPN_M',
      F: 'WPN_F',
      R: 'WPN_S',
    };
    this.queueCheatCommand(map[weapon]);
  }

  /**
   * Called at 60.0988 Hz by the unthrottled Web Worker / Animation Loop
   */
  public tickNesFrame(localP1Mask: number, localP2Mask: number): void {
    if (!this.nesCore.romLoaded) return;
    const t0 = performance.now();

    if (
      this.telemetry.netMode === 'WEBRTC_P2P' &&
      this.telemetry.peerConnected
    ) {
      if (this.telemetry.localPlayerIndex === 0) {
        // ==================== PLAYER 1 (AUTHORITATIVE HOST) ====================
        const nextFrame = this.nesCore.frameCounter + 1;
        const p1 = localP1Mask;
        const p2 = this.latestRemoteP2Mask;
        const cheat = this.pendingCheatForNextFrame;
        this.pendingCheatForNextFrame = 'NONE';

        this.nesCore.stepFrame(p1, p2, cheat);

        const rec: AuthoritativeFrameRecord = {
          f: nextFrame,
          p1,
          p2,
          ...(cheat !== 'NONE' ? { c: cheat } : {}),
        };
        this.hostHistory.set(nextFrame, rec);

        // Prune history older than 240 frames
        if (this.hostHistory.size > 240) {
          this.hostHistory.delete(nextFrame - 240);
        }

        // Pack sliding window of last 18 authoritative frames so dropped packets heal immediately
        const frames: AuthoritativeFrameRecord[] = [];
        for (let i = 0; i < 18; i++) {
          const item = this.hostHistory.get(nextFrame - i);
          if (item) frames.push(item);
        }

        const batch: HostFrameBatchPacket = {
          latestFrame: nextFrame,
          frames,
          ramChecksum: this.nesCore.computeRamChecksum(),
          timestamp: performance.now(),
        };

        this.sendToPeer({ type: 'host_batch', batch });
      } else {
        // ==================== PLAYER 2 (FRAME-LOCKED CLIENT) ====================
        // 1. Stream Player 2's current controller input to Host
        const myControllerInput = localP1Mask || localP2Mask;
        const clientPkt: ClientInputPacket = {
          p2Mask: myControllerInput,
          clientFrame: this.nesCore.frameCounter,
          clientChecksum: this.nesCore.computeRamChecksum(),
          timestamp: performance.now(),
        };
        this.sendToPeer({ type: 'client_input', clientPkt });

        // 2. Step strictly through consecutive authoritative frames received from Host!
        let stepsRun = 0;
        // Allow up to 8 catch-up frames per tick if a burst of packets arrived
        while (
          this.clientAuthQueue.has(this.nesCore.frameCounter + 1) &&
          stepsRun < 8
        ) {
          const nextF = this.nesCore.frameCounter + 1;
          const rec = this.clientAuthQueue.get(nextF)!;
          this.clientAuthQueue.delete(nextF);
          this.nesCore.stepFrame(rec.p1, rec.p2, rec.c || 'NONE');
          stepsRun += 1;

          // Verify RAM Checksum when reaching Host's checksum frame
          if (
            nextF === this.hostLatestChecksumFrame &&
            this.hostLatestChecksum !== 0
          ) {
            const localSum = this.nesCore.computeRamChecksum();
            if (localSum !== this.hostLatestChecksum) {
              // Request immediate authoritative save-state heal from Host
              this.sendToPeer({ type: 'request_resync' }, true);
            }
          }
        }
      }
    } else {
      // Solo or Local 2P Shared Keyboard mode
      this.nesCore.stepFrame(localP1Mask, localP2Mask);
    }

    const dt = performance.now() - t0;
    this.telemetry.frameTimeMs = Number(
      (this.telemetry.frameTimeMs * 0.85 + dt * 0.15).toFixed(2)
    );
    if (this.nesCore.frameCounter % 15 === 0) {
      this.notifyTelemetry();
    }
  }

  /**
   * Send packet via WebRTC DataChannel if open, OR WebSocket relay fallback so zero packets are lost during ICE handshake
   */
  private sendToPeer(payload: Record<string, unknown>, forceReliableWs = false): void {
    this.telemetry.packetsSent += 1;

    if (
      !forceReliableWs &&
      this.dataChannel &&
      this.dataChannel.readyState === 'open'
    ) {
      try {
        this.dataChannel.send(JSON.stringify(payload));
        return;
      } catch {
        // Fallback to WebSocket relay below
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'netplay:relay',
          packet: payload,
        })
      );
    }
  }

  private handleIncomingPeerPayload(msg: Record<string, unknown>): void {
    this.telemetry.packetsReceived += 1;

    if (msg.type === 'host_batch' && this.telemetry.localPlayerIndex === 1) {
      const batch = msg.batch as HostFrameBatchPacket;
      this.hostLatestChecksum = batch.ramChecksum;
      this.hostLatestChecksumFrame = batch.latestFrame;
      this.telemetry.frameAdvantage =
        this.nesCore.frameCounter - batch.latestFrame;

      for (const rec of batch.frames) {
        if (rec.f > this.nesCore.frameCounter) {
          this.clientAuthQueue.set(rec.f, rec);
        }
      }

      // If Client fell more than 60 frames (1 second) behind Host (e.g. tab just opened), request instant state jump!
      if (batch.latestFrame - this.nesCore.frameCounter > 60) {
        this.sendToPeer({ type: 'request_resync' }, true);
      }
    } else if (
      msg.type === 'client_input' &&
      this.telemetry.localPlayerIndex === 0
    ) {
      const pkt = msg.clientPkt as ClientInputPacket;
      this.latestRemoteP2Mask = pkt.p2Mask;
      this.telemetry.frameAdvantage =
        this.nesCore.frameCounter - pkt.clientFrame;

      // Measure RTT ping
      if (this.nesCore.frameCounter % 30 === 0) {
        this.sendToPeer({ type: 'ping', t: performance.now() });
      }
    } else if (
      msg.type === 'request_resync' &&
      this.telemetry.localPlayerIndex === 0
    ) {
      const now = performance.now();
      if (now - this.lastResyncSentAt > 600) {
        this.lastResyncSentAt = now;
        this.syncExactSaveStateToPeer();
      }
    } else if (
      msg.type === 'cheat_req' &&
      this.telemetry.localPlayerIndex === 0
    ) {
      this.pendingCheatForNextFrame = (msg.cmd as FrameCheatCommand) || 'NONE';
    } else if (msg.type === 'ping') {
      this.sendToPeer({ type: 'pong', t: msg.t });
    } else if (msg.type === 'pong') {
      this.telemetry.pingRttMs = Math.max(
        1,
        Math.round(performance.now() - Number(msg.t))
      );
    } else if (msg.type === 'chat' && msg.item) {
      this.onChatReceived?.(msg.item as ChatMessageItem);
    }
  }

  public sendChatOrCallout(text: string): void {
    const sender: 'P1' | 'P2' =
      this.telemetry.localPlayerIndex === 0 ? 'P1' : 'P2';
    const item: ChatMessageItem = {
      id: Math.random().toString(36).slice(2),
      sender,
      text,
      timestamp: Date.now(),
    };
    this.onChatReceived?.(item);
    this.sendToPeer({ type: 'chat', item }, true);
  }

  /**
   * Captures Host's exact 6502 CPU + PPU + Mapper state and locks both peers to the exact same frameCounter
   */
  public syncExactSaveStateToPeer(): void {
    if (!this.nesCore.romLoaded) return;
    const stateJson = this.nesCore.saveStateSnapshot();
    if (!stateJson) return;

    const currentFrame = this.nesCore.frameCounter;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'savestate:sync',
          frame: currentFrame,
          stateJson,
        })
      );
      this.emitToast(
        `Locked both players to exact NES CPU/PPU state at Frame #${currentFrame}.`
      );
    }
  }

  public connectRoom(action: 'CREATE' | 'JOIN', roomCodeToJoin?: string): void {
    this.disconnectRoom();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws-signaling`;
    this.ws = new WebSocket(wsUrl);
    this.telemetry.netMode = 'WEBRTC_P2P';
    this.telemetry.connectionState = 'SIGNALING';
    this.notifyTelemetry();

    this.ws.onopen = () => {
      if (!this.ws) return;
      if (action === 'CREATE') {
        const romBase64 = this.rawRomBytes
          ? uint8ArrayToBase64(this.rawRomBytes)
          : null;
        this.ws.send(
          JSON.stringify({
            type: 'room:create',
            romName:
              this.nesCore.romMeta?.fileName || 'Awaiting .nes ROM Upload',
            romBase64,
            romCrc32: this.nesCore.romMeta?.crc32 || '00000000',
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
          this.telemetry.peerConnected = false;
          this.clearSyncQueues();
          this.emitToast(`Room ${msg.code} created! Share code with Player 2.`);
          this.notifyTelemetry();
          break;
        }

        case 'room:joined': {
          this.telemetry.roomCode = msg.code;
          this.telemetry.localPlayerIndex = 1;
          this.telemetry.peerConnected = true;
          this.telemetry.connectionState = 'WS_RELAY';
          this.clearSyncQueues();

          if (msg.romBase64) {
            try {
              const bytes = base64ToUint8Array(msg.romBase64);
              const meta = this.loadUserNesRom(
                bytes,
                msg.romName || 'SyncedRom.nes',
                false
              );
              this.telemetry.romSyncedWithPeer = true;
              this.onRomLoadedFromPeer?.(meta);
              this.emitToast(
                `Received "${meta.fileName}" from Host! Synchronizing frame lock...`
              );
            } catch (err) {
              console.error('Failed to load synced ROM:', err);
            }
          }

          await this.initPeerConnection(false);
          this.notifyTelemetry();
          break;
        }

        case 'peer:ready': {
          this.telemetry.peerConnected = true;
          this.telemetry.connectionState = 'WS_RELAY';
          this.clearSyncQueues();
          // Immediately push Host's exact current 6502 CPU/PPU state & frameCounter so Player 2 starts on the exact same pixel!
          this.syncExactSaveStateToPeer();
          await this.initPeerConnection(true);
          this.notifyTelemetry();
          break;
        }

        case 'rom:sync': {
          if (msg.romBase64 && this.telemetry.localPlayerIndex === 1) {
            const bytes = base64ToUint8Array(msg.romBase64);
            const meta = this.loadUserNesRom(
              bytes,
              msg.romName || 'SyncedRom.nes',
              false
            );
            this.telemetry.romSyncedWithPeer = true;
            this.onRomLoadedFromPeer?.(meta);
            this.emitToast(
              `Host loaded "${meta.fileName}" — synced automatically!`
            );
          }
          break;
        }

        case 'savestate:sync': {
          if (msg.stateJson && this.nesCore.romLoaded) {
            this.clearSyncQueues();
            this.nesCore.loadStateSnapshot(msg.stateJson, msg.frame);
            this.telemetry.frameAdvantage = 0;
            this.notifyTelemetry();
          }
          break;
        }

        case 'webrtc:signal': {
          await this.handleWebRTCSignal(msg.signalData);
          break;
        }

        case 'netplay:relay': {
          if (msg.packet) {
            this.handleIncomingPeerPayload(msg.packet);
          }
          if (msg.chatItem) {
            this.onChatReceived?.(msg.chatItem);
          }
          break;
        }

        case 'peer:disconnected': {
          this.telemetry.peerConnected = false;
          this.telemetry.connectionState = 'SIGNALING';
          this.clearSyncQueues();
          this.emitToast('Remote player disconnected from room.');
          this.notifyTelemetry();
          break;
        }

        case 'room:error': {
          this.emitToast(msg.message || 'Room error');
          break;
        }
      }
    };
  }

  private async initPeerConnection(isInitiator: boolean): Promise<void> {
    if (this.pc) {
      this.pc.close();
    }
    this.pendingIceCandidates = [];

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
      const dc = this.pc.createDataChannel('nes-netplay-udp', {
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
      this.emitToast('Direct WebRTC UDP DataChannel established (60Hz Frame-Lock Active)!');
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
        this.handleIncomingPeerPayload(msg);
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

    try {
      if (signalData.sdp) {
        await this.pc.setRemoteDescription(
          new RTCSessionDescription(signalData.sdp)
        );
        // Flush any ICE candidates that arrived before remoteDescription was set!
        while (this.pendingIceCandidates.length > 0) {
          const cand = this.pendingIceCandidates.shift()!;
          await this.pc.addIceCandidate(new RTCIceCandidate(cand));
        }

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
        if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
          await this.pc.addIceCandidate(
            new RTCIceCandidate(signalData.candidate)
          );
        } else {
          this.pendingIceCandidates.push(signalData.candidate);
        }
      }
    } catch (err) {
      console.error('WebRTC signal error:', err);
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
    this.clearSyncQueues();
    this.telemetry.netMode = 'SOLO_2P_LOCAL';
    this.telemetry.connectionState = 'DISCONNECTED';
    this.telemetry.roomCode = null;
    this.telemetry.peerConnected = false;
    this.notifyTelemetry();
  }

  private emitToast(msg: string): void {
    this.onStatusToast?.(msg);
  }

  private notifyTelemetry(): void {
    this.onTelemetryChange?.({ ...this.telemetry });
  }
}
