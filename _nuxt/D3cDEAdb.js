// Firebase Auth bridge — routes to /api/auth/* REST endpoints

const API = '';

let _currentUser = null;
let _authToken = null;
let _authStateCallbacks = [];
let _defaultAuthInstance = null;

function notifyAuthState() {
  for (const cb of _authStateCallbacks) {
    try { cb(_currentUser); } catch(e) { console.error('auth state cb error:', e); }
  }
}

function _isSecondaryAuth(auth) {
  return auth && auth._secondary === true;
}

export function getAuth(app) {
  if (app && app.name && app.name !== '[DEFAULT]') {
    return {
      app: app,
      _secondary: true,
      _user: null,
      _token: null,
      get currentUser() { return this._user; },
      onAuthStateChanged(callback) {
        setTimeout(() => callback(this._user), 0);
        return () => {};
      },
      signOut() {
        this._user = null;
        this._token = null;
        return Promise.resolve();
      }
    };
  }
  if (!_defaultAuthInstance) {
    _defaultAuthInstance = {
      app: app || null,
      _secondary: false,
      get currentUser() { return _currentUser; },
      onAuthStateChanged(callback) {
        _authStateCallbacks.push(callback);
        setTimeout(() => callback(_currentUser), 0);
        return () => {
          _authStateCallbacks = _authStateCallbacks.filter(c => c !== callback);
        };
      },
      signOut() { return signOut(_defaultAuthInstance); }
    };
  }
  return _defaultAuthInstance;
}

export async function signInWithEmailAndPassword(auth, email, password) {
  console.log('[AUTH-BRIDGE] signInWithEmailAndPassword called:', email);
  const resp = await fetch(API + '/api/auth/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  console.log('[AUTH-BRIDGE] signin response status:', resp.status);
  const data = await resp.json();
  console.log('[AUTH-BRIDGE] signin response data:', JSON.stringify(data).substring(0, 200));
  if (!resp.ok) {
    const err = new Error(data.message || 'Auth failed');
    err.code = data.code || 'auth/unknown';
    console.log('[AUTH-BRIDGE] signin error:', err.code, err.message);
    throw err;
  }
  const user = { uid: data.uid, email: data.email, getIdToken: () => Promise.resolve(data.token), getIdTokenResult: () => Promise.resolve({ claims: data.claims || {} }), reload: async () => {} };
  if (_isSecondaryAuth(auth)) {
    auth._user = user;
    auth._token = data.token;
  } else {
    _authToken = data.token;
    _currentUser = user;
    try { localStorage.setItem('_auth_token', data.token); localStorage.setItem('_auth_user', JSON.stringify({ uid: data.uid, email: data.email, claims: data.claims || {} })); } catch(e) {}
    notifyAuthState();
  }
  return { user };
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  console.log('[AUTH-BRIDGE] createUserWithEmailAndPassword called:', email);
  const resp = await fetch(API + '/api/auth/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await resp.json();
  console.log('[AUTH-BRIDGE] create response:', resp.status, JSON.stringify(data).substring(0, 200));
  if (!resp.ok) {
    const err = new Error(data.message || 'Create failed');
    err.code = data.code || 'auth/unknown';
    throw err;
  }
  const user = { uid: data.uid, email: data.email, getIdToken: () => Promise.resolve(data.token), getIdTokenResult: () => Promise.resolve({ claims: data.claims || {} }), reload: async () => {} };
  if (_isSecondaryAuth(auth)) {
    auth._user = user;
    auth._token = data.token;
  } else {
    _authToken = data.token;
    _currentUser = user;
    try { localStorage.setItem('_auth_token', data.token); localStorage.setItem('_auth_user', JSON.stringify({ uid: data.uid, email: data.email, claims: data.claims || {} })); } catch(e) {}
    notifyAuthState();
  }
  return { user };
}

export async function signOut(auth) {
  if (_isSecondaryAuth(auth)) {
    const token = auth._token;
    auth._user = null;
    auth._token = null;
    if (token) {
      await fetch(API + '/api/auth/signout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    }
    return;
  }
  const token = _authToken;
  _currentUser = null;
  _authToken = null;
  try { localStorage.removeItem('_auth_token'); localStorage.removeItem('_auth_user'); } catch(e) {}
  notifyAuthState();
  if (token) {
    await fetch(API + '/api/auth/signout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(() => {});
  }
}

export function onAuthStateChanged(auth, callback) {
  return auth.onAuthStateChanged(callback);
}

export async function authStateReady() {
  try {
    const saved = localStorage.getItem('_auth_user');
    const token = localStorage.getItem('_auth_token');
    if (saved && token) {
      const parsed = JSON.parse(saved);
      const savedClaims = parsed.claims || {};
      _currentUser = { uid: parsed.uid, email: parsed.email, getIdToken: () => Promise.resolve(token), getIdTokenResult: () => Promise.resolve({ claims: savedClaims }), reload: async () => {} };
      _authToken = token;
    }
  } catch(e) {}
  return Promise.resolve();
}

export async function updatePassword(user, newPassword) {
  return Promise.resolve();
}

export function onIdTokenChanged(auth, callback) {
  return auth.onAuthStateChanged(callback);
}

export async function deleteUser(user) {
  return Promise.resolve();
}

export function connectAuthEmulator() {}
export function setPersistence() { return Promise.resolve(); }
export function browserLocalPersistence() { return {}; }
export function browserSessionPersistence() { return {}; }
export function inMemoryPersistence() { return {}; }
