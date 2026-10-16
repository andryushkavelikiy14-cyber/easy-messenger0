'use strict';

/* ============================================================
   СОСТОЯНИЕ
   ============================================================ */
const IS_SERVER = location.protocol === 'http:' || location.protocol === 'https:';

let currentUser = null;
let authToken = null;
let socket = null;
let currentChat = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let selectedAvatar = null;
let pendingAuth = null;
let onlineUsers = new Set();
let typingTimeout = null;
let typingSent = false;
let currentAudioRAF = null;
let replyTo = null;
let editingId = null;
let pendingPreview = null;
let selectedMsgId = null;
let blockedUsers = new Set();
let currentMessages = [];
let allUsersCache = [];
let chatsCache = [];

/* ЗВОНКИ */
let callState = 'idle'; // idle | calling | incoming | active
let callPeer = null;
let localStream = null;
let remoteStream = null;
let pc = null;
let callIsVideo = false;
let callMuted = false;
let callCamOff = false;
let incomingCaller = null;
let incomingIsVideo = false;

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

/* ============================================================
   ХЕЛПЕРЫ
   ============================================================ */
function $(id) { return document.getElementById(id); }

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = String(t);
    return d.innerHTML;
}

function escapeAttr(t) {
    return String(t).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function formatDuration(s) {
    s = Math.floor(s || 0);
    const m = Math.floor(s / 60), x = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
}

function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function showToast(t) {
    const e = $('appToast');
    e.textContent = t;
    e.classList.add('show');
    clearTimeout(e._t);
    e._t = setTimeout(() => e.classList.remove('show'), 2200);
}

function generateAvatar(l) {
    const c = ['#8b5cf6', '#ef4565', '#4dabf7', '#06d6a0', '#ffd43b', '#ff922b'];
    const col = c[Math.floor(Math.random() * c.length)];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<rect width="100" height="100" fill="' + col + '"/>' +
        '<text x="50" y="68" font-size="50" text-anchor="middle" fill="#fff" ' +
        'font-family="Arial" font-weight="bold">' + l + '</text></svg>';
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

function showGuiDialog(icon, title, desc, onConfirm, danger) {
    $('guiIcon').textContent = icon;
    $('guiTitle').textContent = title;
    $('guiDesc').textContent = desc;
    const o = $('guiOverlay'), c = $('guiCancel'), k = $('guiConfirm');
    if (danger) k.classList.add('danger');
    else k.classList.remove('danger');
    o.classList.add('active');
    const cleanup = () => { o.classList.remove('active'); c.onclick = null; k.onclick = null; };
    c.onclick = cleanup;
    k.onclick = () => { cleanup(); onConfirm(); };
}

function getBlocked() {
    try {
        return new Set(JSON.parse(localStorage.getItem('m_blocked_' + (currentUser ? currentUser.username : '')) || '[]'));
    } catch (e) { return new Set(); }
}

function saveBlocked() {
    if (currentUser) {
        localStorage.setItem('m_blocked_' + currentUser.username, JSON.stringify([...blockedUsers]));
    }
}

function chatKey(a, b) {
    const p = [a, b].sort();
    return 'm_chat_' + p[0] + '_' + p[1];
}

/* ============================================================
   API
   ============================================================ */
const API = {
    async register(u, p, a) {
        if (IS_SERVER) {
            const r = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p, avatar: a })
            });
            return await r.json();
        }
        const us = JSON.parse(localStorage.getItem('m_users') || '[]');
        if (us.find(x => x.username === u)) return { error: 'Логин занят' };
        us.push({ username: u, password: p, avatar: a });
        localStorage.setItem('m_users', JSON.stringify(us));
        return { ok: true };
    },
    async login(u, p) {
        if (IS_SERVER) {
            const r = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
            });
            return await r.json();
        }
        const us = JSON.parse(localStorage.getItem('m_users') || '[]');
        const x = us.find(y => y.username === u);
        if (!x) return { error: 'Не найден' };
        if (x.password !== p) return { error: 'Неверный пароль' };
        return { ok: true, token: 'local_' + Date.now(), user: { username: x.username, avatar: x.avatar } };
    },
    async users() {
        if (IS_SERVER) {
            const r = await fetch('/api/users', { headers: { 'Authorization': 'Bearer ' + authToken } });
            return await r.json();
        }
        const us = JSON.parse(localStorage.getItem('m_users') || '[]');
        return us.filter(u => u.username !== currentUser.username)
                 .map(u => ({ username: u.username, avatar: u.avatar }));
    },
    async chats() {
        if (IS_SERVER) {
            try {
                const r = await fetch('/api/chats', { headers: { 'Authorization': 'Bearer ' + authToken } });
                if (r.ok) return await r.json();
            } catch (e) {}
        }
        return [];
    },
    async messages(o) {
        if (IS_SERVER) {
            const r = await fetch('/api/messages/' + encodeURIComponent(o), {
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            return await r.json();
        }
        return JSON.parse(localStorage.getItem(chatKey(currentUser.username, o)) || '[]');
    },
    async sendMessage(m) {
        if (IS_SERVER) {
            socket.emit('send_message', {
                token: authToken, to: m.receiver, type: m.type, content: m.content,
                file_name: m.file_name, file_size: m.file_size,
                duration: m.duration, reply_to: m.reply_to
            });
        } else {
            const k = chatKey(m.sender, m.receiver);
            const ms = JSON.parse(localStorage.getItem(k) || '[]');
            m.id = Date.now();
            m.timestamp = Date.now() / 1000;
            m.read = 0;
            ms.push(m);
            localStorage.setItem(k, JSON.stringify(ms));
            currentMessages = ms;
            appendMessage(m);
        }
    },
    async upload(f) {
        if (IS_SERVER) {
            const fd = new FormData();
            fd.append('file', f);
            const r = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + authToken },
                body: fd
            });
            return await r.json();
        }
        return new Promise(res => {
            const r = new FileReader();
            r.onload = e => res({ url: e.target.result, file_name: f.name, file_size: f.size });
            r.readAsDataURL(f);
        });
    },
    async editMessage(id, c) {
        if (IS_SERVER) {
            socket.emit('edit_message', { token: authToken, msg_id: id, content: c });
        } else {
            const k = chatKey(currentUser.username, currentChat.username);
            const ms = JSON.parse(localStorage.getItem(k) || '[]');
            const m = ms.find(x => x.id === id);
            if (m) { m.content = c; m.edited = true; localStorage.setItem(k, JSON.stringify(ms)); }
            currentMessages = ms;
            reloadMessages();
        }
    },
    async deleteMessage(id) {
        if (IS_SERVER) {
            socket.emit('delete_message', { token: authToken, msg_id: id });
        } else {
            const k = chatKey(currentUser.username, currentChat.username);
            let ms = JSON.parse(localStorage.getItem(k) || '[]');
            ms = ms.filter(x => x.id !== id);
            localStorage.setItem(k, JSON.stringify(ms));
            currentMessages = ms;
            reloadMessages();
        }
    },
    async clearHistory(o) {
        if (IS_SERVER) socket.emit('clear_history', { token: authToken, user: o });
    },
    async deleteChat(o) {
        if (IS_SERVER) socket.emit('delete_chat', { token: authToken, user: o });
    }
};

/* ============================================================
   SOCKET
   ============================================================ */
function connectSocket() {
    if (!IS_SERVER || typeof io === 'undefined') return;
    if (socket) socket.disconnect();
    socket = io({ query: { token: authToken } });

    socket.on('online_list', l => { onlineUsers = new Set(l); updateOnlineStatuses(); });
    socket.on('user_online', ({ username }) => { onlineUsers.add(username); updateOnlineStatuses(); });
    socket.on('user_offline', ({ username }) => { onlineUsers.delete(username); updateOnlineStatuses(); });

    socket.on('new_message', m => {
        if (!currentChat) { renderUsers($('searchInput').value); return; }
        const inv = (m.sender === currentUser.username && m.receiver === currentChat.username) ||
                    (m.sender === currentChat.username && m.receiver === currentUser.username);
        if (inv) { currentMessages.push(m); appendMessage(m); }
        else renderUsers($('searchInput').value);
    });

    socket.on('message_edited', d => {
        const m = currentMessages.find(x => x.id === d.id);
        if (m) { m.content = d.content; m.edited = true; reloadMessages(); }
    });

    socket.on('message_deleted', d => {
        currentMessages = currentMessages.filter(x => x.id !== d.id);
        reloadMessages();
    });

    socket.on('messages_read', ({ by, to }) => {
        if (currentChat && to === currentUser.username && by === currentChat.username) {
            currentMessages.forEach(m => { if (m.sender === currentUser.username) m.read = 1; });
            reloadMessages();
        }
    });

    socket.on('history_cleared', () => { currentMessages = []; reloadMessages(); });
    socket.on('chat_deleted', () => { currentMessages = []; goBackToMain(); showToast('Чат удалён'); });

    socket.on('user_typing', ({ from }) => {
        if (currentChat && from === currentChat.username) $('chatStatus').textContent = 'печатает...';
    });
    socket.on('user_stop_typing', ({ from }) => {
        if (currentChat && from === currentChat.username)
            $('chatStatus').textContent = onlineUsers.has(from) ? 'в сети' : 'не в сети';
    });

    socket.on('user_blocked', ({ user }) => {
        blockedUsers.add(user);
        saveBlocked();
        if (currentChat && currentChat.username === user) updateBlockedUI();
    });
    socket.on('user_unblocked', ({ user }) => {
        blockedUsers.delete(user);
        saveBlocked();
        if (currentChat && currentChat.username === user) updateBlockedUI();
    });
    socket.on('you_are_blocked', ({ by }) => showToast(by + ' заблокировал вас'));
    socket.on('message_blocked', ({ reason }) => showToast(reason || 'Сообщение не отправлено'));

    /* ЗВОНКИ */
    socket.on('call_incoming', ({ from, video }) => handleIncomingCall(from, video));
    socket.on('call_accepted', ({ by }) => handleCallAccepted(by));
    socket.on('call_rejected', ({ by }) => { showToast(by + ' отклонил'); cleanupCall(); });
    socket.on('call_failed', ({ reason }) => { showToast(reason); cleanupCall(); });
    socket.on('call_ended', () => { showToast('Звонок завершён'); cleanupCall(); });
    socket.on('webrtc_signal', async ({ from, signal }) => { await handleSignal(from, signal); });
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupEventListeners();
    tryRestoreSession();
});

function tryRestoreSession() {
    const s = localStorage.getItem('m_session');
    if (!s) return;
    try {
        const d = JSON.parse(s);
        authToken = d.token;
        currentUser = d.user;
        blockedUsers = getBlocked();
        if (IS_SERVER) {
            fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + authToken } })
                .then(r => {
                    if (r.ok) { connectSocket(); showMainScreen(); }
                    else localStorage.removeItem('m_session');
                })
                .catch(() => {});
        } else showMainScreen();
    } catch (e) {}
}

function saveSession() {
    localStorage.setItem('m_session', JSON.stringify({ token: authToken, user: currentUser }));
}

/* ============================================================
   TABS
   ============================================================ */
function setupTabs() {
    const tabs = document.querySelectorAll('.tab');
    const ind = $('tabIndicator');
    const l = $('loginTab');
    const r = $('registerTab');
    tabs.forEach((t, i) => {
        t.addEventListener('click', () => {
            tabs.forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            ind.style.transform = 'translateX(' + (i * 100) + '%)';
            if (t.dataset.tab === 'login') { l.classList.add('active'); r.classList.remove('active'); }
            else { r.classList.add('active'); l.classList.remove('active'); }
        });
    });
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */
function setupEventListeners() {
    // AUTH
    $('avatarInput').addEventListener('change', handleAvatarSelect);
    $('loginBtn').addEventListener('click', handleLogin);
    $('registerBtn').addEventListener('click', handleRegister);
    $('logoutBtn').addEventListener('click', handleLogout);

    // SEARCH
    $('searchInput').addEventListener('input', e => renderUsers(e.target.value));

    // CHAT
    $('backBtn').addEventListener('click', goBackToMain);
    $('sendBtn').addEventListener('click', sendMessage);
    $('messageInput').addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });
    $('messageInput').addEventListener('input', handleTyping);

    // ATTACH
    $('attachBtn').addEventListener('click', () => {
        if (!currentChat) return;
        if (blockedUsers.has(currentChat.username)) { showToast('Заблокирован'); return; }
        $('attachMenu').classList.toggle('active');
    });
    document.querySelectorAll('.attach-option').forEach(b => {
        b.addEventListener('click', () => {
            const t = b.dataset.type;
            $('attachMenu').classList.remove('active');
            if (t === 'media') $('mediaInput').click();
            else if (t === 'file') $('fileInput').click();
            else if (t === 'voice') toggleRecording();
        });
    });
    $('mediaInput').addEventListener('change', e => handleFileSelect(e, 'media'));
    $('fileInput').addEventListener('change', e => handleFileSelect(e, 'file'));
    $('voiceBtn').addEventListener('click', toggleRecording);

    // 2FA
    $('closeModalBtn').addEventListener('click', () => {
        $('twoFAModal').classList.remove('active');
        $('codeInput').value = '';
        pendingAuth = null;
        showToast('Вход отменён');
    });
    $('confirmCodeBtn').addEventListener('click', confirmTwoFACode);
    $('copyCodeBtn').addEventListener('click', copyCode);
    $('codeInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); });
    $('codeInput').addEventListener('keypress', e => { if (e.key === 'Enter') confirmTwoFACode(); });

    // VIEWERS
    document.querySelector('.image-modal .modal-close-x').addEventListener('click', closeImageModal);
    $('imageModal').addEventListener('click', e => { if (e.target.id === 'imageModal') closeImageModal(); });
    $('audioModal').addEventListener('click', e => { if (e.target.id === 'audioModal') closeAudioModal(); });
    $('audioPlayBtn').addEventListener('click', toggleFullAudio);

    // CHAT MENU (3 dots)
    $('chatMenuBtn').addEventListener('click', e => { e.stopPropagation(); toggleChatMenu(); });
    $('menuClearHistory').addEventListener('click', () => {
        closeChatMenu();
        showGuiDialog('🗑️', 'Очистить историю?', 'Сообщения удалятся у обоих', () => {
            API.clearHistory(currentChat.username);
            currentMessages = [];
            reloadMessages();
            showToast('История очищена');
        }, true);
    });
    $('menuDeleteChat').addEventListener('click', () => {
        closeChatMenu();
        showGuiDialog('❌', 'Удалить чат?', 'Чат удалится у обоих', () => {
            API.deleteChat(currentChat.username);
        }, true);
    });
    $('menuBlockUser').addEventListener('click', () => { closeChatMenu(); blockUser(); });
    $('unblockBtn').addEventListener('click', unblockUser);

    // MESSAGE MENU
    $('msgReply').addEventListener('click', () => { hideMsgMenu(); startReply(selectedMsgId); });
    $('msgEdit').addEventListener('click', () => { hideMsgMenu(); startEdit(selectedMsgId); });
    $('msgDelete').addEventListener('click', () => {
        hideMsgMenu();
        const id = selectedMsgId;
        showGuiDialog('🗑️', 'Удалить сообщение?', '', async () => {
            await API.deleteMessage(id);
            showToast('Удалено');
        }, true);
    });

    // REPLY / EDIT CLOSE
    $('replyClose').addEventListener('click', cancelReply);
    $('editClose').addEventListener('click', cancelEdit);

    // PREVIEW
    $('previewCancel').addEventListener('click', () => { closePreview(); pendingPreview = null; });
    $('previewSend').addEventListener('click', sendPreview);

    // CLOSE MENUS ON OUTSIDE CLICK
    document.addEventListener('click', e => {
        if (!e.target.closest('#chatMenu') && !e.target.closest('#chatMenuBtn')) closeChatMenu();
        if (!e.target.closest('#msgMenu')) hideMsgMenu();
        if (!e.target.closest('#attachMenu') && !e.target.closest('#attachBtn'))
            $('attachMenu').classList.remove('active');
    });

    // ENTER IN LOGIN/REGISTER
    ['loginUsername', 'loginPassword'].forEach(id => {
        $(id).addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    });
    $('registerPassword2').addEventListener('keypress', e => { if (e.key === 'Enter') handleRegister(); });

    // INPUT FILTERS
    ['registerUsername', 'loginUsername'].forEach(id => {
        $(id).addEventListener('input', e => { e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, ''); });
    });
    ['registerPassword', 'registerPassword2', 'loginPassword'].forEach(id => {
        $(id).addEventListener('input', e => { if (e.target.value.length > 8) e.target.value = e.target.value.slice(0, 8); });
    });

    // CALL BUTTONS
    $('callBtn').addEventListener('click', () => startCall(false));
    $('callEndBtn').addEventListener('click', endCall);
    $('callMicBtn').addEventListener('click', toggleMic);
    $('callCamBtn').addEventListener('click', toggleCam);
    $('callSwitchBtn').addEventListener('click', switchCamera);
    $('callMinimize').addEventListener('click', () => $('callOverlay').classList.remove('active'));
    $('incomingAccept').addEventListener('click', acceptIncomingCall);
    $('incomingReject').addEventListener('click', rejectIncomingCall);
}

/* ============================================================
   AUTH
   ============================================================ */
function handleAvatarSelect(e) {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { showToast('Макс 2MB'); return; }
    const r = new FileReader();
    r.onload = ev => {
        selectedAvatar = ev.target.result;
        $('avatarPreview').innerHTML = '<img src="' + selectedAvatar + '"><div class="avatar-overlay">📷</div>';
    };
    r.readAsDataURL(f);
}

async function handleLogin() {
    const u = $('loginUsername').value.trim();
    const p = $('loginPassword').value;
    if (!u || !p) { showToast('Введите данные'); return; }
    try {
        const d = await API.login(u, p);
        if (d.error) { showToast(d.error); return; }
        pendingAuth = { action: 'login', token: d.token, user: d.user };
        showTwoFA();
    } catch (e) { showToast('Ошибка соединения'); }
}

async function handleRegister() {
    const u = $('registerUsername').value.trim();
    const p = $('registerPassword').value;
    const p2 = $('registerPassword2').value;
    if (u.length < 2) { showToast('Логин мин 2'); return; }
    if (!/^[a-zA-Z0-9]+$/.test(u)) { showToast('Только a-z, 0-9'); return; }
    if (p.length < 4) { showToast('Пароль мин 4'); return; }
    if (p !== p2) { showToast('Пароли разные'); return; }
    try {
        const av = selectedAvatar || generateAvatar(u[0].toUpperCase());
        const reg = await API.register(u, p, av);
        if (reg.error) { showToast(reg.error); return; }
        const d = await API.login(u, p);
        if (d.error) { showToast('Создан, войдите'); return; }
        pendingAuth = { action: 'register', token: d.token, user: d.user };
        showTwoFA();
    } catch (e) { showToast('Ошибка'); }
}

function showTwoFA() {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    pendingAuth.code = c;
    $('codeDisplay').textContent = c;
    $('codeInput').value = '';
    $('twoFAModal').classList.add('active');
    try {
        navigator.clipboard.writeText(c).then(() => {
            const t = $('copyText');
            t.textContent = 'Уже скопирован!';
            setTimeout(() => t.textContent = 'Скопировать код', 2000);
        }).catch(() => {});
    } catch (e) {}
    setTimeout(() => $('codeInput').focus(), 300);
}

function confirmTwoFACode() {
    if (!pendingAuth) return;
    const e = $('codeInput').value.trim();
    if (!e) { showToast('Введите код'); return; }
    if (e !== pendingAuth.code) { showToast('❌ Неверный код'); $('codeInput').value = ''; return; }
    $('twoFAModal').classList.remove('active');
    authToken = pendingAuth.token;
    currentUser = pendingAuth.user;
    pendingAuth = null;
    blockedUsers = getBlocked();
    saveSession();
    connectSocket();
    showMainScreen();
    ['loginUsername', 'loginPassword', 'registerUsername', 'registerPassword', 'registerPassword2', 'codeInput'].forEach(id => {
        const el = $(id); if (el) el.value = '';
    });
    $('avatarPreview').innerHTML = '<span>?</span><div class="avatar-overlay">📷</div>';
    selectedAvatar = null;
    showToast('✅ Добро пожаловать, ' + currentUser.username + '!');
}

function copyCode() {
    if (!pendingAuth || !pendingAuth.code) return;
    const c = pendingAuth.code;
    const b = $('copyCodeBtn');
    const t = $('copyText');
    const done = () => {
        b.classList.add('copied');
        t.textContent = 'Скопировано!';
        setTimeout(() => { b.classList.remove('copied'); t.textContent = 'Скопировать код'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(c).then(done).catch(() => { fb(c); done(); });
    } else { fb(c); done(); }
}

function fb(t) {
    const a = document.createElement('textarea');
    a.value = t;
    a.style.position = 'fixed';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(a);
}

/* ============================================================
   MAIN SCREEN
   ============================================================ */
function showMainScreen() {
    $('authScreen').classList.remove('active');
    $('mainScreen').classList.add('active');
    $('chatScreen').classList.remove('active');
    $('myAvatar').src = currentUser.avatar;
    $('myUsername').textContent = currentUser.username;
    renderUsers('');
}

async function renderUsers(searchTerm) {
    const list = $('usersList');
    const st = $('sectionTitle');
    const s = (searchTerm || '').trim().toLowerCase();

    try {
        allUsersCache = await API.users();
        chatsCache = await API.chats();
    } catch (e) {
        allUsersCache = [];
        chatsCache = [];
    }

    const byName = {};
    chatsCache.forEach(c => byName[c.username] = c);

    if (!s) {
        st.textContent = 'Чаты';
        if (chatsCache.length === 0) {
            list.innerHTML = '<div class="no-users"><span class="big">💬</span>Пока нет чатов<br>' +
                '<span style="font-size:12px;opacity:.6;display:block;margin-top:6px">' +
                'Напиши имя в поиске</span></div>';
            return;
        }
        list.innerHTML = chatsCache.map(c => {
            const on = onlineUsers.has(c.username);
            const bl = c.blocked || blockedUsers.has(c.username);
            const pv = c.last_message ? fmtPrev(c.last_message) : 'Нет сообщений';
            const u = c.unread || 0;
            return '<div class="user-item" onclick="openChat(\'' + escapeAttr(c.username) + '\')">' +
                '<div class="user-item-avatar-wrap">' +
                '<img class="user-item-avatar" src="' + c.avatar + '">' +
                '<span class="user-item-online ' + (on ? 'visible' : '') + '"></span></div>' +
                '<div class="user-item-info">' +
                '<div class="user-item-name">' + escapeHtml(c.username) + (bl ? '<span class="lock">🚫</span>' : '') + '</div>' +
                '<div class="user-item-preview">' + pv + '</div></div>' +
                (u > 0 ? '<div class="user-item-badge">' + u + '</div>' : '') +
                '</div>';
        }).join('');
        return;
    }

    st.textContent = 'Результаты поиска';
    const found = allUsersCache.filter(u => u.username.toLowerCase().includes(s));
    if (found.length === 0) {
        list.innerHTML = '<div class="no-users"><span class="big">🔍</span>Не найдено</div>';
        return;
    }
    list.innerHTML = found.map(u => {
        const on = onlineUsers.has(u.username);
        const ex = byName[u.username];
        const bl = (ex && ex.blocked) || blockedUsers.has(u.username);
        const pv = ex && ex.last_message ? fmtPrev(ex.last_message) : 'Начать чат';
        const ur = (ex && ex.unread) || 0;
        return '<div class="user-item" onclick="openChat(\'' + escapeAttr(u.username) + '\')">' +
            '<div class="user-item-avatar-wrap">' +
            '<img class="user-item-avatar" src="' + u.avatar + '">' +
            '<span class="user-item-online ' + (on ? 'visible' : '') + '"></span></div>' +
            '<div class="user-item-info">' +
            '<div class="user-item-name">' + escapeHtml(u.username) + (bl ? '<span class="lock">🚫</span>' : '') + '</div>' +
            '<div class="user-item-preview">' + pv + '</div></div>' +
            (ur > 0 ? '<div class="user-item-badge">' + ur + '</div>' : '') +
            '</div>';
    }).join('');
}

function fmtPrev(m) {
    if (!m) return '';
    if (m.type === 'text') return escapeHtml(m.content).slice(0, 60);
    if (m.type === 'image') return '🖼️ Фото';
    if (m.type === 'video') return '🎬 Видео';
    if (m.type === 'audio') return '🎤 Голосовое';
    if (m.type === 'file') return '📎 ' + escapeHtml(m.file_name || '');
    return '';
}

function handleLogout() {
    showGuiDialog('👋', 'Выйти?', 'Сможешь войти снова', () => {
        if (socket) socket.disconnect();
        socket = null;
        currentUser = null;
        authToken = null;
        currentChat = null;
        onlineUsers.clear();
        allUsersCache = [];
        chatsCache = [];
        localStorage.removeItem('m_session');
        $('authScreen').classList.add('active');
        $('mainScreen').classList.remove('active');
        $('chatScreen').classList.remove('active');
        $('loginUsername').value = '';
        $('loginPassword').value = '';
        showToast('👋 Выход');
    }, true);
}

function updateOnlineStatuses() {
    document.querySelectorAll('.user-item').forEach(item => {
        const n = item.querySelector('.user-item-name');
        if (!n) return;
        const name = n.textContent.replace('🚫', '').trim();
        const d = item.querySelector('.user-item-online');
        if (name && d) d.classList.toggle('visible', onlineUsers.has(name));
    });
    if (currentChat) {
        const on = onlineUsers.has(currentChat.username);
        $('chatStatus').textContent = on ? 'в сети' : 'не в сети';
        $('chatOnlineDot').style.display = on ? 'block' : 'none';
    }
}

/* ============================================================
   CHAT
   ============================================================ */
async function openChat(username) {
    try {
        const us = await API.users();
        const u = us.find(x => x.username === username);
        if (!u) return;
        currentChat = u;
        currentMessages = await API.messages(username);
        $('mainScreen').classList.remove('active');
        $('chatScreen').classList.add('active');
        $('chatAvatar').src = u.avatar;
        $('chatUsername').textContent = u.username;
        const on = onlineUsers.has(username);
        $('chatStatus').textContent = on ? 'в сети' : 'не в сети';
        $('chatOnlineDot').style.display = on ? 'block' : 'none';
        updateBlockedUI();
        reloadMessages();
        setTimeout(() => $('messageInput').focus(), 200);
    } catch (e) { showToast('Ошибка чата'); }
}

function updateBlockedUI() {
    if (!currentChat) return;
    const bl = blockedUsers.has(currentChat.username);
    $('chatInputArea').style.display = bl ? 'none' : 'flex';
    $('blockedBar').style.display = bl ? 'flex' : 'none';
    $('callBtn').style.display = bl ? 'none' : 'flex';
}

function reloadMessages() {
    const c = $('messagesContainer');
    if (currentMessages.length === 0) {
        c.innerHTML = '<div class="no-users"><span class="big">👋</span>Начните диалог!</div>';
        return;
    }
    c.innerHTML = currentMessages.map(renderMessage).join('');
    c.scrollTop = c.scrollHeight;
    attachMsgHandlers();
}

function renderMessage(m) {
    const sent = m.sender === currentUser.username;
    const cls = sent ? 'sent' : 'received';
    const ts = m.timestamp || Date.now() / 1000;
    const time = new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    let rep = '';
    if (m.reply_to && m.reply_to.sender) {
        rep = '<div class="msg-reply" onclick="event.stopPropagation();scrollToMsg(' + m.reply_to.id + ')">' +
            '<span class="reply-name">' + escapeHtml(m.reply_to.sender) + '</span>' +
            '<span class="reply-text">' + escapeHtml(m.reply_to.preview || '') + '</span></div>';
    }
    let c = '';
    if (m.type === 'text') c = escapeHtml(m.content).replace(/\n/g, '<br>');
    else if (m.type === 'image') c = '<img class="msg-image" src="' + m.content + '" onclick="event.stopPropagation();openImageModal(\'image\',\'' + escapeAttr(m.content) + '\')">';
    else if (m.type === 'video') c = '<video class="msg-image" src="' + m.content + '" controls onclick="event.stopPropagation()"></video>';
    else if (m.type === 'audio') c = renderVoice(m);
    else if (m.type === 'file') c = renderFile(m);
    const ed = m.edited ? '<span class="msg-edited">ред.</span>' : '';
    const stt = sent ? '<span class="msg-status ' + (m.read ? 'read' : '') + '">' + (m.read ? '✓✓' : '✓') + '</span>' : '';
    return '<div class="message ' + cls + '" data-msg-id="' + m.id + '" data-sender="' + escapeAttr(m.sender) + '">' +
        rep + c + '<span class="message-time">' + ed + time + stt + '</span></div>';
}

function renderFile(m) {
    const e = (m.file_name || '').split('.').pop().toLowerCase();
    let cl = '', em = '📄';
    if (e === 'pdf') { cl = 'pdf'; em = '📕'; }
    else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) { cl = 'zip'; em = '🗜️'; }
    else if (['doc', 'docx', 'txt', 'rtf'].includes(e)) { cl = 'doc'; em = '📝'; }
    else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(e)) { cl = 'img'; em = '🖼️'; }
    else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) { cl = 'video'; em = '🎬'; }
    else if (['mp3', 'wav', 'ogg', 'm4a'].includes(e)) { cl = 'audio'; em = '🎵'; }
    return '<a class="msg-file" href="' + m.content + '" download="' + escapeAttr(m.file_name || 'file') + '" onclick="event.stopPropagation()">' +
        '<div class="file-icon ' + cl + '">' + em + '</div>' +
        '<div class="file-info"><div class="file-name">' + escapeHtml(m.file_name || 'Файл') + '</div>' +
        '<div class="file-size">' + formatSize(m.file_size || 0) + '</div></div></a>';
}

function renderVoice(m) {
    const d = m.duration || 0;
    let b = '';
    for (let i = 0; i < 28; i++) b += '<div class="voice-bar" style="height:' + (6 + Math.random() * 16) + 'px"></div>';
    return '<div class="msg-voice" onclick="event.stopPropagation();openAudioModal(\'' + escapeAttr(m.content) + '\')">' +
        '<button class="voice-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
        '<div class="voice-body"><div class="voice-wave">' + b + '</div>' +
        '<div class="voice-meta"><span>Голосовое</span><span>' + formatDuration(d) + '</span></div></div></div>';
}

function appendMessage(m) {
    const c = $('messagesContainer');
    const e = c.querySelector('.no-users');
    if (e) e.remove();
    c.insertAdjacentHTML('beforeend', renderMessage(m));
    c.scrollTop = c.scrollHeight;
    attachMsgHandlers();
}

function attachMsgHandlers() {
    document.querySelectorAll('.message').forEach(el => {
        if (el.dataset.h) return;
        el.dataset.h = '1';
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            showMsgMenu(el, e.clientX, e.clientY);
        });
        let t;
        el.addEventListener('touchstart', e => {
            t = setTimeout(() => {
                const c = e.touches[0];
                showMsgMenu(el, c.clientX, c.clientY);
            }, 500);
        }, { passive: true });
        el.addEventListener('touchend', () => clearTimeout(t));
        el.addEventListener('touchmove', () => clearTimeout(t));
    });
}

function scrollToMsg(id) {
    const el = document.querySelector('.message[data-msg-id="' + id + '"]');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const o = el.style.background;
        el.style.background = 'rgba(6,214,160,.3)';
        setTimeout(() => { el.style.background = o; }, 800);
    }
}

function goBackToMain() {
    currentChat = null;
    currentMessages = [];
    replyTo = null;
    editingId = null;
    cancelReply();
    cancelEdit();
    $('chatScreen').classList.remove('active');
    $('mainScreen').classList.add('active');
    renderUsers($('searchInput').value);
}

/* ============================================================
   SEND MESSAGE
   ============================================================ */
async function sendMessage() {
    if (!currentChat) return;
    if (blockedUsers.has(currentChat.username)) { showToast('Заблокирован'); return; }
    const input = $('messageInput');
    const text = input.value.trim();
    if (!text && !editingId) return;

    if (editingId) {
        await API.editMessage(editingId, text);
        cancelEdit();
        input.value = '';
        showToast('Изменено');
        return;
    }

    const m = {
        sender: currentUser.username,
        receiver: currentChat.username,
        type: 'text',
        content: text
    };
    if (replyTo) m.reply_to = { id: replyTo.id, sender: replyTo.sender, preview: replyTo.preview };
    await API.sendMessage(m);
    input.value = '';
    input.focus();
    cancelReply();
}

function handleTyping() {
    if (!IS_SERVER || !socket || !currentChat) return;
    if (!typingSent) {
        socket.emit('typing', { token: authToken, to: currentChat.username });
        typingSent = true;
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing', { token: authToken, to: currentChat.username });
        typingSent = false;
    }, 1500);
}

/* ============================================================
   REPLY / EDIT
   ============================================================ */
function startReply(id) {
    const m = currentMessages.find(x => x.id === id);
    if (!m) return;
    replyTo = {
        id: m.id,
        sender: m.sender,
        preview: m.type === 'text' ? m.content.slice(0, 80) : fmtPrev(m)
    };
    $('replyName').textContent = '↩️ ' + (m.sender === currentUser.username ? 'Вы' : m.sender);
    $('replyText').textContent = replyTo.preview;
    $('replyBar').classList.add('active');
    $('messageInput').focus();
}

function cancelReply() {
    replyTo = null;
    $('replyBar').classList.remove('active');
}

function startEdit(id) {
    const m = currentMessages.find(x => x.id === id);
    if (!m || m.sender !== currentUser.username) return;
    if (m.type !== 'text') { showToast('Только текст'); return; }
    editingId = id;
    const i = $('messageInput');
    i.value = m.content;
    i.focus();
    $('editText').textContent = m.content.slice(0, 80);
    $('editBar').classList.add('active');
}

function cancelEdit() {
    editingId = null;
    $('editBar').classList.remove('active');
    $('messageInput').value = '';
}

/* ============================================================
   MENUS
   ============================================================ */
function showMsgMenu(el, x, y) {
    const id = parseInt(el.dataset.msgId);
    const s = el.dataset.sender;
    selectedMsgId = id;
    const menu = $('msgMenu');
    const own = s === currentUser.username;
    const m = currentMessages.find(x => x.id === id);
    $('msgEdit').style.display = (own && m && m.type === 'text') ? 'flex' : 'none';
    $('msgDelete').style.display = own ? 'flex' : 'none';
    menu.classList.add('active');
    const W = 220, H = 200;
    let l = x, t = y;
    if (l + W > window.innerWidth) l = window.innerWidth - W - 10;
    if (t + H > window.innerHeight) t = window.innerHeight - H - 10;
    if (l < 10) l = 10;
    if (t < 10) t = 10;
    menu.style.left = l + 'px';
    menu.style.top = t + 'px';
}

function hideMsgMenu() {
    $('msgMenu').classList.remove('active');
    selectedMsgId = null;
}

function toggleChatMenu() {
    const m = $('chatMenu');
    if (m.classList.contains('active')) { m.classList.remove('active'); return; }
    m.classList.add('active');
    const b = $('chatMenuBtn');
    const r = b.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.right = (window.innerWidth - r.right) + 'px';
    m.style.left = 'auto';
}

function closeChatMenu() {
    $('chatMenu').classList.remove('active');
}

function blockUser() {
    showGuiDialog('🚫', 'Заблокировать ' + currentChat.username + '?', 'Не сможет писать и звонить', () => {
        blockedUsers.add(currentChat.username);
        saveBlocked();
        updateBlockedUI();
        if (IS_SERVER && socket) socket.emit('block_user', { token: authToken, user: currentChat.username });
        showToast('Заблокирован');
    }, true);
}

function unblockUser() {
    showGuiDialog('🔓', 'Разблокировать?', '', () => {
        blockedUsers.delete(currentChat.username);
        saveBlocked();
        updateBlockedUI();
        if (IS_SERVER && socket) socket.emit('unblock_user', { token: authToken, user: currentChat.username });
        showToast('Разблокирован');
    });
}

/* ============================================================
   FILES
   ============================================================ */
async function handleFileSelect(e, mode) {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    const mx = mode === 'media' ? 15 * 1024 * 1024 : 20 * 1024 * 1024;
    if (f.size > mx) { showToast('Слишком большой'); return; }
    let t = 'file';
    if (f.type.startsWith('image/')) t = 'image';
    else if (f.type.startsWith('video/')) t = 'video';
    else if (f.type.startsWith('audio/')) t = 'audio';
    const pc = $('previewContent');
    if (t === 'image' || t === 'video') {
        const u = URL.createObjectURL(f);
        if (t === 'image') pc.innerHTML = '<img src="' + u + '">';
        else pc.innerHTML = '<video src="' + u + '" controls></video>';
    } else {
        pc.innerHTML = '<div style="text-align:center;color:#fff">' +
            '<div style="font-size:70px;margin-bottom:16px">📎</div>' +
            '<div style="font-size:15px">' + escapeHtml(f.name) + '</div></div>';
    }
    $('previewName').textContent = f.name;
    $('previewSize').textContent = formatSize(f.size);
    $('previewModal').classList.add('active');
    pendingPreview = { file: f, type: t };
}

async function sendPreview() {
    if (!pendingPreview) return;
    const { file, type } = pendingPreview;
    closePreview();
    showUploadOverlay();
    try {
        const d = await API.upload(file);
        if (d.error) throw new Error(d.error);
        const m = {
            sender: currentUser.username,
            receiver: currentChat.username,
            type: type,
            content: d.url,
            file_name: d.file_name,
            file_size: d.file_size
        };
        if (replyTo) m.reply_to = { id: replyTo.id, sender: replyTo.sender, preview: replyTo.preview };
        await API.sendMessage(m);
        cancelReply();
    } catch (err) { showToast(err.message); }
    finally { hideUploadOverlay(); pendingPreview = null; }
}

function closePreview() {
    $('previewModal').classList.remove('active');
    $('previewContent').innerHTML = '';
}

function showUploadOverlay() {
    $('uploadOverlay').classList.add('active');
    const b = $('uploadBar');
    b.style.width = '0%';
    let p = 0;
    const i = setInterval(() => {
        p = Math.min(90, p + Math.random() * 15);
        b.style.width = p + '%';
        if (p >= 90) clearInterval(i);
    }, 150);
}

function hideUploadOverlay() {
    const b = $('uploadBar');
    b.style.width = '100%';
    setTimeout(() => {
        $('uploadOverlay').classList.remove('active');
        b.style.width = '0%';
    }, 300);
}

/* ============================================================
   VOICE
   ============================================================ */
async function toggleRecording() {
    if (!currentChat) return;
    if (blockedUsers.has(currentChat.username)) { showToast('Заблокирован'); return; }
    const b = $('voiceBtn');
    if (!isRecording) {
        try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(s);
            audioChunks = [];
            const st = Date.now();
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.onstop = async () => {
                const dur = (Date.now() - st) / 1000;
                const bl = new Blob(audioChunks, { type: 'audio/webm' });
                if (bl.size > 5 * 1024 * 1024) { showToast('Слишком длинное'); s.getTracks().forEach(t => t.stop()); return; }
                const f = new File([bl], 'voice_' + Date.now() + '.webm', { type: 'audio/webm' });
                showUploadOverlay();
                try {
                    const d = await API.upload(f);
                    if (d.error) throw new Error(d.error);
                    const m = {
                        sender: currentUser.username,
                        receiver: currentChat.username,
                        type: 'audio',
                        content: d.url,
                        file_name: d.file_name,
                        file_size: d.file_size,
                        duration: dur
                    };
                    if (replyTo) m.reply_to = { id: replyTo.id, sender: replyTo.sender, preview: replyTo.preview };
                    await API.sendMessage(m);
                    cancelReply();
                } catch (e) { showToast('Ошибка'); }
                finally { hideUploadOverlay(); }
                s.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start();
            isRecording = true;
            b.classList.add('recording');
            showToast('🎤 Запись');
        } catch (e) { showToast('Нет доступа к микрофону'); }
    } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        isRecording = false;
        b.classList.remove('recording');
    }
}

/* ============================================================
   VIEWERS
   ============================================================ */
function openImageModal(type, src) {
    const m = $('imageModal');
    const c = $('imageModalContent');
    c.innerHTML = type === 'image'
        ? '<img src="' + src + '">'
        : '<video src="' + src + '" controls autoplay></video>';
    m.classList.add('active');
}

function closeImageModal() {
    $('imageModal').classList.remove('active');
    $('imageModalContent').innerHTML = '';
}

function openAudioModal(src) {
    const m = $('audioModal');
    const a = $('fullAudio');
    const b = $('audioPlayBtn');
    const t = $('audioTime');
    const w = $('audioWave');
    w.innerHTML = '';
    for (let i = 0; i < 32; i++) {
        const x = document.createElement('div');
        x.className = 'bar';
        x.style.height = (8 + Math.random() * 45) + 'px';
        w.appendChild(x);
    }
    a.src = src;
    m.classList.add('active');
    b.textContent = '▶';
    const upd = () => {
        if (a.duration && !isNaN(a.duration)) {
            t.textContent = formatDuration(a.currentTime) + ' / ' + formatDuration(a.duration);
            const bs = w.querySelectorAll('.bar');
            const idx = Math.floor((a.currentTime / a.duration) * bs.length);
            bs.forEach((x, i) => {
                x.style.opacity = i <= idx ? '1' : '.3';
                x.style.transform = i <= idx ? 'scaleY(1.2)' : 'scaleY(.7)';
            });
        }
        if (!a.paused) currentAudioRAF = requestAnimationFrame(upd);
    };
    a.onloadedmetadata = () => { t.textContent = '00:00 / ' + formatDuration(a.duration); };
    a.onplay = () => { b.textContent = '⏸'; if (currentAudioRAF) cancelAnimationFrame(currentAudioRAF); currentAudioRAF = requestAnimationFrame(upd); };
    a.onpause = () => { b.textContent = '▶'; if (currentAudioRAF) cancelAnimationFrame(currentAudioRAF); };
    a.onended = () => { b.textContent = '▶'; };
    setTimeout(() => a.play().catch(() => {}), 200);
}

function toggleFullAudio() {
    const a = $('fullAudio');
    if (a.paused) a.play().catch(() => {});
    else a.pause();
}

function closeAudioModal() {
    const a = $('fullAudio');
    a.pause();
    a.currentTime = 0;
    a.src = '';
    $('audioModal').classList.remove('active');
    if (currentAudioRAF) cancelAnimationFrame(currentAudioRAF);
}

/* ============================================================
   ЗВОНКИ
   ============================================================ */
async function startCall(video) {
    if (!currentChat || !IS_SERVER) { showToast('Нужен сервер'); return; }
    if (blockedUsers.has(currentChat.username)) { showToast('Заблокирован'); return; }
    if (!onlineUsers.has(currentChat.username)) { showToast(currentChat.username + ' не в сети'); return; }
    callState = 'calling';
    callPeer = currentChat.username;
    callIsVideo = video;
    showCallUI(currentChat, 'Вызов...');
    socket.emit('call_invite', { token: authToken, to: currentChat.username, video: video });
}

async function handleIncomingCall(from, video) {
    if (callState !== 'idle') {
        socket.emit('call_reject', { token: authToken, to: from });
        return;
    }
    if (blockedUsers.has(from)) {
        socket.emit('call_reject', { token: authToken, to: from });
        return;
    }
    callState = 'incoming';
    incomingCaller = from;
    incomingIsVideo = video;
    try {
        const us = await API.users();
        const u = us.find(x => x.username === from);
        $('incomingAvatar').src = u ? u.avatar : '';
        $('incomingName').textContent = from;
        $('incomingCall').classList.add('active');
    } catch (e) {}
}

async function acceptIncomingCall() {
    $('incomingCall').classList.remove('active');
    callState = 'active';
    callPeer = incomingCaller;
    callIsVideo = incomingIsVideo;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callIsVideo });
    } catch (e) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            callIsVideo = false;
        } catch (e2) {
            showToast('Нет доступа к микрофону');
            cleanupCall();
            return;
        }
    }
    showCallUI({ username: callPeer, avatar: $('incomingAvatar').src }, 'Соединение...');
    $('callLocalWrap').style.display = callIsVideo ? 'block' : 'none';
    $('callLocalVideo').srcObject = localStream;
    createPeerConnection();
    addLocalTracks();
    socket.emit('call_accept', { token: authToken, to: callPeer });
    setTimeout(async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_signal', { token: authToken, to: callPeer, signal: { type: 'offer', sdp: offer.sdp } });
    }, 300);
}

function rejectIncomingCall() {
    $('incomingCall').classList.remove('active');
    socket.emit('call_reject', { token: authToken, to: incomingCaller });
    cleanupCall();
}

async function handleCallAccepted(by) {
    if (callState !== 'calling') return;
    callState = 'active';
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callIsVideo });
    } catch (e) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            callIsVideo = false;
        } catch (e2) {
            showToast('Нет микрофона');
            cleanupCall();
            socket.emit('call_end', { token: authToken, to: by });
            return;
        }
    }
    $('callStatus').textContent = 'Соединение...';
    $('callLocalWrap').style.display = callIsVideo ? 'block' : 'none';
    $('callLocalVideo').srcObject = localStream;
    createPeerConnection();
    addLocalTracks();
    setTimeout(async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_signal', { token: authToken, to: by, signal: { type: 'offer', sdp: offer.sdp } });
    }, 300);
}

function createPeerConnection() {
    pc = new RTCPeerConnection(ICE_SERVERS);
    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('webrtc_signal', {
            token: authToken,
            to: callPeer,
            signal: { type: 'ice', candidate: e.candidate }
        });
    };
    pc.ontrack = e => {
        remoteStream = e.streams[0];
        $('callRemoteVideo').srcObject = remoteStream;
        $('callAvatarPlaceholder').style.display = 'none';
        $('callStatus').textContent = 'Соединено';
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            showToast('Связь потеряна');
            endCall();
        }
    };
}

function addLocalTracks() {
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
}

async function handleSignal(from, signal) {
    if (signal.type === 'offer') {
        if (!pc) {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callIsVideo });
            } catch (e) {
                try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
                catch (e2) { return; }
            }
            createPeerConnection();
            addLocalTracks();
        }
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('webrtc_signal', { token: authToken, to: from, signal: { type: 'answer', sdp: ans.sdp } });
    } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice') {
        if (pc) try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) {}
    }
}

function showCallUI(user, status) {
    $('callName').textContent = user.username;
    $('callStatus').textContent = status;
    $('callAvatarImg').src = user.avatar;
    $('callAvatarPlaceholder').style.display = 'block';
    $('callRemoteVideo').style.display = 'none';
    $('callOverlay').classList.add('active');
    $('callMicBtn').classList.remove('off');
    $('callCamBtn').classList.toggle('off', !callIsVideo);
}

function endCall() {
    if (callPeer) socket.emit('call_end', { token: authToken, to: callPeer });
    cleanupCall();
}

function cleanupCall() {
    callState = 'idle';
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    remoteStream = null;
    if (pc) { pc.close(); pc = null; }
    $('callOverlay').classList.remove('active');
    $('incomingCall').classList.remove('active');
    $('callRemoteVideo').srcObject = null;
    $('callLocalVideo').srcObject = null;
    callPeer = null;
    incomingCaller = null;
}

function toggleMic() {
    if (!localStream) return;
    const at = localStream.getAudioTracks()[0];
    if (!at) return;
    at.enabled = !at.enabled;
    callMuted = !at.enabled;
    $('callMicBtn').classList.toggle('off', callMuted);
}

function toggleCam() {
    if (!localStream) return;
    const vt = localStream.getVideoTracks()[0];
    if (!vt) { showToast('Камера не включена'); return; }
    vt.enabled = !vt.enabled;
    callCamOff = !vt.enabled;
    $('callCamBtn').classList.toggle('off', callCamOff);
    $('callLocalWrap').style.opacity = callCamOff ? '0' : '1';
}

async function switchCamera() {
    if (!localStream) return;
    const vt = localStream.getVideoTracks()[0];
    if (!vt) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === 'videoinput');
        if (cams.length < 2) { showToast('Одна камера'); return; }
        const cur = vt.getSettings().deviceId;
        const next = cams.find(c => c.deviceId !== cur) || cams[0];
        const ns = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: next.deviceId } },
            audio: false
        });
        const nvt = ns.getVideoTracks()[0];
        if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(nvt);
        }
        vt.stop();
        localStream.removeTrack(vt);
        localStream.addTrack(nvt);
        $('callLocalVideo').srcObject = localStream;
    } catch (e) { showToast('Не удалось'); }
}

/* ============================================================
   GLOBAL EXPORTS (для onclick в HTML)
   ============================================================ */
window.openChat = openChat;
window.openImageModal = openImageModal;
window.openAudioModal = openAudioModal;
window.scrollToMsg = scrollToMsg;