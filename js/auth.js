// auth.js - Authentication state and Supabase integration
import { send, on } from './ws.js';
import { getSupabaseClient } from './supabase.js';

const AUTH_KEY      = 'ipai_auth_v1';
const TEMP_ID_KEY   = 'ipai_temp_id';
const CLIENT_ID_KEY = 'ipai_client_id';
const OAUTH_CHANNEL = 'ipai_oauth_channel';

export let currentUser      = null;
export let userProfile      = null;
export let userSettings     = null;
export let subscriptionInfo = null;
const supabase = getSupabaseClient();
const oauthChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel(OAUTH_CHANNEL)
  : null;
let lastOAuthToken = '';
let lastOAuthTokenAt = 0;

const authListeners = new Set();

export function onAuthChange(fn) { authListeners.add(fn); return () => authListeners.delete(fn); }
export function isAuthenticated() { return !!currentUser; }

function notifyListeners() {
  authListeners.forEach(fn => fn({ currentUser, userProfile, userSettings }));
}

purgeLegacySensitiveLocalStorage();

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) { id = `web-${crypto.randomUUID()}`; localStorage.setItem(CLIENT_ID_KEY, id); }
  return id;
}
export function getTempId() {
  let id = localStorage.getItem(TEMP_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(TEMP_ID_KEY, id); }
  return id;
}
export function saveAuth(data)  { try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(data)); } catch {} }
export function loadAuth()      { try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } }
export function clearAuth()     { try { sessionStorage.removeItem(AUTH_KEY); } catch {} }

function purgeLegacySensitiveLocalStorage() {
  try {
    localStorage.removeItem(AUTH_KEY);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      // Supabase auth tokens created by older clients.
      if (/^sb-.*-auth-token$/i.test(key) || /^supabase\.auth\.token$/i.test(key)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {}
}

export async function loginWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message || 'Sign in failed');
  if (!data?.session?.access_token) throw new Error('No access token');
  await handleSupabaseSession(data.session, { showWelcome: true });
  return data;
}

export async function signUpWithEmail(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message || 'Sign up failed');
  if (data?.session?.access_token) await handleSupabaseSession(data.session, { showWelcome: true });
  return data;
}

/**
 * OAuth login via popup.
 * The popup posts tokens back via BroadcastChannel and postMessage.
 */
export async function loginWithOAuth(provider) {
  const isChatRoute = location.pathname.startsWith('/chat');

  const callbackPath = isChatRoute
    ? '/chat/oauth-callback.html'
    : '/oauth-callback.html';

  const redirectTo = `${location.origin}${callbackPath}`;
  switch (provider) {
    case "github":
      break;
    case "google":
      break;
    case "discord":
      break;
    case "azure":
      break;
    case "custom:huggingface":
      break;
    case "microsoft":
      provider = "azure";
      break;
    case "huggingface":
      provider = "custom:huggingface";
      break;
    default:
      break;
  }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo
    },
  });
  if (error) throw new Error(error.message || 'OAuth sign in failed');
}

export async function logout() {
  try { await supabase.auth.signOut(); } catch {}
  send({ type: 'auth:logout' });
  clearAuth();
  purgeLegacySensitiveLocalStorage();
  currentUser = null; userProfile = null; userSettings = null; subscriptionInfo = null;
  notifyListeners();
  updateSidebarProfile();
  initAsGuest();
  import('./app.js').then((m) => m.resetToNewChatView()).catch(() => {});
}

// ── Session handling ──────────────────────────────────────────────────────

async function handleSupabaseSession(data, { showWelcome = false } = {}) {
  const session = await normalizeSessionPayload(data);
  console.log('[Frontend Auth] handleSupabaseSession called with token:', session?.access_token?.slice(0, 20) + '...');
  if (!session?.access_token) throw new Error('No access token');
  const existingAuth = loadAuth() || {};
  saveAuth({
    ...existingAuth,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user: session.user || existingAuth.user || null,
  });

  return new Promise((resolve, reject) => {
    const tempId   = getTempId();
    const clientId = getClientId();
    console.log('[Frontend Auth] Sending auth:login to backend with token:', session.access_token?.slice(0, 20) + '...');
    send({ type: 'auth:login', accessToken: session.access_token, refreshToken: session.refresh_token,
      tempId, clientId, deviceToken: existingAuth.deviceToken || null });

    const unsubOk  = on('auth:ok',    (msg) => {
      console.log('[Frontend Auth] Received auth:ok response');
      unsubOk();
      unsubErr();
      applyAuthOk(msg);
      if (showWelcome) {
        import('./app.js').then((m) => m.resetToNewChatView()).catch(() => {});
      }
      resolve(msg);
    });
    const unsubErr = on('auth:error', (msg) => { 
      console.error('[Frontend Auth] Received auth:error:', msg.message);
      unsubOk(); unsubErr(); reject(new Error(msg.message));
    });

    setTimeout(() => { unsubOk(); unsubErr(); reject(new Error('Auth timeout')); }, 12000);
  });
}

async function normalizeSessionPayload(input) {
  if (!input) return null;
  if (input.session?.access_token) return input.session;
  if (input.access_token) {
    if (input.user) return input;
    try {
      const { data } = await supabase.auth.getUser(input.access_token);
      return { ...input, user: data?.user || null };
    } catch {
      return input;
    }
  }
  return null;
}

function applyAuthOk(msg) {
  console.log('[Frontend Auth] applyAuthOk called with msg:', msg);
  currentUser  = { id: msg.userId, email: msg.email };
  userProfile  = msg.profile;
  userSettings = msg.settings;
  subscriptionInfo = msg.subscription || null;
  console.log('[Frontend Auth] Subscription info set to:', subscriptionInfo);
  console.log('[Frontend Auth] subscriptionInfo?.planKey:', subscriptionInfo?.planKey);
  console.log('[Frontend Auth] subscriptionInfo?.planName:', subscriptionInfo?.planName);
  const auth = loadAuth() || {};
  saveAuth({ ...auth, userId: msg.userId, deviceToken: msg.deviceToken });
  notifyListeners();
  console.log('[Frontend Auth] Calling updateSidebarProfile...');
  updateSidebarProfile();
  // Apply saved theme
  if (msg.settings?.theme) {
    import('./settings.js').then(m => m.applyTheme(msg.settings.theme));
  }
}

function initAsGuest() {
  send({ type: 'auth:guest', tempId: getTempId() });
}

// ── WS events ─────────────────────────────────────────────────────────────

on('auth:newLogin', (msg) => {
  import('./ui.js').then(({ showNotification }) => {
    showNotification({
      type: 'warning',
      message: `New login detected from ${msg.ip || 'unknown location'}`,
      action: { label: 'View', onClick: () => import('./settings.js').then(m => m.openSettings('account')) },
      duration: 8000,
    });
  });
});

on('auth:forcedLogout', (msg) => {
  import('./ui.js').then(({ showNotification }) => {
    showNotification({ type: 'error', message: msg.reason || 'Session revoked', duration: 5000 });
  });
  setTimeout(() => logout(), 1500);
});

on('settings:updated', (msg) => {
  if (msg.settings) {
    userSettings = msg.settings;
    import('./settings.js').then(m => m.applyTheme(msg.settings.theme));
  }
});

// ── Reconnect on WS connect ────────────────────────────────────────────────

on('ws:connected', async () => {
  console.log('[Frontend Auth] WS connected event');
  const auth = loadAuth();
  console.log('[Frontend Auth] Loaded auth:', auth ? 'exists' : 'null');
  if (auth?.access_token) {
    try {
      console.log('[Frontend Auth] Attempting to resume session with existing token');
      await handleSupabaseSession(auth, { showWelcome: false });
    }
    catch (err) {
      console.error('[Frontend Auth] Failed to resume session:', err);
      clearAuth();
      initAsGuest();
    }
  } else {
    console.log('[Frontend Auth] No stored auth, initializing as guest');
    initAsGuest();
  }
});

async function processOAuthTokens(tokens, source = 'unknown') {
  if (!tokens?.access_token) {
    console.warn('[Frontend Auth] No access token in OAuth response from', source);
    return;
  }
  if (tokens.access_token === lastOAuthToken && (Date.now() - lastOAuthTokenAt) < 3000) {
    return;
  }
  lastOAuthToken = tokens.access_token;
  lastOAuthTokenAt = Date.now();
  console.log('[Frontend Auth] Processing OAuth tokens from', source, tokens.access_token?.slice(0, 20) + '...');
  try {
    await handleSupabaseSession(tokens, { showWelcome: true });
    import('./ui.js').then(({ showNotification }) =>
      showNotification({ type: 'success', message: 'Signed in!', duration: 2500 }));
  } catch (err) {
    console.error('[Frontend Auth] OAuth sign-in error:', err);
    import('./ui.js').then(({ showNotification }) =>
      showNotification({ type: 'error', message: `Sign-in failed: ${err.message}`, duration: 4000 }));
  }
}

oauthChannel?.addEventListener('message', (event) => {
  if (event?.data?.type !== 'oauth:callback') return;
  processOAuthTokens(event.data, 'broadcast-channel').catch(() => {});
});

// Also handle same-tab redirect flow (no popup) — ?oauth=1&t=TOKEN&r=REFRESH
(function checkOAuthRedirect() {
  const params = new URLSearchParams(location.search);
  const t = params.get('t'), r = params.get('r');
  console.log('[Frontend Auth] Checking for OAuth redirect params:', t ? 'found token' : 'no token');
  if (params.get('oauth') === '1' && t) {
    console.log('[Frontend Auth] Processing OAuth redirect with token:', t.slice(0, 20) + '...');
    const cleanPath = location.pathname.startsWith('/chat') ? '/chat/' : '/';
    history.replaceState({}, '', cleanPath);
    handleSupabaseSession({ access_token: t, refresh_token: r || '' }, { showWelcome: true }).catch((err) => {
      console.error('[Frontend Auth] OAuth redirect failed:', err);
    });
  }
})();

// Legacy postMessage support (kept for backwards compat with old callback pages)
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type !== 'oauth:callback') return;
  console.log('[Frontend Auth] postMessage oauth:callback received');
  processOAuthTokens(e.data, 'postMessage').catch(() => {});
});

// ── Sidebar profile ───────────────────────────────────────────────────────

export function updateSidebarProfile() {
  console.log('[Frontend Auth] updateSidebarProfile called - currentUser:', currentUser);
  const guestEl = document.getElementById('guest-section');
  const userEl  = document.getElementById('user-section');
  const nameEl  = document.getElementById('user-name-display');
  const planEl  = document.getElementById('user-plan-display');
  const avatarEl= document.getElementById('user-avatar');

  if (!currentUser) {
    console.log('[Frontend Auth] Not logged in, showing guest section');
    guestEl?.classList.remove('hidden');
    userEl?.classList.add('hidden');
    return;
  }
  guestEl?.classList.add('hidden');
  userEl?.classList.remove('hidden');

  const username = userProfile?.username || currentUser.email?.split('@')[0] || '?';
  if (nameEl)   nameEl.textContent = username;
  if (avatarEl) avatarEl.textContent = username[0].toUpperCase();

  const plan     = subscriptionInfo?.planKey || 'free';
  const planName = subscriptionInfo?.planName || 'Free';
  console.log('[Frontend Auth] Setting plan display - plan:', plan, 'planName:', planName, 'subscriptionInfo:', subscriptionInfo);
  if (planEl) { planEl.textContent = planName; planEl.setAttribute('data-plan', plan); }
  if (avatarEl) { avatarEl.setAttribute('data-plan', plan); }
}

on('auth:ok', updateSidebarProfile);
on('auth:loggedOut', updateSidebarProfile);
