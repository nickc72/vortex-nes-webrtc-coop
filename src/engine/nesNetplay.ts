import {
  base64ToUint8Array,
  InesRomMetadata,
  RealNesHardwareCore,
  uint8ArrayToBase64,
} from './nesCore';

export interface NesNetplayPacket {
  frame: number;
  playerIndex: 0 | 1;
  inputs: number[];
  timestamp: number;
  ramChecksum: number;
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

export class NesWebRtcCoordinator {
  public nesCore = new RealNesHardwareCore();
  private rawRomBytes: Uint8Array | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

  private localInputs = new Map<number, number>();
  private remoteInputs = new Map<number, number>();
  private lastKnownRemoteMask = 0;

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

  public loadUserNesRom(bytes: Uint8Array, fileName: string, broadcastToPeer = true): InesRomMetadata {
    const meta = this.nesCore.loadNesRomBytes(bytes, fileName);
    this.rawRomBytes = bytes;
    this.localInputs.clear();
    this.remoteInputs.clear();
    this.lastKnownRemoteMask = 0;
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

  public tickNesFrame(localP1Mask: number, localP2Mask: number): void {
    if (!this.nesCore.romLoaded) return;
    const t0 = performance.now();
    const nextFrame = this.nesCore.frameCounter + 1;

    if (
      this.telemetry.netMode === 'WEBRTC_P2P' &&
      this.telemetry.peerConnected
    ) {
      const myIdx = this.telemetry.localPlayerIndex;
      const myMask = myIdx === 0 ? localP1Mask : localP1Mask || localP2Mask;

      this.localInputs.set(nextFrame, myMask);
      this.sendInputPacket(nextFrame, myIdx);

      const remMask = this.remoteInputs.get(nextFrame) ?? this.lastKnownRemoteMask;
      const p1 = myIdx === 0 ? myMask : remMask;
      const p2 = myIdx === 1 ? myMask : remMask;

      this.nesCore.stepFrame(p1, p2);
    } else {
      this.nesCore.stepFrame(localP1Mask, localP2Mask);
    }

    const dt = performance.now() - t0;
    this.telemetry.frameTimeMs = Number(
      (this.telemetry.frameTimeMs * 0.85 + dt * 0.15).toFixed(2)
    );
    if (nextFrame % 15 === 0) {
      this.notifyTelemetry();
    }
  }

  public sendChatOrCallout(text: string): void {
    const sender: 'P1' | 'P2' = this.telemetry.localPlayerIndex === 0 ? 'P1' : 'P2';
    const item: ChatMessageItem = {
      id: Math.random().toString(36).slice(2),
      sender,
      text,
      timestamp: Date.now(),
    };
    this.onChatReceived?.(item);

    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'chat', item }));
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'netplay:relay',
          chatItem: item,
        })
      );
    }
  }

  public syncExactSaveStateToPeer(): void {
    if (!this.nesCore.romLoaded) return;
    const stateJson = this.nesCore.saveStateSnapshot();
    if (!stateJson) return;

    const payload = JSON.stringify({
      type: 'savestate:sync',
      frame: this.nesCore.frameCounter,
      stateJson,
    });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      this.emitToast('Synced exact NES CPU/PPU state to Player 2!');
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
        const romBase64 = this.rawRomBytes ? uint8ArrayToBase64(this.rawRomBytes) : null;
        this.ws.send(
          JSON.stringify({
            type: 'room:create',
            romName: this.nesCore.romMeta?.fileName || 'Awaiting .nes ROM Upload',
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
          this.emitToast(`Room ${msg.code} created! Share code with Player 2.`);
          this.notifyTelemetry();
          break;
        }

        case 'room:joined': {
          this.telemetry.roomCode = msg.code;
          this.telemetry.localPlayerIndex = 1;
          this.telemetry.peerConnected = true;
          this.telemetry.connectionState = 'WS_RELAY';

          if (msg.romBase64) {
            try {
              const bytes = base64ToUint8Array(msg.romBase64);
              const meta = this.loadUserNesRom(bytes, msg.romName || 'SyncedRom.nes', false);
              this.telemetry.romSyncedWithPeer = true;
              this.onRomLoadedFromPeer?.(meta);
              this.emitToast(`Received "${meta.fileName}" from Host! Ready as Player 2.`);
            } catch (err) {
              console.error('Failed to load synced ROM:', err);
            }
          } else {
            this.emitToast(`Joined Room ${msg.code} as Player 2!`);
          }

          await this.initPeerConnection(false);
          this.notifyTelemetry();
          break;
        }

        case 'peer:ready': {
          this.telemetry.peerConnected = true;
          this.telemetry.connectionState = 'WS_RELAY';
          this.nesCore.resetConsole();
          this.localInputs.clear();
          this.remoteInputs.clear();
          this.emitToast('Player 2 joined! Starting synchronized 2-Player session.');
          await this.initPeerConnection(true);
          this.notifyTelemetry();
          break;
        }

        case 'rom:sync': {
          if (msg.romBase64) {
            const bytes = base64ToUint8Array(msg.romBase64);
            const meta = this.loadUserNesRom(bytes, msg.romName || 'SyncedRom.nes', false);
            this.telemetry.romSyncedWithPeer = true;
            this.onRomLoadedFromPeer?.(meta);
            this.emitToast(`Host loaded "${meta.fileName}" — synced automatically!`);
          }
          break;
        }

        case 'savestate:sync': {
          if (msg.stateJson && this.nesCore.romLoaded) {
            this.nesCore.loadStateSnapshot(msg.stateJson);
            this.nesCore.frameCounter = msg.frame || this.nesCore.frameCounter;
            this.emitToast('Synchronized NES CPU/PPU state with peer.');
          }
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
          if (msg.chatItem) {
            this.onChatReceived?.(msg.chatItem);
          }
          break;
        }

        case 'peer:disconnected': {
          this.telemetry.peerConnected = false;
          this.telemetry.connectionState = 'SIGNALING';
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
      this.emitToast('Direct WebRTC UDP DataChannel established!');
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
        } else if (msg.type === 'chat' && msg.item) {
          this.onChatReceived?.(msg.item);
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

  private sendInputPacket(frame: number, playerIndex: 0 | 1): void {
    const inputs: number[] = [];
    for (let i = 0; i < 8; i++) {
      const f = frame - i;
      if (f < 0) break;
      inputs.push(this.localInputs.get(f) ?? 0);
    }

    const packet: NesNetplayPacket = {
      frame,
      playerIndex,
      inputs,
      timestamp: performance.now(),
      ramChecksum: this.nesCore.computeRamChecksum(),
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

  private receiveRemotePacket(packet: NesNetplayPacket): void {
    this.telemetry.packetsReceived += 1;
    this.telemetry.frameAdvantage = this.nesCore.frameCounter - packet.frame;

    if (packet.inputs.length > 0) {
      this.lastKnownRemoteMask = packet.inputs[0];
    }

    for (let offset = 0; offset < packet.inputs.length; offset++) {
      const f = packet.frame - offset;
      if (f > 0 && !this.remoteInputs.has(f)) {
        this.remoteInputs.set(f, packet.inputs[offset]);
      }
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
