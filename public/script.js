// Socket Connection
const socket = io({ autoConnect: false, reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 }); // Will connect after auth

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
);

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
// IMPORTANT: This only controls the "Start Call" button visibility.
// It must NEVER auto-end an active call — user count can transiently
// drop to 1 during socket reconnection before any recovery flags are set.
function updateVCVisibility() {
    if (roomUserCount === 2) {
        vcStartBtn.classList.remove('hidden');
    } else {
        vcStartBtn.classList.add('hidden');
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
async function init() {
    // Check for AUTH PARAMS FIRST (Critical Step 9 Safety)
    const urlParams = new URLSearchParams(window.location.search);
    const hasAuthParams = window.location.hash.includes('access_token') || urlParams.has('code') || urlParams.has('error');

    // Step 9: OAuth Redirect Safety (Check storage first)
    const storedRoom = sessionStorage.getItem('returnRoom');
    if (storedRoom) {
        roomId = storedRoom;
        sessionStorage.removeItem('returnRoom');

        // ONLY replace state if we are NOT in an auth callback
        if (!hasAuthParams) {
            const newUrl = `${window.location.pathname}?room=${roomId}`;
            window.history.replaceState({ path: newUrl }, '', newUrl);
        }
    } else {
        roomId = urlParams.get('room');
    }

    if (!roomId) {
        roomId = generateId();
        const newUrl = `${window.location.pathname}?room=${roomId}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
    }

    console.log(`[Frontend] Init: roomId=${roomId}`);

    // Step 8: Join Flow Sequence Fix (Auth -> Profile -> Socket -> Join)
    console.log("[Auth] Checking initial session...");

    // UI: Show Loader instantly (modal is hidden by default in CSS, but we can force it active if needed)
    // Actually, let's make sure the modal is ACTIVE to show the loader.
    const authLoader = document.getElementById('auth-loader');
    const googleBtn = document.getElementById('google-login-btn');

    // Show modal + loader, hide button
    usernameModal.classList.add('active');
    authLoader.classList.remove('hidden');
    googleBtn.classList.add('hidden');

    const { data: { session } } = await supabase.auth.getSession();
    console.log("[Auth] Initial session:", session);

    // FIX: Check if we are returning from OAuth redirect
    // Use the variable we already computed
    const isOAuthRedirect = hasAuthParams;

    // Fallback: If no session after 3s, show modal (prevents infinite loading)
    let authTimeout;

    if (session) {
        console.log("[Auth] Session found, handling user...");
        // Loader stays visible until handleUserSession finishes
        handleUserSession(session);
    } else if (isOAuthRedirect) {
        console.log("[Auth] OAuth redirect detected, waiting for session...");
        // Loader stays visible. Set timeout to switch to button if it hangs
        authTimeout = setTimeout(() => {
            console.warn("[Auth] Timeout waiting for session. Showing login button.");
            authLoader.classList.add('hidden');
            googleBtn.classList.remove('hidden');
        }, 5000);
    } else {
        console.log("[Auth] No session found, showing login button...");
        authLoader.classList.add('hidden');
        googleBtn.classList.remove('hidden');
    }

    // Listen for auth changes
    supabase.auth.onAuthStateChange((event, session) => {
        console.log(`[Auth] Event: ${event}`, session);

        if (authTimeout) clearTimeout(authTimeout); // Cancel timeout if event fires

        if (event === 'SIGNED_IN' && session) {
            // Logic handled by handleUserSession (which closes modal)
            handleUserSession(session);
        } else if (event === 'SIGNED_OUT') {
            window.location.reload();
        }
    });
}

// Handle User Session (Entry to Step 4)
async function handleUserSession(session) {
    if (!session || !session.user) return;

    const user = session.user;
    // Extract display name or fallback
    username = user.user_metadata.full_name || user.user_metadata.name || user.email.split('@')[0];

    console.log(`[Auth] Logged in as: ${username} (${user.email})`);

    // Step 4: Profile Table Sync
    try {
        const { error } = await supabase
            .from('profiles')
            .upsert({
                id: user.id,
                email: user.email,
                display_name: username,
                avatar_url: user.user_metadata.avatar_url,
                // updated_at: new Date() // REMOVED: Column does not exist in schema
            });

        if (error) {
            console.error('[Profile] Upsert failed:', error);
            alert("Critical: Profile sync failed. Check console.");
            return; // Block socket connection (Step 5 requirement)
        }

        console.log('[Profile] User profile active');

        // Step 5: Socket Connection Gate
        connectSocket(session.access_token);

    } catch (err) {
        console.error('[Profile] Critical Error:', err);
    }

    usernameModal.classList.remove('active');
    updateProfileUI(user);
}

const googleLoginBtn = document.getElementById('google-login-btn');
if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            // Step 9: OAuth Redirect Safety
            if (roomId) {
                sessionStorage.setItem('returnRoom', roomId);
            }

            const { data, error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: window.location.href,
                    skipBrowserRedirect: true
                }
            });
            if (error) throw error;
            if (data?.url) window.location.href = data.url;
        } catch (err) {
            console.error("Login failed:", err);
            alert("Login failed. See console.");
        }
    });
}

let hasConnectedSocket = false;

function connectSocket(token) {
    if (hasConnectedSocket) return; // Prevent duplicate join on tab-switch auth refresh
    hasConnectedSocket = true;
    console.log("[Socket] Connecting with auth token...");
    socket.auth = { token };
    socket.connect();
    joinRoom();
}

function joinRoom() {
    console.log(`[Frontend] Joining Room: ${roomId}`);
    // Step 7 Pre-req: Remove username from payload (Server will use token)
    socket.emit('join-room', { roomId });
}

// --- Socket Events ---
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.add('connected');
    connectionStatus.classList.remove('connecting');

    // VC Auto-Recovery: re-join room and renegotiate WebRTC
    if (vcReconnecting && savedCallRoomId) {
        console.log('[VC Recovery] Socket reconnected, starting recovery...');
        joinRoom();
        socket.emit('vc-reconnect', { roomId: savedCallRoomId });
        // Short delay for room re-join to propagate before sending offer
        setTimeout(async () => {
            // Bail if user manually ended call during the delay
            if (!vcReconnecting) return;
            try {
                if (peerConnection) { peerConnection.close(); peerConnection = null; }
                if (!localStream || localStream.getTracks().every(t => t.readyState === 'ended')) {
                    await startLocalStream();
                }
                createPeerConnection(null);
                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                socket.emit('vc-offer', { offer, roomId: savedCallRoomId });
                console.log('[VC Recovery] Re-offer sent');
            } catch (err) {
                console.error('[VC Recovery] Failed:', err);
                vcReconnecting = false;
                savedCallRoomId = null;
                showReconnectingOverlay(false);
                endCall();
            }
        }, 500);
    }
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
    if (isHardSyncing) return; // Suppress during hard sync alignment

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

// --- Hard Sync ---
let isHardSyncing = false;
let lastSyncClick = 0;
const syncBtn = document.getElementById('sync-btn');

syncBtn.addEventListener('click', () => {
    if (!roomId || !player || !player.getCurrentTime) return;

    // Debounce: prevent overlapping sync requests (2s cooldown)
    const now = Date.now();
    if (now - lastSyncClick < 2000) {
        showToast('Sync already in progress...');
        return;
    }
    lastSyncClick = now;

    socket.emit('hard-sync', {
        roomId,
        timestamp: player.getCurrentTime(),
        videoId: currentVideoId
    });
    showToast('Syncing everyone...');
});

socket.on('hard-sync-prepare', (data) => {
    if (!player || !player.seekTo) return;

    isHardSyncing = true;
    isRemoteUpdate = true;

    // Load correct video if needed
    if (data.videoId && data.videoId !== currentVideoId) {
        loadVideo(data.videoId);
    }

    // Pause + seek
    player.pauseVideo();
    player.seekTo(data.timestamp, true);
    updatePlayButtonState(false);
    updateProgressBar();
});

socket.on('hard-sync-resume', (data) => {
    if (!player || !player.playVideo) return;

    // Final seek to ensure alignment, then play
    if (data.timestamp != null) {
        player.seekTo(data.timestamp, true);
    }
    player.playVideo();
    updatePlayButtonState(true);
    updateProgressBar();
    showToast('Playback synced ✅');

    // Re-enable normal sync loop
    setTimeout(() => {
        isHardSyncing = false;
        isRemoteUpdate = false;
    }, 500);
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
            'fs': 0, // We handle fullscreen
            'origin': window.location.origin
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
    if (id === currentVideoId && player && player.getPlayerState && player.getPlayerState() !== -1) {
        // Same video already loaded and player is active — skip reload
        return;
    }
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

// --- VC Reconnection State ---
let vcReconnecting = false;
let savedCallRoomId = null;
let vcReconnectTimeout = null;

// --- Internet Disconnect Detection ---
window.addEventListener('offline', () => {
    console.log('[VC Recovery] Internet offline');
    if (isCallActive) {
        vcReconnecting = true;
        savedCallRoomId = roomId;
        showReconnectingOverlay(true);
    }
});

window.addEventListener('online', () => {
    console.log('[VC Recovery] Internet back online');
    // Socket.io auto-reconnects; VC recovery triggered by socket 'connect' event
});

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
    if (!isCallActive && !vcReconnecting) return;
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

// --- VC Reconnect Handler (peer triggered) ---
socket.on('vc-reconnect', async ({ id }) => {
    if (!isCallActive && !vcReconnecting) return;
    console.log('[VC Recovery] Peer reconnecting, preparing for re-negotiation...');
    // Set reconnecting state — DON'T close peerConnection here.
    // The incoming vc-offer handler calls createPeerConnection() which
    // properly closes the old one and creates a new one atomically.
    vcReconnecting = true;
    savedCallRoomId = roomId;
    showReconnectingOverlay(true);
    // Start timeout for this side too
    if (vcReconnectTimeout) clearTimeout(vcReconnectTimeout);
    vcReconnectTimeout = setTimeout(() => {
        if (vcReconnecting) {
            console.log('[VC Recovery] Peer-side timeout — ending call');
            vcReconnecting = false;
            savedCallRoomId = null;
            showReconnectingOverlay(false);
            endCall();
            showToast('Call lost — reconnection timed out');
        }
    }, 120000);
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
        if (!peerConnection) return;
        const state = peerConnection.connectionState;
        console.log('[VC] Connection state:', state);
        if (state === 'disconnected' || state === 'failed') {
            if (!vcReconnecting && isCallActive) {
                vcReconnecting = true;
                savedCallRoomId = roomId;
                showReconnectingOverlay(true);
                vcReconnectTimeout = setTimeout(() => {
                    if (vcReconnecting) {
                        console.log('[VC Recovery] Timeout — ending call');
                        vcReconnecting = false;
                        savedCallRoomId = null;
                        showReconnectingOverlay(false);
                        endCall();
                        showToast('Call lost — reconnection timed out');
                    }
                }, 120000);
            }
        }
        if (state === 'connected') {
            if (vcReconnecting) {
                vcReconnecting = false;
                savedCallRoomId = null;
                showReconnectingOverlay(false);
                if (vcReconnectTimeout) { clearTimeout(vcReconnectTimeout); vcReconnectTimeout = null; }
                showToast('Call reconnected! ✅');
            }
        }
    };
}

// --- Reconnecting Overlay Helper ---
function showReconnectingOverlay(show) {
    let overlay = document.getElementById('vc-reconnecting-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'vc-reconnecting-overlay';
        const content = document.createElement('div');
        content.className = 'vc-reconnecting-content';
        const spinner = document.createElement('div');
        spinner.className = 'vc-reconnecting-spinner';
        const label = document.createElement('span');
        label.textContent = 'Reconnecting…';
        content.appendChild(spinner);
        content.appendChild(label);
        overlay.appendChild(content);
        document.getElementById('video-call-area').appendChild(overlay);
    }
    overlay.style.display = show ? 'flex' : 'none';
}

vcEndBtn.addEventListener('click', endCall);

function endCall() {
    isCallActive = false;
    vcReconnecting = false;
    savedCallRoomId = null;
    if (vcReconnectTimeout) { clearTimeout(vcReconnectTimeout); vcReconnectTimeout = null; }
    showReconnectingOverlay(false);
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
    // If reconnecting, this vc-end was triggered by the peer's socket drop.
    // Ignore it — the peer is trying to reconnect, not intentionally ending.
    // Note: Manual endCall() by the user still works because it calls endCall()
    // directly, which clears vcReconnecting FIRST, then emits vc-end.
    if (vcReconnecting) return;

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

// --- Desktop Guard Logic ---
let appInitialized = false;

function checkDevice() {
    const width = window.innerWidth;
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;
    // Guard Rule: Must be >= 1024px AND have fine pointer (mouse/trackpad)
    const isDesktop = width >= 1024 && isFinePointer;

    const guard = document.getElementById('desktop-guard');
    const app = document.querySelector('.app-container');

    if (isDesktop) {
        if (guard) guard.classList.add('hidden');
        if (app) app.classList.remove('hidden');
        return true;
    } else {
        if (guard) guard.classList.remove('hidden');
        if (app) app.classList.add('hidden');

        // Safety: If app was already running, pause video to prevent background audio
        if (appInitialized && typeof player !== 'undefined' && player && player.pauseVideo) {
            try { player.pauseVideo(); } catch (e) { /* ignore */ }
        }
        return false;
    }
}

// Initial Check & Launch
if (checkDevice()) {
    appInitialized = true;
    init();
} else {
    // If mobile start, do NOT init app (no socket, no auth)
    console.log('[Desktop Guard] Mobile device detected. App prevented.');
}

// Resize Monitor
window.addEventListener('resize', () => {
    const isDesktop = checkDevice();

    // Recovery: Mobile -> Desktop
    if (isDesktop && !appInitialized) {
        // Must reload to cleanly initialize everything
        window.location.reload();
    }
});

// --- Profile UI Logic ---

const profileBtn = document.getElementById('profile-btn');
const profileMenu = document.getElementById('profile-menu-container');
const profileDropdown = document.getElementById('profile-dropdown');
const logoutBtn = document.getElementById('logout-btn');
const saveNameBtn = document.getElementById('save-name-btn');
const profileNameInput = document.getElementById('profile-name-input');
const dropdownName = document.getElementById('dropdown-name');
const dropdownEmail = document.getElementById('dropdown-email');

function updateProfileUI(user) {
    if (!profileMenu) return;

    // Show container
    profileMenu.classList.remove('hidden');

    // Update Avatar
    const avatarUrl = user.user_metadata.avatar_url;
    if (avatarUrl) {
        profileBtn.textContent = '';
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarUrl;
        avatarImg.className = 'profile-avatar';
        avatarImg.alt = 'Profile';
        profileBtn.appendChild(avatarImg);
    } else {
        const initials = ((username || user.email) || 'User').substring(0, 2).toUpperCase();
        profileBtn.textContent = '';
        const initialsDiv = document.createElement('div');
        initialsDiv.className = 'profile-initials';
        initialsDiv.textContent = initials;
        profileBtn.appendChild(initialsDiv);
    }

    // Update Dropdown Info
    if (dropdownName) dropdownName.textContent = username || 'User';
    if (dropdownEmail) dropdownEmail.textContent = user.email;
    if (profileNameInput) profileNameInput.value = username || '';
}

// Toggle Dropdown
if (profileBtn) {
    profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        profileDropdown.classList.toggle('hidden');
    });
}

// Close Dropdown on Outside Click
document.addEventListener('click', (e) => {
    if (profileDropdown && !profileDropdown.classList.contains('hidden')) {
        // Check if click is outside menu container
        if (!profileMenu.contains(e.target)) {
            profileDropdown.classList.add('hidden');
        }
    }
});

// Logout
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.reload();
    });
}

// Change Name
if (saveNameBtn) {
    saveNameBtn.addEventListener('click', async () => {
        const newName = profileNameInput.value.trim();
        if (!newName) return;

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { error: updateError } = await supabase
                .from('profiles')
                .update({ display_name: newName })
                .eq('id', user.id);

            if (updateError) throw updateError;

            // Update Local State
            username = newName;
            dropdownName.textContent = newName;
            showToast('Name updated!');
            profileDropdown.classList.add('hidden');

        } catch (err) {
            console.error('Name update failed:', err);
            showToast('Failed to update name');
        }
    });
}

