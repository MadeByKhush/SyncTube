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

// Session Timer State
let sessionStartTime = null;

socket.on('room-state', (state) => {
    if (state.userCount > 1) unlockVideoCall();
    updateViewerCount(state.userCount); // Initial set

    // Set Session Start Time
    if (state.sessionStartTime) {
        sessionStartTime = state.sessionStartTime;
        updateSessionTimer();
    }

    if (state.videoId) {
        loadVideo(state.videoId);
    }
});

socket.on('update-user-count', ({ count }) => {
    updateViewerCount(count);
    if (count > 1) unlockVideoCall();
});

// Helper: Update Viewer DOM
function updateViewerCount(count) {
    const el = document.getElementById('viewer-count');
    if (el) {
        el.innerText = `👁 ${count} watching`;
    }
}

// Session Timer Logic
function updateSessionTimer() {
    if (!sessionStartTime) return;

    const diff = Date.now() - sessionStartTime;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);

    const el = document.getElementById('session-timer');
    if (!el) return;

    if (minutes < 1) {
        el.innerText = "🕒 Started just now";
    } else if (hours < 1) {
        el.innerText = `🕒 Started ${minutes} minutes ago`;
    } else {
        el.innerText = `🕒 Started ${hours} hours ago`;
    }
}

// Update timer every minute
setInterval(updateSessionTimer, 60000);

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
    // Dynamic Title Update
    if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.UNSTARTED || event.data === YT.PlayerState.CUED) {
        updateVideoTitle();
    }

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
    // Message Div
    const msgDiv = document.createElement('div');

    if (type === 'system') {
        msgDiv.className = 'message system';
        msgDiv.textContent = text;
        // No sender span for system messages
    } else {
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
    }

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// System Message Listener
socket.on('system-message', (data) => {
    appendMessage(data.message, 'system');
    unlockVideoCall();
});

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

// Helper: Update Video Title
function updateVideoTitle() {
    if (!player || !player.getVideoData) return;

    const data = player.getVideoData();
    const title = data && data.title ? data.title.trim() : "";
    const titleElement = document.getElementById("video-title");

    if (titleElement) {
        titleElement.innerText = title.length ? title : "Now Playing";
    }
}

// --- Invite UI ---
const inviteModal = document.getElementById('invite-modal');
const closeInviteBtn = document.getElementById('close-invite-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const inviteLinkInput = document.getElementById('invite-link-input');

// Logic to reveal VC Button when others are present
function unlockVideoCall() {
    if (vcStartBtn.classList.contains('hidden')) {
        vcStartBtn.classList.remove('hidden');
        showToast("Friend detected! Video Call enabled 📹");
    }
}

// Open Invite Modal
inviteBtn.addEventListener('click', () => {
    inviteLinkInput.value = window.location.href;
    inviteModal.classList.add('active');

    // Update Social Links
    const url = encodeURIComponent(window.location.href);
    const text = encodeURIComponent("Join my SyncTube watch party! 🎬");

    document.getElementById('share-wa').href = `https://wa.me/?text=${text}%20${url}`;
    document.getElementById('share-fb').href = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
    document.getElementById('share-x').href = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
    document.getElementById('share-email').href = `mailto:?subject=${text}&body=${url}`;
});

// Close Invite Modal
closeInviteBtn.addEventListener('click', () => {
    inviteModal.classList.remove('active');
});

inviteModal.addEventListener('click', (e) => {
    if (e.target === inviteModal) inviteModal.classList.remove('active');
});

// Copy Link Logic
copyLinkBtn.addEventListener('click', () => {
    inviteLinkInput.select();
    inviteLinkInput.setSelectionRange(0, 99999); // For mobile
    navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
        const originalText = copyLinkBtn.textContent;
        copyLinkBtn.textContent = 'Copied!';
        copyLinkBtn.style.background = '#22c55e';
        setTimeout(() => {
            copyLinkBtn.textContent = originalText;
            copyLinkBtn.style.background = '';
        }, 2000);
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

// Request Modal Elements
const callRequestModal = document.getElementById('call-request-modal');
const callerNameDisplay = document.getElementById('caller-name-display');
const acceptCallBtn = document.getElementById('accept-call-btn');
const rejectCallBtn = document.getElementById('reject-call-btn');

let currentCallerId = null;

// 1. Start Call (Sends Request)
vcStartBtn.addEventListener('click', () => {
    if (isCallActive) return;
    // Send Request
    socket.emit('call-user', { roomId });
    showToast('Calling room...');
});

// 2. Incoming Call Handling
socket.on('call-request', ({ callerId, callerName }) => {
    if (isCallActive) return; // Busy
    currentCallerId = callerId;
    callerNameDisplay.textContent = callerName;
    callRequestModal.classList.add('active');

    // Play Ringtone (optional, placeholder)
    // playRingtone();
});

// 3. Accept/Reject Logic
acceptCallBtn.addEventListener('click', async () => {
    callRequestModal.classList.remove('active');
    await startLocalStream();

    videoCallArea.classList.remove('hidden');
    isCallActive = true;

    socket.emit('call-accepted', { roomId, callerId: currentCallerId });
});

rejectCallBtn.addEventListener('click', () => {
    callRequestModal.classList.remove('active');
    socket.emit('call-rejected', { roomId, callerId: currentCallerId });
    currentCallerId = null;
});

// 4. Response Handlers
socket.on('call-accepted', async ({ accepterName, accepterId }) => {
    showToast(`${accepterName} accepted call! Connecting...`);
    await startLocalStream();
    videoCallArea.classList.remove('hidden');
    isCallActive = true;

    // Initiator creates Offer
    createPeerConnection(accepterId);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('vc-offer', { offer, roomId });
});

socket.on('call-rejected', ({ rejecterName }) => {
    showToast(`${rejecterName} rejected the call.`);
    // Reset state if needed
});

async function startLocalStream() {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
}

// Signaling: Offer (Receiver Side)
socket.on('vc-offer', async ({ offer, id }) => {
    if (!isCallActive) return;

    createPeerConnection(id);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('vc-answer', { answer, roomId });
});

// Signaling: Answer (Caller Side)
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
