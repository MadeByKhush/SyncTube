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

    socket.on('join-room', ({ roomId, username }) => {
        console.log(`[Server] User ${username} joining room ${roomId}`);
        socket.join(roomId);
        socket.data.username = username;

        // Initialize room if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = {
                videoId: null,
                isPlaying: false,
                timestamp: 0,
                lastUpdate: Date.now()
            };
        }

        // Send current state to the joining user
        socket.emit('room-state', rooms[roomId]);
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

    // --- Video Call Signaling ---

    // User joins VC (Signals they are ready)
    socket.on('vc-join', (roomId) => {
        console.log(`[VC] User ${socket.data.username} joined VC in ${roomId}`);
        // Notify others in room to start connection
        socket.to(roomId).emit('vc-user-joined', {
            id: socket.id,
            username: socket.data.username
        });
    });

    // WebRTC Offer
    socket.on('vc-offer', ({ offer, roomId }) => {
        // Broadcast to room (assuming 1-to-1 or mesh)
        // ideally targeted to specific socket, but for 2-person room, broadcast works
        socket.to(roomId).emit('vc-offer', { offer, id: socket.id });
    });

    // WebRTC Answer
    socket.on('vc-answer', ({ answer, roomId }) => {
        socket.to(roomId).emit('vc-answer', { answer, id: socket.id });
    });

    // ICE Candidate
    socket.on('vc-ice-candidate', ({ candidate, roomId }) => {
        socket.to(roomId).emit('vc-ice-candidate', { candidate, id: socket.id });
    });

    // End Call
    socket.on('vc-end', (roomId) => {
        console.log(`[VC] User ${socket.data.username} ended call`);
        socket.to(roomId).emit('vc-end', { id: socket.id });
    });

    socket.on('disconnect', () => {
        // console.log('User disconnected:', socket.id);
        // Clean up empty rooms logic could go here, but omitted for simplicity
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
