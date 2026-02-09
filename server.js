const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// ============================================================
// SAFE HARDENING: Lenient Validation + Soft Rate Limiting
// Philosophy: Log & Ignore bad events, NEVER break normal users
// ============================================================

// --- Lenient Validation (Shape & Type only, no hard failures) ---
const MAX_USERNAME = 24;
const MAX_CHAT = 300;
const MAX_ROOM_ID = 32;

function isOk(val, type) {
    return val !== undefined && val !== null && typeof val === type;
}

function validateJoin(data) {
    if (!isOk(data?.roomId, 'string') || data.roomId.length > MAX_ROOM_ID) return false;
    if (!isOk(data?.username, 'string') || data.username.length > MAX_USERNAME) return false;
    return true;
}

function validateChat(data) {
    if (!isOk(data?.roomId, 'string')) return false;
    if (!isOk(data?.message, 'string') || data.message.length === 0 || data.message.length > MAX_CHAT) return false;
    return true;
}

function validateSync(data) {
    if (!isOk(data?.roomId, 'string')) return false;
    if (!isOk(data?.timestamp, 'number') || data.timestamp < 0) return false;
    if (typeof data?.isPlaying !== 'boolean') return false;
    return true;
}

function validateVideo(data) {
    if (!isOk(data?.roomId, 'string')) return false;
    if (!isOk(data?.videoId, 'string') || data.videoId.length < 5) return false;
    return true;
}

// --- Chat Sanitization (Escape HTML, prevent XSS) ---
function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Soft Rate Limiter (Ignore excess, never disconnect) ---
const rateLimits = new Map();

function softRateLimit(socketId, event, maxPerSec) {
    const key = `${socketId}:${event}`;
    const now = Date.now();
    const entry = rateLimits.get(key);

    if (!entry || now > entry.reset) {
        rateLimits.set(key, { count: 1, reset: now + 1000 });
        return true; // Allowed
    }
    if (entry.count < maxPerSec) {
        entry.count++;
        return true; // Allowed
    }
    return false; // Exceeded - will be ignored (not blocked)
}

function cleanupRateLimits(socketId) {
    for (const key of rateLimits.keys()) {
        if (key.startsWith(socketId)) rateLimits.delete(key);
    }
}

// --- Room & User Caps ---
const MAX_ROOMS = 1000;
const MAX_USERS_PER_ROOM = 50;

// --- Stats (for /health endpoint) ---
let stats = { rateLimitIgnored: 0, invalidIgnored: 0, roomsCreated: 0 };

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io Setup
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity in MVP, restrict in prod if needed
        methods: ["GET", "POST"]
    }
});

// In-memory Room State
// Structure: { roomId: { videoId: string | null, isPlaying: boolean, timestamp: number, lastUpdate: number } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('socket connected', socket.id);

    // Helper: Broadcast User Count
    const broadcastUserCount = (roomId) => {
        const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        io.to(roomId).emit('update-user-count', { count });
    };

    socket.on('join-room', (data) => {
        // Soft validation - ignore invalid, log only
        if (!validateJoin(data)) {
            stats.invalidIgnored++;
            console.log(`[Ignored] Invalid join-room from ${socket.id}`);
            return;
        }
        const { roomId, username } = data;

        // Room cap check - only for NEW rooms
        const isNewRoom = !rooms[roomId];
        if (isNewRoom && Object.keys(rooms).length >= MAX_ROOMS) {
            console.log(`[Limit] MAX_ROOMS reached, ignoring new room`);
            return socket.emit('error', { message: 'Server busy, try later.' });
        }

        // User cap check
        const currentUsers = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        if (currentUsers >= MAX_USERS_PER_ROOM) {
            console.log(`[Limit] Room ${roomId} full`);
            return socket.emit('error', { message: 'Room is full.' });
        }

        // === ORIGINAL LOGIC (unchanged) ===
        console.log(`[Server] User ${username} joining room ${roomId}`);
        socket.join(roomId);
        socket.data.username = username;
        socket.data.roomId = roomId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                videoId: null,
                isPlaying: false,
                timestamp: 0,
                lastUpdate: Date.now(),
                sessionStartTime: Date.now(),
                hostSocketId: socket.id // Track host for video control
            };
            stats.roomsCreated++;
        }

        const userCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        socket.emit('room-state', {
            ...rooms[roomId],
            userCount
        });

        socket.to(roomId).emit('system-message', {
            type: 'system',
            message: `${sanitize(username)} joined your party 🎉`
        });

        broadcastUserCount(roomId);
    });

    socket.on('disconnect', () => {
        console.log('socket disconnected', socket.id);
        cleanupRateLimits(socket.id); // Cleanup rate limiter

        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            broadcastUserCount(roomId);

            // Clean up room if empty
            const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
            if (count === 0) {
                console.log(`[Server] Room ${roomId} empty. Deleting.`);
                delete rooms[roomId];
            }
        }
    });

    socket.on('change-video', (data) => {
        if (!validateVideo(data)) {
            stats.invalidIgnored++;
            return;
        }
        const { roomId, videoId } = data;
        if (!rooms[roomId]) return;

        // Host-only check for video changes (friendly mode)
        if (rooms[roomId].hostSocketId && rooms[roomId].hostSocketId !== socket.id) {
            console.log(`[Blocked] Non-host tried to change video`);
            return socket.emit('error', { message: 'Only host can change video.' });
        }

        rooms[roomId].videoId = videoId;
        rooms[roomId].isPlaying = true;
        rooms[roomId].timestamp = 0;
        rooms[roomId].lastUpdate = Date.now();

        io.to(roomId).emit('update-video', {
            videoId: videoId,
            isPlaying: true,
            timestamp: 0
        });
    });

    socket.on('sync-action', (data) => {
        if (!validateSync(data)) {
            stats.invalidIgnored++;
            return;
        }
        const { roomId, type, timestamp, isPlaying } = data;
        if (!rooms[roomId]) return;

        // Soft rate limit: 3 sync events per second (prevents griefing)
        if (!softRateLimit(socket.id, 'sync', 3)) {
            stats.rateLimitIgnored++;
            return; // Silently ignore, don't block
        }

        rooms[roomId].isPlaying = isPlaying;
        rooms[roomId].timestamp = timestamp;
        rooms[roomId].lastUpdate = Date.now();

        socket.to(roomId).emit('sync-update', {
            type,
            timestamp,
            isPlaying
        });
    });

    socket.on('chat-message', (data) => {
        if (!validateChat(data)) {
            stats.invalidIgnored++;
            return;
        }
        const { roomId, message, sender } = data;
        if (!rooms[roomId]) return;

        // Soft rate limit: 2 chat messages per second
        if (!softRateLimit(socket.id, 'chat', 2)) {
            stats.rateLimitIgnored++;
            return; // Silently ignore
        }

        // CRITICAL: Sanitize all user input to prevent XSS
        const safeSender = sanitize(sender || socket.data.username || 'Anonymous');
        const safeMessage = sanitize(message);

        console.log(`[Server] Chat from ${safeSender}: ${safeMessage.substring(0, 50)}...`);
        io.to(roomId).emit('new-chat', {
            sender: safeSender,
            message: safeMessage,
            id: socket.id
        });
    });

    // --- Video Call Signaling (1-to-1 Request Handshake) ---

    // 1. Caller initiates Call Request
    socket.on('call-user', ({ roomId }) => {
        // Broadcast "Incoming Call" to room (except sender)
        // In a real app with >2 users, you'd target a specific socketId. 
        // For SyncTube MVP (assumed small groups), we broadcast to room.
        console.log(`[VC] Call Request from ${socket.data.username}`);
        socket.to(roomId).emit('call-request', {
            callerId: socket.id,
            callerName: socket.data.username
        });
    });

    // 2. Callee Accepts Call
    socket.on('call-accepted', ({ roomId, callerId }) => {
        console.log(`[VC] Call Accepted by ${socket.data.username}`);

        // Notify the Caller to start WebRTC
        io.to(callerId).emit('call-accepted', {
            accepterId: socket.id,
            accepterName: socket.data.username
        });
    });

    // 3. Callee Rejects Call
    socket.on('call-rejected', ({ roomId, callerId }) => {
        console.log(`[VC] Call Rejected by ${socket.data.username}`);
        io.to(callerId).emit('call-rejected', {
            rejecterName: socket.data.username
        });
    });

    // 4. WebRTC Signaling (Offer, Answer, ICE)
    socket.on('vc-offer', ({ offer, roomId }) => {
        socket.to(roomId).emit('vc-offer', { offer, id: socket.id });
    });

    socket.on('vc-answer', ({ answer, roomId }) => {
        socket.to(roomId).emit('vc-answer', { answer, id: socket.id });
    });

    socket.on('vc-ice-candidate', ({ candidate, roomId }) => {
        socket.to(roomId).emit('vc-ice-candidate', { candidate, id: socket.id });
    });

    // 5. End Call
    socket.on('vc-end', (roomId) => {
        console.log(`[VC] User ${socket.data.username} ended call`);
        socket.to(roomId).emit('vc-end', { id: socket.id });
    });

    socket.on('disconnect', () => {
        // console.log('User disconnected:', socket.id);
        // If in call, could trigger auto-hangup if we tracked state server-side
    });
});

// ============================================================
// OBSERVABILITY: Health Check Endpoint
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        activeRooms: Object.keys(rooms).length,
        activeSockets: io.engine?.clientsCount || 0,
        stats: stats
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`[Hardening] Safe mode: Validation ✓ | Rate Limits ✓ | Sanitization ✓ | Host-only video ✓`);
});
