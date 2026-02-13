const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
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
    // Username is verified via Auth Middleware now
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

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase env vars missing");
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Socket.io Setup
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Step 6: Backend Auth Verification
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
        return next(new Error('Authentication error: Token missing'));
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            console.log(`[Auth] Verification failed for socket ${socket.id}:`, error?.message);
            return next(new Error('Authentication error: Invalid token'));
        }

        socket.data.user = user;
        console.log(`[Auth] Verified user: ${user.email}`);
        next();
    } catch (err) {
        console.error("[Auth] Unexpected error:", err);
        next(new Error('Internal Server Error during Auth'));
    }
});

// In-memory Room State
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
        const { roomId } = data;

        // Step 7: Identity Source Switch
        // Securely retrieve username from Auth Middleware
        const user = socket.data.user;
        const username = user.user_metadata.full_name || user.user_metadata.name || user.email.split('@')[0];

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

        // === ORIGINAL LOGIC ===
        console.log(`[Server] User ${username} joining room ${roomId}`);
        socket.join(roomId);
        socket.data.username = username; // Persist for legacy compatibility in other events
        socket.data.roomId = roomId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                videoId: null,
                isPlaying: false,
                timestamp: 0,
                lastUpdate: Date.now(),
                sessionStartTime: Date.now(),
                hostSocketId: socket.id,
                hostUserId: socket.data.user.id // Persist host identity across reconnects
            };
            stats.roomsCreated++;
        } else if (rooms[roomId].hostUserId && rooms[roomId].hostUserId === socket.data.user.id) {
            // Host rejoined with a new socket — update hostSocketId
            rooms[roomId].hostSocketId = socket.id;
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

    // --- Manual Sync (Any user can request) ---
    socket.on('request-sync', (data) => {
        const roomId = data?.roomId;
        if (!roomId || !rooms[roomId]) return;

        socket.emit('force-sync', {
            videoId: rooms[roomId].videoId,
            timestamp: rooms[roomId].timestamp,
            isPlaying: rooms[roomId].isPlaying
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

    // 6. Reconnect Signal (auto-recovery)
    socket.on('vc-reconnect', ({ roomId }) => {
        console.log(`[VC] Reconnect request from ${socket.data.username}`);
        socket.to(roomId).emit('vc-reconnect', { id: socket.id });
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
