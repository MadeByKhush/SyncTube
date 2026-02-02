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
    // console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);

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
        io.to(roomId).emit('new-chat', {
            sender, // 'You' handling will be on frontend, generic sender ID or name here
            message,
            id: socket.id
        });
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
