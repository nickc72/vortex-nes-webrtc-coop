import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RoomPeer {
  ws: WebSocket;
  playerIndex: 0 | 1;
  peerId: string;
}

interface RoomState {
  code: string;
  romName: string;
  romBase64: string | null;
  romCrc32: string;
  peers: RoomPeer[];
  createdAt: number;
}

const rooms = new Map<string, RoomState>();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function startServer() {
  const app = express();
  const server = createHttpServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      activeRooms: rooms.size,
      serverTime: Date.now(),
    });
  });

  app.get('/api/rooms', (_req, res) => {
    const publicRooms = Array.from(rooms.values())
      .filter((r) => r.peers.length === 1)
      .map((r) => ({
        code: r.code,
        romName: r.romName,
        romCrc32: r.romCrc32,
        players: r.peers.length,
        createdAt: r.createdAt,
      }));
    res.json({ rooms: publicRooms });
  });

  // Attach WebSocket signaling, ROM transfer & fallback relay server (allow up to 12MB messages for .nes ROMs & save states)
  const wss = new WebSocketServer({
    server,
    path: '/ws-signaling',
    maxPayload: 12 * 1024 * 1024,
  });

  wss.on('connection', (ws: WebSocket) => {
    let currentRoomCode: string | null = null;
    let currentPlayerIndex: 0 | 1 = 0;
    const peerId = Math.random().toString(36).substring(2, 10);

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        switch (msg.type) {
          case 'room:create': {
            let code = generateRoomCode();
            while (rooms.has(code)) {
              code = generateRoomCode();
            }
            currentRoomCode = code;
            currentPlayerIndex = 0;

            rooms.set(code, {
              code,
              romName: msg.romName || 'Built-In 6502 Test ROM',
              romBase64: msg.romBase64 || null,
              romCrc32: msg.romCrc32 || '00000000',
              peers: [{ ws, playerIndex: 0, peerId }],
              createdAt: Date.now(),
            });

            ws.send(
              JSON.stringify({
                type: 'room:created',
                code,
                playerIndex: 0,
                peerId,
              })
            );
            break;
          }

          case 'room:join': {
            const code = String(msg.code || '').trim().toUpperCase();
            const room = rooms.get(code);
            if (!room) {
              ws.send(
                JSON.stringify({
                  type: 'room:error',
                  message: `Room ${code} not found.`,
                })
              );
              return;
            }
            if (room.peers.length >= 2) {
              ws.send(
                JSON.stringify({
                  type: 'room:error',
                  message: `Room ${code} is already full (2/2 players).`,
                })
              );
              return;
            }

            currentRoomCode = code;
            currentPlayerIndex = 1;
            room.peers.push({ ws, playerIndex: 1, peerId });

            // Confirm to joining player (Player 2) and automatically deliver Host's uploaded .nes ROM!
            ws.send(
              JSON.stringify({
                type: 'room:joined',
                code,
                playerIndex: 1,
                romName: room.romName,
                romBase64: room.romBase64,
                romCrc32: room.romCrc32,
                peerId,
              })
            );

            // Notify host (Player 1) that Player 2 joined so WebRTC Offer and frame sync can begin
            const host = room.peers.find((p) => p.playerIndex === 0);
            if (host && host.ws.readyState === WebSocket.OPEN) {
              host.ws.send(
                JSON.stringify({
                  type: 'peer:ready',
                  code,
                  remotePeerId: peerId,
                })
              );
            }
            break;
          }

          case 'webrtc:signal': {
            if (!currentRoomCode) return;
            const room = rooms.get(currentRoomCode);
            if (!room) return;
            for (const peer of room.peers) {
              if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(
                  JSON.stringify({
                    type: 'webrtc:signal',
                    fromPlayer: currentPlayerIndex,
                    signalData: msg.signalData,
                  })
                );
              }
            }
            break;
          }

          case 'netplay:relay': {
            if (!currentRoomCode) return;
            const room = rooms.get(currentRoomCode);
            if (!room) return;
            for (const peer of room.peers) {
              if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(
                  JSON.stringify({
                    type: 'netplay:relay',
                    packet: msg.packet,
                  })
                );
              }
            }
            break;
          }

          case 'rom:sync': {
            if (!currentRoomCode) return;
            const room = rooms.get(currentRoomCode);
            if (!room) return;
            room.romName = msg.romName || room.romName;
            room.romBase64 = msg.romBase64 || room.romBase64;
            room.romCrc32 = msg.romCrc32 || room.romCrc32;

            for (const peer of room.peers) {
              if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(
                  JSON.stringify({
                    type: 'rom:sync',
                    romName: room.romName,
                    romBase64: room.romBase64,
                    romCrc32: room.romCrc32,
                  })
                );
              }
            }
            break;
          }

          case 'savestate:sync': {
            if (!currentRoomCode) return;
            const room = rooms.get(currentRoomCode);
            if (!room) return;
            for (const peer of room.peers) {
              if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(
                  JSON.stringify({
                    type: 'savestate:sync',
                    frame: msg.frame,
                    stateJson: msg.stateJson,
                  })
                );
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error('Signaling message error:', err);
      }
    });

    ws.on('close', () => {
      if (currentRoomCode && rooms.has(currentRoomCode)) {
        const room = rooms.get(currentRoomCode)!;
        room.peers = room.peers.filter((p) => p.ws !== ws);
        if (room.peers.length === 0) {
          rooms.delete(currentRoomCode);
        } else {
          for (const remaining of room.peers) {
            if (remaining.ws.readyState === WebSocket.OPEN) {
              remaining.ws.send(
                JSON.stringify({
                  type: 'peer:disconnected',
                  playerIndex: currentPlayerIndex,
                })
              );
            }
          }
        }
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`NES WebRTC Netplay & Signaling Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
