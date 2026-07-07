const DEFAULT_MODEL = 'claude-sonnet-4-6';
const POLL_MS = 15000;
const FAST_POLL_MS = 3000;
const CHAT_POLL_MS = 2000;
const TRANSITIONAL = new Set(['Pending', 'Creating', 'Stopping']);
const BUSY_PHASES = new Set(['Pending', 'Creating', 'Running', 'Stopping']);
const STARTABLE_PHASES = new Set(['', 'Stopped', 'Failed', 'Completed']);
const MESSAGE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

const state = {
  config: null,
  token: null,
  sessions: [],
  pollTimer: null,
  pollInFlight: false,
  activeChat: null,
  streamAbort: null,
  chatPollTimer: null,
  repoHistory: [],
  notifications: [],
  previousPhases: new Map(),
};

const $ = (id) => document.getElementById(id);
const views = ['setupView', 'sessionsView', 'createView', 'chatView'];

function showView(id) {
  for (const v of views) $(v).classList.toggle('hidden', v !== id);
}

function overlay(id) {
  $('createView').classList.add('hidden');
  $('chatView').classList.add('hidden');
  if (id) $(id).classList.remove('hidden');
}

function normalizeBaseUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function clusterName(url) {
  try {
    return new URL(url).hostname.split('.')[0] || 'ACP';
  } catch {
    return 'ACP';
  }
}

function setStatus(kind) {
  const dot = $('statusDot');
  dot.className = `dot ${kind || 'gray'}`;
}

function toast(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('toasts')?.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function storageGet(keys) {
  const out = {};
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    try { out[key] = raw ? JSON.parse(raw) : undefined; } catch { out[key] = raw || undefined; }
  }
  return Promise.resolve(out);
}

function storageSet(obj) {
  for (const [key, value] of Object.entries(obj)) localStorage.setItem(key, JSON.stringify(value));
  return Promise.resolve();
}

async function loadState() {
  const data = await storageGet(['acpConfig', 'acpToken', 'repoHistory', 'notifications']);
  state.config = data.acpConfig || null;
  state.token = data.acpToken || null;
  state.repoHistory = data.repoHistory || [];
  state.notifications = data.notifications || [];
  const theme = state.config?.theme || 'light';
  document.body.dataset.theme = theme;
  if (state.config?.baseUrl) $('clusterButton').textContent = clusterName(state.config.baseUrl);
}

function apiPath(path) {
  return `${state.config.baseUrl}/api/ambient/v1${path}`;
}

async function api(path, options = {}) {
  if (!state.config?.baseUrl || !state.token?.access_token) throw new Error('ACP is not configured');
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${state.token.access_token}`);
  headers.set('Accept', headers.get('Accept') || 'application/json');
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
  if (state.config.projectName) headers.set('X-Ambient-Project', state.config.projectName);

  const res = await fetch(apiPath(path), { ...options, headers });
  if (res.status === 401) {
    setStatus('red');
    throw new Error('Authentication failed. Paste a fresh bearer token in settings.');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.reason || body?.message || body?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function sessionItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function canonicalPhase(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function sessionPhase(session) {
  if (!session) return '';
  return canonicalPhase(session.phase || session.lifecycle_phase || session.status?.phase || session.status || session.state);
}

function phaseLabel(session) {
  return sessionPhase(session) || 'Ready';
}

function canStartSession(session) {
  return STARTABLE_PHASES.has(sessionPhase(session));
}

function canStopSession(session) {
  return BUSY_PHASES.has(sessionPhase(session));
}

function canDeleteSession(session) {
  return !canStopSession(session);
}

function mergeSession(next) {
  if (!next?.id) return;
  const index = state.sessions.findIndex((s) => s.id === next.id);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...next };
  else state.sessions = [next, ...state.sessions];
}

function shortAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function localTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return MESSAGE_TIME_FORMAT.format(date);
}

async function refreshSessions({ silent = false } = {}) {
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    setStatus('yellow');
    const body = await api('/sessions?size=100&orderBy=created_at desc');
    const nextSessions = sessionItems(body);
    detectSessionNotifications(nextSessions);
    state.sessions = nextSessions;
    renderSessions();
    renderNotifications();
    setStatus('green');
    if (!silent) toast('Sessions refreshed', 'success');
    schedulePoll(state.sessions.some((s) => TRANSITIONAL.has(sessionPhase(s))) ? FAST_POLL_MS : POLL_MS);
  } catch (e) {
    setStatus('red');
    renderError(e.message);
    if (!silent) toast(e.message, 'error');
  } finally {
    state.pollInFlight = false;
  }
}

function schedulePoll(ms) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(() => refreshSessions({ silent: true }), ms);
}

function renderError(message) {
  $('sessionList').innerHTML = `<div class="empty">${escapeText(message)}</div>`;
}

function renderSessions() {
  $('activeProject').textContent = state.config?.projectName ? `Project: ${state.config.projectName}` : 'No project header set';
  renderNotifications();
  if (!state.sessions.length) {
    $('sessionList').innerHTML = '<div class="empty">No sessions found.</div>';
    return;
  }
  $('sessionList').innerHTML = state.sessions.map((s) => {
    const phase = phaseLabel(s);
    const prompt = s.prompt || s.repo_url || '';
    return `<article class="card" data-id="${escapeText(s.id)}">
      <div class="cardTop"><div><div class="name">${escapeText(s.name || s.id)}</div><div class="muted small">${escapeText(s.llm_model || '')} ${shortAge(s.created_at) ? ' · ' + shortAge(s.created_at) : ''}</div></div><span class="badge ${escapeText(phase)}">${escapeText(phase)}</span></div>
      <div class="preview">${escapeText(prompt)}</div>
      <div class="actions">
        <button data-act="chat">Chat</button>
        ${canStopSession(s) ? '<button data-act="stop">Stop</button>' : ''}
        ${canStartSession(s) ? '<button data-act="start">Start</button>' : ''}
        ${canDeleteSession(s) ? '<button data-act="delete">Delete</button>' : ''}
      </div>
    </article>`;
  }).join('');
}

async function validateAndSave() {
  const baseUrl = normalizeBaseUrl($('baseUrl').value);
  const projectName = $('projectName').value.trim();
  const access_token = $('token').value.trim().replace(/^Bearer\s+/i, '');
  if (!baseUrl || !access_token) return toast('Server URL and bearer token are required', 'error');
  state.config = { baseUrl, projectName, theme: document.body.dataset.theme || 'light' };
  state.token = { access_token, manual: true, expires_at: Date.now() + 24 * 3600 * 1000 };
  await storageSet({ acpConfig: state.config, acpToken: state.token });
  $('clusterButton').textContent = clusterName(baseUrl);
  showView('sessionsView');
  await refreshSessions();
}

async function openSettings() {
  clearTimeout(state.pollTimer);
  $('baseUrl').value = state.config?.baseUrl || '';
  $('projectName').value = state.config?.projectName || '';
  $('token').value = state.token?.access_token || '';
  showView('setupView');
}

function fillRepoHistory() {
  $('repoHistory').innerHTML = state.repoHistory.map((x) => `<option value="${escapeText(x)}"></option>`).join('');
}

async function rememberRepo(url) {
  if (!url) return;
  state.repoHistory = [url, ...state.repoHistory.filter((x) => x !== url)].slice(0, 20);
  await storageSet({ repoHistory: state.repoHistory });
}

async function createSession() {
  const body = {
    name: $('newName').value.trim(),
    repo_url: $('newRepo').value.trim(),
    prompt: $('newPrompt').value.trim(),
    llm_model: $('newModel').value || DEFAULT_MODEL,
    project_id: state.config.projectName || undefined,
  };
  if (!body.name) return toast('Session name is required', 'error');
  try {
    const created = await api('/sessions', { method: 'POST', body: JSON.stringify(body) });
    mergeSession(created);
    await rememberRepo(body.repo_url);
    toast('Session created', 'success');
    overlay(null);
    if ($('autoStart').checked && created?.id) mergeSession(await api(`/sessions/${encodeURIComponent(created.id)}/start`, { method: 'POST' }));
    renderSessions();
    await refreshSessions({ silent: true });
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function sessionAction(card, act) {
  const id = card.dataset.id;
  const session = state.sessions.find((s) => s.id === id);
  if (act === 'chat') return openChat(session);
  if (act === 'delete' || act === 'stop') {
    const existing = card.querySelector(`[data-confirm="${act}"]`);
    if (!existing) {
      const btn = card.querySelector(`[data-act="${act}"]`);
      btn.outerHTML = `<span data-confirm="${act}" class="actions"><button data-act="confirm-${act}">Confirm ${act}</button><button data-act="cancel">Cancel</button></span>`;
      return;
    }
  }
  try {
    if (act === 'start') {
      const latest = await api(`/sessions/${encodeURIComponent(id)}`);
      mergeSession(latest);
      if (!canStartSession(latest)) {
        renderSessions();
        return toast(`Session is ${phaseLabel(latest)}; start is not available.`, 'warning');
      }
      mergeSession(await api(`/sessions/${encodeURIComponent(id)}/start`, { method: 'POST' }));
    }
    if (act === 'confirm-stop') mergeSession(await api(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
    if (act === 'confirm-delete') {
      await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.sessions = state.sessions.filter((s) => s.id !== id);
    }
    if (act === 'cancel') return renderSessions();
    toast('Action completed', 'success');
    renderSessions();
    await refreshSessions({ silent: true });
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openChat(session) {
  if (!session?.id) return;
  stopMessageStream();
  state.activeChat = { id: session.id, name: session.name || session.id, lastSeq: 0 };
  $('chatTitle').textContent = state.activeChat.name;
  $('messages').innerHTML = '<div class="empty">Loading messages…</div>';
  overlay('chatView');
  try {
    const messages = await api(`/sessions/${encodeURIComponent(session.id)}/messages?after_seq=0`);
    renderMessages(Array.isArray(messages) ? messages : []);
    startMessageStream();
  } catch (e) {
    $('messages').innerHTML = `<div class="msg error">${escapeText(e.message)}</div>`;
  }
}

function renderMessages(messages, append = false) {
  if (!append) $('messages').innerHTML = '';
  if (!messages.length && !append) $('messages').innerHTML = '<div class="empty">No messages yet.</div>';
  for (const m of messages) addMessage(m);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function addMessage(m) {
  if (m.seq && state.activeChat) state.activeChat.lastSeq = Math.max(state.activeChat.lastSeq, m.seq);
  if (!shouldDisplayMessage(m)) return;
  detectMessageNotification(m);
  const display = messageDisplay(m);
  const timestamp = localTimestamp(m.created_at);
  const el = document.createElement('div');
  el.className = `msg ${display.role}`;
  el.innerHTML = `<div class="msgMeta"><span>${escapeText(display.label)}</span>${timestamp ? `<time datetime="${escapeText(m.created_at)}">${escapeText(timestamp)}</time>` : ''}</div><div>${escapeText(display.text)}</div>`;
  const empty = $('messages').querySelector('.empty');
  if (empty) empty.remove();
  $('messages').appendChild(el);
}

function parsePayload(payload) {
  if (payload == null) return '';
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function payloadText(payload) {
  const parsed = parsePayload(payload);
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed.value === 'object') return payloadText(parsed.value);
  if (typeof parsed.last_assistant_message === 'string') return parsed.last_assistant_message;
  if (typeof parsed.message === 'string') return parsed.message;
  if (typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.event === 'string') return parsed.event.replace(/_/g, ' ');
  return JSON.stringify(parsed, null, 2);
}

function shouldDisplayMessage(m) {
  const eventType = String(m.event_type || '').toLowerCase();
  const parsed = parsePayload(m.payload);
  if (eventType === 'lifecycle') return false;
  if (eventType === 'system' && typeof parsed === 'object' && String(parsed.custom_event || '').startsWith('hook:')) return false;
  return true;
}

function messageDisplay(m) {
  const eventType = String(m.event_type || 'message').toLowerCase();
  const parsed = parsePayload(m.payload);
  const text = payloadText(m.payload);
  if (eventType === 'user') return { role: 'user', label: 'You', text };
  if (eventType === 'assistant' || (typeof parsed === 'object' && parsed?.last_assistant_message)) {
    return { role: 'assistant', label: 'Assistant', text };
  }
  if (eventType === 'error') return { role: 'error', label: 'Error', text };
  if (eventType === 'lifecycle') return { role: 'lifecycle', label: 'Lifecycle', text };
  if (eventType === 'system') return { role: 'lifecycle', label: 'System', text };
  return { role: 'message', label: m.event_type || 'Message', text };
}

async function sendChat(e) {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const payload = $('chatInput').value.trim();
  if (!payload || !state.activeChat?.id) return;
  $('chatInput').value = '';
  addMessage({ event_type: 'user', payload });
  try {
    const created = await api(`/sessions/${encodeURIComponent(state.activeChat.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ event_type: 'user', payload }),
    });
    if (created?.seq) state.activeChat.lastSeq = Math.max(state.activeChat.lastSeq, created.seq);
    await pollMessagesOnce();
    scheduleChatPoll();
  } catch (e) {
    addMessage({ event_type: 'error', payload: e.message });
  }
}


function isInputNeededMessage(m) {
  const text = `${m.event_type || ''} ${payloadText(m.payload)}`.toLowerCase();
  return text.includes('askuserquestion') || text.includes('input needed') || text.includes('human-in-the-loop') || text.includes('requires input');
}

function addLocalNotification(kind, title, body, sessionId) {
  const n = { id: Date.now() + Math.random(), read: false, ts: new Date().toISOString(), kind, title, body, sessionId };
  state.notifications = [n, ...state.notifications].slice(0, 50);
  storageSet({ notifications: state.notifications });
  renderNotifications();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: `${kind}-${sessionId || n.id}`, icon: 'icons/icon128.png' }); } catch {}
  }
}

function detectSessionNotifications(nextSessions) {
  for (const s of nextSessions) {
    const old = state.previousPhases.get(s.id);
    const phase = phaseLabel(s);
    if (old && old !== phase) {
      if (phase === 'Failed') addLocalNotification('error', `ACP session failed`, s.name || s.id, s.id);
      if (phase === 'Completed' || phase === 'Stopped') addLocalNotification('run_finished', `ACP session ${phase.toLowerCase()}`, s.name || s.id, s.id);
    }
    state.previousPhases.set(s.id, phase);
  }
}

function detectMessageNotification(m) {
  if (!m) return;
  if ((m.event_type || '').toLowerCase() === 'error') addLocalNotification('error', 'ACP session error', payloadText(m.payload).slice(0, 140), m.session_id || state.activeChat?.id);
  if (isInputNeededMessage(m)) addLocalNotification('input_needed', 'ACP input needed', payloadText(m.payload).slice(0, 140), m.session_id || state.activeChat?.id);
}

function renderNotifications() {
  const unreadNotifications = state.notifications.filter((n) => !n.read);
  const unread = unreadNotifications.length;
  const badge = $('unreadBadge');
  if (badge) { badge.textContent = String(unread); badge.classList.toggle('hidden', unread === 0); }
  const panel = $('notificationPanel');
  if (!panel) return;
  if (!unreadNotifications.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="notificationHeader"><div><div class="eyebrow">Alerts</div><strong>${unread} unread ${unread === 1 ? 'notification' : 'notifications'}</strong></div><button id="markReadButton">Mark all read</button></div>` +
    unreadNotifications.slice(0, 3).map((n) => `<div class="notice ${escapeText(n.kind || '')}"><div class="noticeIcon">${notificationIcon(n.kind)}</div><div><strong>${escapeText(n.title)}</strong><div>${escapeText(n.body)}</div><div class="muted small">${new Date(n.ts).toLocaleString()}</div></div></div>`).join('');
  $('markReadButton')?.addEventListener('click', async () => {
    state.notifications = state.notifications.map((n) => ({ ...n, read: true }));
    await storageSet({ notifications: state.notifications });
    renderNotifications();
  });
}

function notificationIcon(kind) {
  if (kind === 'error') return '!';
  if (kind === 'input_needed') return '?';
  return 'i';
}

async function enableNotifications() {
  if (!('Notification' in window)) return toast('Browser notifications are not supported here', 'warning');
  const result = await Notification.requestPermission();
  toast(result === 'granted' ? 'Notifications enabled' : 'Notifications not enabled', result === 'granted' ? 'success' : 'warning');
}

async function startMessageStream() {
  stopMessageStream();
  if (!state.activeChat) return;
  scheduleChatPoll(500);
}

async function pollMessagesOnce() {
  if (!state.activeChat?.id) return [];
  const chatId = state.activeChat.id;
  const afterSeq = state.activeChat.lastSeq || 0;
  try {
    const messages = await api(`/sessions/${encodeURIComponent(chatId)}/messages?after_seq=${afterSeq}`);
    if (!state.activeChat || state.activeChat.id !== chatId) return [];
    const list = Array.isArray(messages) ? messages : [];
    renderMessages(list, true);
    return list;
  } catch (e) {
    if (state.activeChat?.id === chatId) addMessage({ event_type: 'error', payload: e.message });
    return [];
  }
}

function scheduleChatPoll(delay = CHAT_POLL_MS) {
  clearTimeout(state.chatPollTimer);
  if (!state.activeChat) return;
  state.chatPollTimer = setTimeout(async () => {
    await pollMessagesOnce();
    if (state.activeChat) scheduleChatPoll();
  }, delay);
}

function stopMessageStream() {
  if (state.streamAbort) state.streamAbort.abort();
  state.streamAbort = null;
  clearTimeout(state.chatPollTimer);
  state.chatPollTimer = null;
}

function handleChatInputKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  $('chatForm').requestSubmit();
}

function bind() {
  $('saveConfig').addEventListener('click', validateAndSave);
  $('refreshButton').addEventListener('click', () => refreshSessions());
  $('settingsButton').addEventListener('click', openSettings);
  $('createButton').addEventListener('click', () => { fillRepoHistory(); overlay('createView'); });
  $('submitCreate').addEventListener('click', createSession);
  $('chatForm').addEventListener('submit', sendChat);
  $('chatInput').addEventListener('keydown', handleChatInputKeydown);
  document.querySelectorAll('.backButton').forEach((b) => b.addEventListener('click', () => { stopMessageStream(); overlay(null); }));
  $('sessionList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const card = e.target.closest('.card');
    if (btn && card) sessionAction(card, btn.dataset.act);
  });
  $('notifyButton')?.addEventListener('click', enableNotifications);
  $('themeButton').addEventListener('click', async () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    document.body.dataset.theme = next;
    state.config = { ...(state.config || {}), theme: next };
    await storageSet({ acpConfig: state.config });
  });
  $('clusterButton').addEventListener('click', async () => {
    if (state.config?.baseUrl) {
      await navigator.clipboard.writeText(state.config.baseUrl);
      toast('Server URL copied', 'success');
    }
  });
}

(async function init() {
  bind();
  await loadState();
  if (state.config?.baseUrl && state.token?.access_token) {
    showView('sessionsView');
    await refreshSessions({ silent: true });
  } else {
    showView('setupView');
  }
})();
