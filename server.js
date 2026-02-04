const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

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

    socket.on('join-room', ({ roomId, username }) => {
        console.log(`[Server] User ${username} joining room ${roomId}`);
        socket.join(roomId);
        socket.data.username = username;
        socket.data.roomId = roomId; // Store room ID for disconnect handling

        // Initialize room if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = {
                videoId: null,
                isPlaying: false,
                timestamp: 0,
                lastUpdate: Date.now(),
                sessionStartTime: Date.now() // Track when room started
            };
        }

        // Send current state to the joining user
        const userCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        socket.emit('room-state', {
            ...rooms[roomId],
            userCount
        });

        // Broadcast System Message: User Joined
        socket.to(roomId).emit('system-message', {
            type: 'system',
            message: `${username} joined your party 🎉`
        });

        // Update User Count
        broadcastUserCount(roomId);
    });

    socket.on('disconnect', () => {
        console.log('socket disconnected', socket.id);
        const roomId = socket.data.roomId;
        if (roomId) {
            broadcastUserCount(roomId);

            // Clean up room if empty to reset session timer for next group
            const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
            if (count === 0) {
                console.log(`[Server] Room ${roomId} empty. Deleting session.`);
                delete rooms[roomId];
            }
        }
    });

    socket.on('change-video', ({ roomId, videoId }) => {
        if (!rooms[roomId]) return;

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

    socket.on('sync-action', ({ roomId, type, timestamp, isPlaying }) => {
        if (!rooms[roomId]) return;

        // Update room state
        rooms[roomId].isPlaying = isPlaying;
        rooms[roomId].timestamp = timestamp;
        rooms[roomId].lastUpdate = Date.now();

        // Broadcast to everyone ELSE in the room
        socket.to(roomId).emit('sync-update', {
            type, // 'play', 'pause', 'seek'
            timestamp,
            isPlaying
        });
    });

    socket.on('chat-message', ({ roomId, message, sender }) => {
        console.log(`[Server] Chat received from ${sender} in room ${roomId}: ${message}`);
        io.to(roomId).emit('new-chat', {
            sender: sender || socket.data.username || "Anonymous",
            message,
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
