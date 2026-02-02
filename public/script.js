// Socket Connection
// Since we are serving frontend from the same server, we can just call io()
// This automatically connects to the host that served the page.
const socket = io();

// DOM Elements
const videoUrlInput = document.getElementById('video-url-input');
const watchBtn = document.getElementById('watch-btn');
const inviteBtn = document.getElementById('invite-btn');
const placeholderOverlay = document.getElementById('placeholder-overlay');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const connectionStatus = document.getElementById('connection-status');
const toastContainer = document.getElementById('toast-container');

// State
let player;
let roomId;
let isRemoteUpdate = false;
let currentVideoId = null;

// Helper: Generate ID
function generateId() {
    return Math.random().toString(36).substring(2, 8);
}

// Helper: Toast Notification
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Helper: Parse YouTube ID
function getYouTubeID(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

// 1. Initialization & Room Management
function init() {
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('room');

    if (!roomId) {
        roomId = generateId();
        const newUrl = `${window.location.pathname}?room=${roomId}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
    }

    console.log(`Joining Room: ${roomId}`);
    socket.emit('join-room', roomId);
}

// 2. Socket Event Listeners
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.add('connected');
    connectionStatus.classList.remove('connecting');
});

socket.on('room-state', (state) => {
    if (state.videoId) {
        loadVideo(state.videoId);
        // If state says playing, we might auto-play, but browsers block unmuted autoplay usually.
        // We'll sync state once player is ready.
    }
});

socket.on('update-video', (data) => {
    loadVideo(data.videoId);
    showToast('Host changed the video');
});

socket.on('sync-update', (data) => {
    if (!player || !player.seekTo) return;

    isRemoteUpdate = true;
    const tolerance = 0.5; // seconds
    const currentTime = player.getCurrentTime();

    // Sync Time if drifted
    if (Math.abs(currentTime - data.timestamp) > tolerance) {
        player.seekTo(data.timestamp, true);
    }

    // Sync State
    if (data.isPlaying) {
        player.playVideo();
    } else {
        player.pauseVideo();
    }

    // Release lock after a short delay to allow events to fire
    setTimeout(() => {
        isRemoteUpdate = false;
    }, 500);
});

socket.on('new-chat', (data) => {
    appendMessage(data.message, data.id === socket.id ? 'mine' : 'others', data.sender);
});

// 3. YouTube Player API
// Load the IFrame Player API code asynchronously.
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', // Start empty
        playerVars: {
            'playsinline': 1,
            'rel': 0,
            'modestbranding': 1
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    if (currentVideoId) {
        event.target.loadVideoById(currentVideoId);
    }
}

function onPlayerStateChange(event) {
    if (isRemoteUpdate) return;

    // YT.PlayerState.PLAYING = 1
    // YT.PlayerState.PAUSED = 2
    // YT.PlayerState.BUFFERING = 3

    if (event.data === YT.PlayerState.PLAYING) {
        emitSync(true);
    } else if (event.data === YT.PlayerState.PAUSED) {
        emitSync(false);
    }
    // We can also handle buffering if needed, but often buffering leads to pause/play events.
}

function emitSync(isPlaying) {
    socket.emit('sync-action', {
        roomId,
        type: isPlaying ? 'play' : 'pause',
        timestamp: player.getCurrentTime(),
        isPlaying
    });
}

function loadVideo(id) {
    currentVideoId = id;
    if (player && player.loadVideoById) {
        player.loadVideoById(id);
        placeholderOverlay.classList.remove('active');
    }
}

// 4. UI Support
watchBtn.addEventListener('click', () => {
    const url = videoUrlInput.value;
    const id = getYouTubeID(url);
    if (id) {
        socket.emit('change-video', { roomId, videoId: id });
        videoUrlInput.value = '';
    } else {
        showToast('Invalid YouTube URL');
    }
});

videoUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') watchBtn.click();
});

// Chat UI
function appendMessage(text, type, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}`;

    // If others, show sender name (simplified)
    if (type === 'others') {
        const senderSpan = document.createElement('div');
        senderSpan.className = 'sender';
        senderSpan.textContent = 'Friend';
        msgDiv.appendChild(senderSpan);
    }

    const textNode = document.createTextNode(text);
    msgDiv.appendChild(textNode);

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const text = chatInput.value.trim();
    if (text) {
        socket.emit('chat-message', { roomId, message: text });
        chatInput.value = '';
    }
}

// Invite UI
inviteBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
        showToast('Link copied to clipboard!');
    }).catch(err => {
        showToast('Failed to copy link');
    });
});

// Run Init
init();
