// Socket Connection
const socket = io();

// Sound Assets
const notificationAudio = new Audio("/sounds/notification.mp3");
notificationAudio.volume = 0.5;

// Call Ringtone
const callRingtone = new Audio("/sounds/ringtone.mp3");
callRingtone.loop = true;
callRingtone.volume = 1.0;

function playNotificationSound() {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(error => { });
}

// --- DOM Elements ---
// Header & Global
const videoUrlInput = document.getElementById('video-url-input');
const watchBtn = document.getElementById('watch-btn');
const inviteBtn = document.getElementById('invite-btn');
const connectionStatus = document.getElementById('connection-status');
const toastContainer = document.getElementById('toast-container');
const usernameModal = document.getElementById('username-modal');
const usernameInput = document.getElementById('username-input');
const startBtn = document.getElementById('start-btn');
const viewerCountEl = document.getElementById('viewer-count');
const sessionTimerEl = document.getElementById('session-timer');
const videoTitleEl = document.getElementById('video-title');

// Chat
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

// Video Player Wrapper & Overlays
const videoWrapper = document.getElementById('video-player-wrapper');
const placeholderOverlay = document.getElementById('placeholder-overlay');
const clickShield = document.getElementById('click-shield');
const customControls = document.getElementById('custom-controls');

// Custom Controls
const playPauseBtn = document.getElementById('play-pause-btn');
const iconPlay = playPauseBtn.querySelector('.icon-play');
const iconPause = playPauseBtn.querySelector('.icon-pause');

const seekBarContainer = document.querySelector('.seek-bar-container');
const seekSlider = document.getElementById('seek-slider');
const progressFill = document.getElementById('progress-fill');
const bufferBar = document.getElementById('buffer-bar');

const currentTimeEl = document.getElementById('current-time');
const totalDurationEl = document.getElementById('total-duration');

const muteBtn = document.getElementById('mute-btn');
const iconVolHigh = muteBtn.querySelector('.icon-vol-high');
const iconVolMuted = muteBtn.querySelector('.icon-vol-muted');
const volumeSlider = document.getElementById('volume-slider');
const volumeFill = document.getElementById('volume-fill'); // Optional if used in CSS

const fullscreenBtn = document.getElementById('fullscreen-btn');
const iconMaximize = fullscreenBtn.querySelector('.icon-maximize');
const iconMinimize = fullscreenBtn.querySelector('.icon-minimize');

// Video Call
const videoCallArea = document.getElementById('video-call-area');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const vcStartBtn = document.getElementById('vc-start-btn');
const vcEndBtn = document.getElementById('vc-end-btn');
const vcMuteBtn = document.getElementById('vc-mute-btn');
const vcCamBtn = document.getElementById('vc-cam-btn');

// VC State Management
let isMicEnabled = true;
let isCameraEnabled = true;

// Room User Count (for VC gating)
let roomUserCount = 1;

// VC Visibility Control (gated to exactly 2 users)
function updateVCVisibility() {
    if (roomUserCount === 2) {
        vcStartBtn.classList.remove('hidden');
    } else {
        vcStartBtn.classList.add('hidden');
        // If call active and user count changed from 2, end the call
        if (isCallActive) {
            showToast('VC ended: Room must have exactly 2 users');
            endCall();
        }
    }
}

function unlockVideoCall() {
    updateVCVisibility();
}

// --- State ---
let player;
let roomId;
let username;
let isRemoteUpdate = false;
let currentVideoId = null;

let isDragging = false;
let isHoveringControls = false;
let hideControlsTimeout;
let lastVolume = 100;
let isFullscreen = false;


// --- Helper Functions ---
function generateId() {
    return Math.random().toString(36).substring(2, 8);
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function getYouTubeID(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}


// --- Initialization ---
function init() {
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('room');

    if (!roomId) {
        roomId = generateId();
        const newUrl = `${window.location.pathname}?room=${roomId}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
    }

    console.log(`[Frontend] Init: roomId=${roomId}`);

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


// --- Socket Events ---
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.add('connected');
    connectionStatus.classList.remove('connecting');
});

// Session Timer
let sessionStartTime = null;

socket.on('room-state', (state) => {
    if (state.userCount > 1) unlockVideoCall();
    if (viewerCountEl) viewerCountEl.innerText = `👁 ${state.userCount} watching`;
    roomUserCount = state.userCount || 1;
    updateVCVisibility();

    if (state.sessionStartTime) {
        sessionStartTime = state.sessionStartTime;
        updateSessionTimer();
    }

    if (state.videoId) {
        loadVideo(state.videoId);
    }
});

socket.on('update-user-count', ({ count }) => {
    if (viewerCountEl) viewerCountEl.innerText = `👁 ${count} watching`;
    roomUserCount = count;
    updateVCVisibility();
});

function updateSessionTimer() {
    if (!sessionStartTime || !sessionTimerEl) return;
    const diff = Date.now() - sessionStartTime;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);

    if (minutes < 1) {
        sessionTimerEl.innerText = "🕒 Started just now";
    } else if (hours < 1) {
        sessionTimerEl.innerText = `🕒 Started ${minutes} minutes ago`;
    } else {
        sessionTimerEl.innerText = `🕒 Started ${hours} hours ago`;
    }
}
setInterval(updateSessionTimer, 60000);

socket.on('update-video', (data) => {
    loadVideo(data.videoId);
    showToast('Host changed the video');
});

socket.on('sync-update', (data) => {
    if (!player || !player.seekTo) return;

    isRemoteUpdate = true;
    const tolerance = 0.5;
    const currentTime = player.getCurrentTime();

    if (Math.abs(currentTime - data.timestamp) > tolerance) {
        player.seekTo(data.timestamp, true);
    }

    if (data.isPlaying) {
        player.playVideo();
        updatePlayButtonState(true);
    } else {
        player.pauseVideo();
        updatePlayButtonState(false);
    }

    // Force UI Update
    updateProgressBar();

    setTimeout(() => {
        isRemoteUpdate = false;
    }, 500);
});

socket.on('new-chat', (data) => {
    const isMine = data.id === socket.id;
    appendMessage(data.message, isMine ? 'mine' : 'others', data.sender);
    if (!isMine) playNotificationSound();
});


// --- YouTube Player API ---
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: {
            'playsinline': 1,
            'controls': 0, // Hide native controls
            'disablekb': 1, // Disable native keyboard
            'modestbranding': 1,
            'rel': 0,
            'iv_load_policy': 3,
            'fs': 0 // We handle fullscreen
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
    // Start UI Loop
    requestAnimationFrame(animationLoop);
}

function onPlayerStateChange(event) {
    // 1 = PLAYING, 2 = PAUSED
    const state = event.data;
    const isPlaying = (state === YT.PlayerState.PLAYING);

    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.PAUSED) {
        updatePlayButtonState(isPlaying);
    }

    // Update Title
    if (player.getVideoData) {
        const data = player.getVideoData();
        if (data && data.title && videoTitleEl) {
            videoTitleEl.innerText = data.title;
        }
    }

    if (isRemoteUpdate) return;

    if (state === YT.PlayerState.PLAYING) {
        emitSync(true);
    } else if (state === YT.PlayerState.PAUSED) {
        emitSync(false);
    }
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
        // Reset controls state
        updatePlayButtonState(true);
    }
}


// --- Custom Controls Logic ---

// 1. Play/Pause
function togglePlay() {
    if (!player || !player.getPlayerState) return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        updatePlayButtonState(false);
        emitSync(false);
    } else {
        player.playVideo();
        updatePlayButtonState(true);
        emitSync(true);
    }
}

function updatePlayButtonState(isPlaying) {
    if (isPlaying) {
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
    } else {
        iconPlay.classList.remove('hidden');
        iconPause.classList.add('hidden');
    }
}

playPauseBtn.addEventListener('click', togglePlay);
clickShield.addEventListener('click', togglePlay); // Click video to play/pause

// 2. Progress Bar
function animationLoop() {
    if (!isDragging && player && player.getCurrentTime) {
        updateProgressBar();
    }
    requestAnimationFrame(animationLoop);
}

function updateProgressBar() {
    if (!player.getDuration) return;
    const current = player.getCurrentTime();
    const duration = player.getDuration();

    if (duration > 0) {
        const percent = (current / duration) * 100;
        seekSlider.value = percent;
        progressFill.style.width = `${percent}%`;

        // Update Time Display
        currentTimeEl.innerText = formatTime(current);
        totalDurationEl.innerText = formatTime(duration);

        // Update Buffer
        const loaded = player.getVideoLoadedFraction();
        bufferBar.style.width = `${loaded * 100}%`;
    }
}

// Scrubber Interaction
seekSlider.addEventListener('input', () => {
    isDragging = true;
    const val = seekSlider.value;
    const duration = player.getDuration();
    const time = (val / 100) * duration;

    progressFill.style.width = `${val}%`;
    currentTimeEl.innerText = formatTime(time);
});

seekSlider.addEventListener('change', () => {
    isDragging = false;
    const val = seekSlider.value;
    const duration = player.getDuration();
    const time = (val / 100) * duration;

    player.seekTo(time, true);
    emitSync(player.getPlayerState() === YT.PlayerState.PLAYING);
});


// 3. Volume
volumeSlider.addEventListener('input', () => {
    const vol = volumeSlider.value;
    player.setVolume(vol);
    updateVolumeIcon(vol);
    if (vol > 0) {
        player.unMute();
        lastVolume = vol;
    } else {
        player.mute();
    }
});

muteBtn.addEventListener('click', () => {
    if (player.isMuted()) {
        player.unMute();
        player.setVolume(lastVolume || 100);
        volumeSlider.value = lastVolume || 100;
        updateVolumeIcon(lastVolume || 100);
    } else {
        lastVolume = player.getVolume();
        player.mute();
        player.setVolume(0);
        volumeSlider.value = 0;
        updateVolumeIcon(0);
    }
});

function updateVolumeIcon(vol) {
    if (vol == 0) {
        iconVolHigh.classList.add('hidden');
        iconVolMuted.classList.remove('hidden');
    } else {
        iconVolHigh.classList.remove('hidden');
        iconVolMuted.classList.add('hidden');
    }
}





// 5. Fullscreen (Wrapper based)
fullscreenBtn.addEventListener('click', () => {
    toggleFullscreenWrapper();
});

function toggleFullscreenWrapper() {
    if (!document.fullscreenElement) {
        videoWrapper.requestFullscreen().catch(err => {
            console.error(`Error enabling fullscreen: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
}

// Fullscreen Logic: UI & PIP Reparenting
document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    const fsElement = document.fullscreenElement;
    const pip = document.getElementById('video-call-area');

    // 1. Update UI Icons
    if (isFs) {
        iconMaximize.classList.add('hidden');
        iconMinimize.classList.remove('hidden');
        videoWrapper.classList.add('fullscreen-mode');
    } else {
        iconMaximize.classList.remove('hidden');
        iconMinimize.classList.add('hidden');
        videoWrapper.classList.remove('fullscreen-mode');
    }

    // 2. Reparent PIP for Visibility
    if (fsElement) {
        if (fsElement !== pip.parentElement) {
            fsElement.appendChild(pip);
            showToast("Video Call docked to Fullscreen");
        }
    } else {
        // Return to body if not already there
        if (pip.parentElement !== document.body) {
            // Insert before script tag to match index.html placement
            const scriptTag = document.querySelector('script[src="script.js"]');
            document.body.insertBefore(pip, scriptTag);
            // Ensure fixed positioning is respected
            pip.style.position = 'fixed';
        }
    }
});


// 6. Activity Monitor (Auto Hide Controls)
function showControls() {
    customControls.classList.remove('hidden-idle');
    videoWrapper.style.cursor = 'default';
    resetActivityTimer();
}

function hideControls() {
    if (!player) return;
    // Don't hide if paused or if dragging
    if (player.getPlayerState() === YT.PlayerState.PAUSED) return;
    if (isDragging) return;

    customControls.classList.add('hidden-idle');
    videoWrapper.style.cursor = 'none';
}

function resetActivityTimer() {
    clearTimeout(hideControlsTimeout);
    hideControlsTimeout = setTimeout(hideControls, 3000);
}

// Listen for activity on wrapper
videoWrapper.addEventListener('mousemove', showControls);
videoWrapper.addEventListener('click', showControls); // also trigger on click
videoWrapper.addEventListener('touchstart', showControls);


// 7. Shortcuts
document.addEventListener('keydown', (e) => {
    // Ignore if typing in chat
    if (document.activeElement === chatInput || document.activeElement === usernameInput || document.activeElement === videoUrlInput) return;

    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        showControls();
    }
    if (e.code === 'KeyF') {
        toggleFullscreenWrapper();
    }
});



// --- Chat UI Support ---
// Colors
const userColors = new Map();
const colors = ['#F87171', '#FB923C', '#FACC15', '#4ADE80', '#60A5FA', '#C084FC', '#F472B6'];

function getUserColor(username) {
    if (!userColors.has(username)) {
        let hash = 0;
        for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
        const index = Math.abs(hash) % colors.length;
        userColors.set(username, colors[index]);
    }
    return userColors.get(username);
}

function appendMessage(text, type, sender) {
    const msgDiv = document.createElement('div');
    if (type === 'system') {
        msgDiv.className = 'message system';
        msgDiv.textContent = text;
    } else {
        msgDiv.className = `message ${type}`;
        const senderSpan = document.createElement('div');
        senderSpan.className = 'sender';
        if (type === 'others') {
            senderSpan.textContent = sender || 'Anonymous';
            senderSpan.style.color = getUserColor(sender || 'Anonymous');
        } else {
            senderSpan.textContent = 'You';
        }
        msgDiv.appendChild(senderSpan);
        const textNode = document.createElement('div');
        textNode.textContent = text;
        msgDiv.appendChild(textNode);
    }
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
    if (!username) username = localStorage.getItem('synctube_username');
    if (!username) { showToast("Please enter your name first"); return; }
    if (!roomId) { showToast("Error: Not connected to a room"); return; }
    if (text) {
        socket.emit('chat-message', { roomId, message: text, sender: username });
        chatInput.value = '';
    }
}


// --- Invite UI Support ---
const inviteModal = document.getElementById('invite-modal');
const closeInviteBtn = document.getElementById('close-invite-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const inviteLinkInput = document.getElementById('invite-link-input');

function unlockVideoCall() {
    if (vcStartBtn.classList.contains('hidden')) {
        vcStartBtn.classList.remove('hidden');
        showToast("Friend detected! Video Call enabled 📹");
    }
}

inviteBtn.addEventListener('click', () => {
    inviteLinkInput.value = window.location.href;
    inviteModal.classList.add('active');
    const url = encodeURIComponent(window.location.href);
    const text = encodeURIComponent("Join my SyncTube watch party! 🎬");
    document.getElementById('share-wa').href = `https://wa.me/?text=${text}%20${url}`;
    document.getElementById('share-fb').href = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
    document.getElementById('share-x').href = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
    document.getElementById('share-email').href = `mailto:?subject=${text}&body=${url}`;
});

closeInviteBtn.addEventListener('click', () => inviteModal.classList.remove('active'));
inviteModal.addEventListener('click', (e) => {
    if (e.target === inviteModal) inviteModal.classList.remove('active');
});

copyLinkBtn.addEventListener('click', () => {
    inviteLinkInput.select();
    inviteLinkInput.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
        const originalText = copyLinkBtn.textContent;
        copyLinkBtn.textContent = 'Copied!';
        copyLinkBtn.style.background = '#22c55e';
        setTimeout(() => { copyLinkBtn.textContent = originalText; copyLinkBtn.style.background = ''; }, 2000);
    });
});

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


// --- Video Call Logic (Simplified Overlay) ---
let localStream;
let peerConnection;
let isCallActive = false;
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const callRequestModal = document.getElementById('call-request-modal');
const callerNameDisplay = document.getElementById('caller-name-display');
const acceptCallBtn = document.getElementById('accept-call-btn');
const rejectCallBtn = document.getElementById('reject-call-btn');
let currentCallerId = null;

vcStartBtn.addEventListener('click', () => {
    if (isCallActive) return;
    // Guard: Only allow VC with exactly 2 users
    if (roomUserCount !== 2) {
        showToast('VC requires exactly 2 users in room');
        return;
    }
    socket.emit('call-user', { roomId });
    showToast('Calling room...');
});

socket.on('call-request', ({ callerId, callerName }) => {
    if (isCallActive) return;
    currentCallerId = callerId;
    callerNameDisplay.textContent = callerName;
    callRequestModal.classList.add('active');

    // Play ringtone for incoming call
    callRingtone.currentTime = 0;
    callRingtone.play().catch(err => console.log('Ringtone autoplay blocked:', err));
});

acceptCallBtn.addEventListener('click', async () => {
    // Stop ringtone
    callRingtone.pause();
    callRingtone.currentTime = 0;

    callRequestModal.classList.remove('active');
    await startLocalStream();
    videoCallArea.classList.remove('hidden');
    isCallActive = true;
    socket.emit('call-accepted', { roomId, callerId: currentCallerId });
});

rejectCallBtn.addEventListener('click', () => {
    // Stop ringtone
    callRingtone.pause();
    callRingtone.currentTime = 0;

    callRequestModal.classList.remove('active');
    socket.emit('call-rejected', { roomId, callerId: currentCallerId });
    currentCallerId = null;
});

socket.on('call-accepted', async ({ accepterName, accepterId }) => {
    showToast(`${accepterName} accepted call! Connecting...`);
    await startLocalStream();
    videoCallArea.classList.remove('hidden');
    isCallActive = true;
    createPeerConnection(accepterId);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('vc-offer', { offer, roomId });
});

socket.on('call-rejected', ({ rejecterName }) => {
    showToast(`${rejecterName} rejected the call.`);
});

async function startLocalStream() {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;

    // Initialize VC state and icons
    isMicEnabled = true;
    isCameraEnabled = true;
    updateMicIcon();
    updateCameraIcon();
}

socket.on('vc-offer', async ({ offer, id }) => {
    if (!isCallActive) return;
    createPeerConnection(id);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('vc-answer', { answer, roomId });
});

socket.on('vc-answer', async ({ answer }) => {
    if (peerConnection) await peerConnection.setRemoteDescription(answer);
});

socket.on('vc-ice-candidate', async ({ candidate }) => {
    if (peerConnection) await peerConnection.addIceCandidate(candidate);
});

function createPeerConnection(targetId) {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) socket.emit('vc-ice-candidate', { candidate: event.candidate, roomId });
    };
    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected') remoteVideo.srcObject = null;
    };
}

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
    localVideo.srcObject = null;

    // Stop ringtone (safety cleanup)
    callRingtone.pause();
    callRingtone.currentTime = 0;

    // Reset VC state
    isMicEnabled = true;
    isCameraEnabled = true;
    currentCallerId = null;
}

socket.on('vc-end', () => {
    // Guard: prevent duplicate cleanup
    if (!isCallActive && !callRequestModal.classList.contains('active')) {
        // Already cleaned up, just stop ringtone
        callRingtone.pause();
        callRingtone.currentTime = 0;
        return;
    }

    showToast('Peer ended the call');

    // Hide call request modal if still showing (caller cancelled)
    callRequestModal.classList.remove('active');

    // Mark call as inactive
    isCallActive = false;

    // Hide VC frame
    videoCallArea.classList.add('hidden');

    // Stop local media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Close peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    // Clear video elements
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;

    // Stop ringtone
    callRingtone.pause();
    callRingtone.currentTime = 0;

    // Reset VC state
    isMicEnabled = true;
    isCameraEnabled = true;
    currentCallerId = null;
});

// VC Icon Update Functions
function updateMicIcon() {
    const icon = vcMuteBtn.querySelector('i');
    if (icon) {
        icon.setAttribute('data-lucide', isMicEnabled ? 'mic' : 'mic-off');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    // Optional: Add visual state class
    if (isMicEnabled) {
        vcMuteBtn.classList.remove('disabled-state');
    } else {
        vcMuteBtn.classList.add('disabled-state');
    }
}

function updateCameraIcon() {
    const icon = vcCamBtn.querySelector('i');
    if (icon) {
        icon.setAttribute('data-lucide', isCameraEnabled ? 'video' : 'video-off');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    // Optional: Add visual state class
    if (isCameraEnabled) {
        vcCamBtn.classList.remove('disabled-state');
    } else {
        vcCamBtn.classList.add('disabled-state');
    }
}

// VC Control Event Handlers
vcMuteBtn.addEventListener('click', () => {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        isMicEnabled = audioTrack.enabled;
        updateMicIcon();
    }
});

vcCamBtn.addEventListener('click', () => {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        isCameraEnabled = videoTrack.enabled;
        updateCameraIcon();
    }
});

// Draggable VC (Global Fixed + Transform)
function makeDraggable(element) {
    let active = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    element.addEventListener("mousedown", dragStart);
    element.addEventListener("touchstart", dragStart, { passive: false });

    function dragStart(e) {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

        if (e.type === "touchstart") {
            initialX = e.touches[0].clientX - xOffset;
            initialY = e.touches[0].clientY - yOffset;
        } else {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
        }

        active = true;
        element.classList.add('dragging');

        // Global Listeners
        document.addEventListener("mouseup", dragEnd);
        document.addEventListener("touchend", dragEnd);
        document.addEventListener("mousemove", drag);
        document.addEventListener("touchmove", drag, { passive: false });
    }

    function dragEnd(e) {
        active = false;
        element.classList.remove('dragging');

        document.removeEventListener("mouseup", dragEnd);
        document.removeEventListener("touchend", dragEnd);
        document.removeEventListener("mousemove", drag);
        document.removeEventListener("touchmove", drag);
    }

    function drag(e) {
        if (!active) return;
        e.preventDefault();

        if (e.type === "touchmove") {
            currentX = e.touches[0].clientX - initialX;
            currentY = e.touches[0].clientY - initialY;
        } else {
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
        }

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, element);
    }

    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
    }
}
makeDraggable(videoCallArea);

// Run Init
init();
