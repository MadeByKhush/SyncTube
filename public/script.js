// Socket Connection
// Since we are serving frontend from the same server, we can just call io()
// This automatically connects to the host that served the page.
const socket = io();

// Sound Asset (Custom File)
const notificationAudio = new Audio("/sounds/notification.mp3");
notificationAudio.volume = 0.5;

function playNotificationSound() {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(error => {
        // Autoplay was prevented. User needs to interact with document first.
        // console.log("Audio autoplay prevented:", error);
    });
}

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
const usernameModal = document.getElementById('username-modal');
const usernameInput = document.getElementById('username-input');
const startBtn = document.getElementById('start-btn');

// State
let player;
let roomId;
let username;
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

    console.log(`[Frontend] Init: roomId=${roomId}`);

    // Check LocalStorage for Username
    const storedName = localStorage.getItem('synctube_username');
    if (storedName) {
        username = storedName;
        joinRoom();
    } else {
        usernameModal.classList.add('active');
        usernameInput.focus();
    }
}

// Modal Logic
usernameInput.addEventListener('input', () => {
    startBtn.disabled = usernameInput.value.trim().length === 0;
});

startBtn.addEventListener('click', () => {
    const name = usernameInput.value.trim();
    if (name) {
        username = name;
        localStorage.setItem('synctube_username', username);
        usernameModal.classList.remove('active');
        joinRoom();
    }
});

usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !startBtn.disabled) startBtn.click();
});

function joinRoom() {
    console.log(`[Frontend] Joining Room: ${roomId} as ${username}`);
    socket.emit('join-room', { roomId, username });
}

// 2. Socket Event Listeners
socket.on('connect', () => {
    console.log('[Frontend] Socket Connected:', socket.id);
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
    console.log('[Frontend] new-chat received:', data);
    const isMine = data.id === socket.id;
    appendMessage(data.message, isMine ? 'mine' : 'others', data.sender);

    if (!isMine) {
        playNotificationSound();
    }
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

// Chat Colors
const userColors = new Map();
const colors = [
    '#F87171', // Red
    '#FB923C', // Orange
    '#FACC15', // Yellow
    '#4ADE80', // Green
    '#60A5FA', // Blue
    '#C084FC', // Purple
    '#F472B6'  // Pink
];

function getUserColor(username) {
    if (!userColors.has(username)) {
        // Simple hash or random selection ensuring no collision if possible is hard without knowing all users.
        // We will pick random from palette based on name hash to be consistent per-session per-name.
        let hash = 0;
        for (let i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % colors.length;
        userColors.set(username, colors[index]);
    }
    return userColors.get(username);
}

// Chat UI
function appendMessage(text, type, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}`;

    const senderSpan = document.createElement('div');
    senderSpan.className = 'sender';

    if (type === 'others') {
        senderSpan.textContent = sender || 'Anonymous';
        senderSpan.style.color = getUserColor(sender || 'Anonymous');
    } else {
        senderSpan.textContent = 'You';
        // 'You' color is handled in CSS (white/light)
    }

    msgDiv.appendChild(senderSpan);

    // Message Text
    const textNode = document.createElement('div');
    textNode.textContent = text;
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

    // 1. Ensure Username
    if (!username) {
        username = localStorage.getItem('synctube_username');
    }
    if (!username) {
        showToast("Please enter your name first");
        return;
    }

    // 2. Ensure Room ID
    if (!roomId) {
        console.error("Chat Error: Room ID missing");
        showToast("Error: Not connected to a room");
        return;
    }

    // 3. Send
    if (text) {
        console.log(`Sending Chat: ${username} -> ${roomId}: ${text}`);
        socket.emit('chat-message', {
            roomId: roomId,
            message: text,
            sender: username
        });

        // 4. Clear Input ONLY after sending
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

// --- Video Call Logic ---
let localStream;
let peerConnection;
let isCallActive = false;
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

const videoCallArea = document.getElementById('video-call-area');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const vcStartBtn = document.getElementById('vc-start-btn');
const vcEndBtn = document.getElementById('vc-end-btn');
const vcMuteBtn = document.getElementById('vc-mute-btn');
const vcCamBtn = document.getElementById('vc-cam-btn');
const remoteLabel = document.getElementById('remote-label');

// Start Call (Initializes Local Stream & Signals Join)
vcStartBtn.addEventListener('click', async () => {
    if (isCallActive) return;
    try {
        await startLocalStream();
        videoCallArea.classList.remove('hidden');
        socket.emit('vc-join', roomId);
        isCallActive = true;
        showToast('Joined Video Call. Waiting for others...');
    } catch (err) {
        console.error('Error starting call:', err);
        showToast('Could not access camera/mic');
    }
});

async function startLocalStream() {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
}

// 1. Signaling: User Joined -> Create Offer
socket.on('vc-user-joined', async ({ id, username }) => {
    if (!isCallActive) return; // Only if I am also in VC logic
    remoteLabel.textContent = username;
    showToast(`${username} joined call. Connecting...`);
    createPeerConnection(id);

    // Add local tracks
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Create Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('vc-offer', { offer, roomId });
});

// 2. Signaling: Receive Offer -> Create Answer
socket.on('vc-offer', async ({ offer, id }) => {
    if (!isCallActive) {
        // Auto-join if someone calls? Or prompt? For now, we assume user clicked 'Start' to be "online" in VC.
        // But requirement says "Auto-connect when second user joins VC".
        // If I am NOT in call yet, I should probably join automatically or ignore?
        // Let's assume both must press "Video Call" to enter the "Lobby", then they connect.
        return;
    }
    createPeerConnection(id);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('vc-answer', { answer, roomId });
});

// 3. Signaling: Receive Answer
socket.on('vc-answer', async ({ answer }) => {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(answer);
    }
});

// 4. Signaling: ICE Candidate
socket.on('vc-ice-candidate', async ({ candidate }) => {
    if (peerConnection) {
        await peerConnection.addIceCandidate(candidate);
    }
});

function createPeerConnection(targetId) {
    if (peerConnection) peerConnection.close();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('vc-ice-candidate', { candidate: event.candidate, roomId });
        }
    };

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected') {
            remoteVideo.srcObject = null;
        }
    };
}

// Controls
vcEndBtn.addEventListener('click', endCall);

function endCall() {
    isCallActive = false;
    videoCallArea.classList.add('hidden');

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    socket.emit('vc-end', roomId);
    remoteVideo.srcObject = null;
}

socket.on('vc-end', () => {
    showToast('Peer ended the call');
    remoteVideo.srcObject = null;
    if (peerConnection) peerConnection.close();
    // Keep local stream active or close? Usually keep local until I leave.
});

// Mute / Cam
vcMuteBtn.addEventListener('click', () => {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        vcMuteBtn.textContent = audioTrack.enabled ? '🎤' : '🔇';
    }
});

vcCamBtn.addEventListener('click', () => {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        vcCamBtn.textContent = videoTrack.enabled ? '📷' : '🚫';
    }
});

// PiP / Fullscreen Handling
document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        // Enforce PiP if call is active
        if (isCallActive) videoCallArea.classList.add('video-pip');
    } else {
        videoCallArea.classList.remove('video-pip');
    }
});

// Run Init
init();
