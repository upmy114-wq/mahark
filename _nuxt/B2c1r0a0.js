// Firebase Realtime Database bridge — routes all ops through /api/fb/* REST endpoints

const API = '';  // relative, same origin

class DatabaseRef {
  constructor(db, path) {
    this._db = db;
    this._path = (path || '').replace(/^\/+|\/+$/g, '');
    this.key = this._path.split('/').pop() || null;
  }
  toString() { return this._path; }
}

class DataSnapshot {
  constructor(refObj, value) {
    this._ref = refObj;
    this._val = value;
    this.key = refObj.key;
    this.ref = refObj;
  }
  val() { return this._val; }
  exists() { return this._val !== null && this._val !== undefined; }
  child(path) {
    const childPath = this._ref._path + '/' + path;
    const childRef = new DatabaseRef(this._ref._db, childPath);
    const childVal = this._val && typeof this._val === 'object' ? this._val[path] ?? null : null;
    return new DataSnapshot(childRef, childVal);
  }
  forEach(callback) {
    if (this._val && typeof this._val === 'object' && !Array.isArray(this._val)) {
      for (const [k, v] of Object.entries(this._val)) {
        const childRef = new DatabaseRef(this._ref._db, this._ref._path + '/' + k);
        const snap = new DataSnapshot(childRef, v);
        if (callback(snap) === true) break;
      }
    }
  }
  numChildren() {
    if (this._val && typeof this._val === 'object') return Object.keys(this._val).length;
    return 0;
  }
  hasChildren() { return this.numChildren() > 0; }
  toJSON() { return this._val; }
}

let _dbInstance = null;

export function getDatabase(app, url) {
  if (!_dbInstance) _dbInstance = { app: app || null, type: 'database', _url: url || '' };
  return _dbInstance;
}

export function ref(db, path) {
  return new DatabaseRef(db, path || '');
}

export function child(parentRef, path) {
  return new DatabaseRef(parentRef._db, parentRef._path + '/' + path);
}

export async function get(refObj) {
  try {
    console.log('[RTDB-BRIDGE] get:', refObj._path);
    const resp = await fetch(API + '/api/fb/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: refObj._path })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('[RTDB-BRIDGE] get HTTP', resp.status, refObj._path, errText.substring(0, 200));
      return new DataSnapshot(refObj, null);
    }
    const data = await resp.json();
    console.log('[RTDB-BRIDGE] get result:', refObj._path, data.value ? 'has data' : 'null');
    return new DataSnapshot(refObj, data.value ?? null);
  } catch (e) {
    console.error('[RTDB-BRIDGE] get error:', refObj._path, e);
    return new DataSnapshot(refObj, null);
  }
}

export async function set(refObj, value) {
  const v = processValue(value);
  await fetch(API + '/api/fb/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: refObj._path, value: v })
  });
}

export async function update(refObj, values) {
  const v = processValue(values);
  await fetch(API + '/api/fb/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: refObj._path, value: v })
  });
}

export function push(refObj, value) {
  var key = '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var childRef = new DatabaseRef(refObj._db, refObj._path + '/' + key);
  if (value !== undefined) {
    set(childRef, value);
  }
  return childRef;
}

export async function remove(refObj) {
  await fetch(API + '/api/fb/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: refObj._path })
  });
}

const _listeners = new Map();
let _listenerIdCounter = 0;

export function onValue(refObj, callback, options) {
  var id = ++_listenerIdCounter;
  var path = refObj._path;

  if (path === '.info/connected') {
    setTimeout(function() { callback(new DataSnapshot(refObj, true)); }, 0);
    _listeners.set(id, { intervalId: null, path: path, callback: callback });
    return function() { _listeners.delete(id); };
  }

  var poll = function() {
    fetch(API + '/api/fb/poll?path=' + encodeURIComponent(path))
      .then(function(r) {
        if (!r.ok) throw new Error('poll returned ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var snap = new DataSnapshot(refObj, data.value != null ? data.value : null);
        callback(snap);
      })
      .catch(function(e) {
        console.warn('[RTDB-BRIDGE] poll error for', path, e.message);
        if (typeof options === 'function') options(e);
      });
  };

  poll();
  var intervalId = setInterval(poll, 3000);
  _listeners.set(id, { intervalId: intervalId, path: path, callback: callback });

  return function() {
    clearInterval(intervalId);
    _listeners.delete(id);
  };
}

export function off(refObj, eventType, callback) {
  for (const [id, listener] of _listeners.entries()) {
    if (listener.path === refObj._path && (!callback || listener.callback === callback)) {
      clearInterval(listener.intervalId);
      _listeners.delete(id);
    }
  }
}

export function onChildAdded() { return () => {}; }
export function onChildChanged() { return () => {}; }
export function onChildRemoved() { return () => {}; }

let _heartbeatInterval = null;
let _heartbeatPaths = [];

function _startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    for (const hp of _heartbeatPaths) {
      fetch(API + '/api/fb/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: hp.parentPath, value: { 'presence/lastChangedAt': Date.now(), 'presence/state': 'online' } })
      }).catch(() => {});
    }
  }, 10000);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
    for (const hp of _heartbeatPaths) {
      try {
        navigator.sendBeacon(API + '/api/fb/update', new Blob([JSON.stringify({ path: hp.parentPath, value: { 'presence/state': 'offline', 'presence/lastChangedAt': Date.now() } })], { type: 'application/json' }));
      } catch(e) {}
    }
  });
}

class OnDisconnectRef {
  constructor(refObj) { this._ref = refObj; }
  set(value) {
    const path = this._ref._path;
    const parts = path.split('/');
    if (parts.length >= 2 && parts[0] === 'customers') {
      const parentPath = parts.slice(0, 2).join('/');
      if (!_heartbeatPaths.find(h => h.parentPath === parentPath)) {
        _heartbeatPaths.push({ parentPath, refPath: path });
        _startHeartbeat();
      }
    }
    return Promise.resolve();
  }
  update(values) { return Promise.resolve(); }
  remove() { return Promise.resolve(); }
  cancel() { return Promise.resolve(); }
}

export function onDisconnect(refObj) {
  return new OnDisconnectRef(refObj);
}

class ServerTimestamp {
  toJSON() { return new Date().toISOString(); }
  toString() { return new Date().toISOString(); }
}

export function serverTimestamp() {
  return new ServerTimestamp();
}

export function query(refObj) { return refObj; }
export function orderByChild() { return null; }
export function orderByKey() { return null; }
export function orderByValue() { return null; }
export function limitToFirst() { return null; }
export function limitToLast() { return null; }
export function startAt() { return null; }
export function endAt() { return null; }
export function equalTo() { return null; }

export function runTransaction(refObj, transactionUpdate) {
  return get(refObj).then(function(snap) {
    var result = transactionUpdate(snap.val());
    if (result === undefined) return { committed: false, snapshot: snap };
    return set(refObj, result).then(function() {
      return { committed: true, snapshot: new DataSnapshot(refObj, result) };
    });
  });
}

export function increment(n) { return { _inc: n }; }

export { DataSnapshot, DatabaseRef };

function processValue(val) {
  if (val instanceof ServerTimestamp) return new Date().toISOString();
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(processValue);
  var out = {};
  for (var k in val) {
    if (val.hasOwnProperty(k)) out[k] = processValue(val[k]);
  }
  return out;
}
