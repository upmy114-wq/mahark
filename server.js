const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: { supaUrl: !!SUPABASE_URL, supaKey: !!SUPABASE_KEY, supaClient: !!supabase, vercel: !!process.env.VERCEL, region: process.env.VERCEL_REGION || 'unknown' } });
});

app.get('/api/debug-test', async (req, res) => {
  const results = {};
  try {
    const { data, error } = await supabase.from('settings').select('key').limit(1);
    results.supabase = error ? { error: error.message } : { ok: true, rows: data.length };
  } catch (e) {
    results.supabase = { error: e.message };
  }
  try {
    const { data, error } = await supabase.from('settings').select('*').eq('key', 'whatsapp').maybeSingle();
    results.whatsapp = error ? { error: error.message } : { found: !!data, value: data?.value ?? null };
  } catch (e) {
    results.whatsapp = { error: e.message };
  }
  res.json(results);
});

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin1234@@';

let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  } else {
    console.error('WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  }
} catch (e) {
  console.error('Failed to create Supabase client:', e.message);
}

function normPath(p) {
  return (p || '').replace(/^\/+|\/+$/g, '');
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return source;
  if (!target || typeof target !== 'object') target = {};
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function genKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let key = '-';
  for (let i = 0; i < 19; i++) key += chars[bytes[i] % chars.length];
  return key;
}

// Firebase RTDB expands slash-separated keys in update(): {"a/b": v} → {a: {b: v}}
function expandSlashKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('/')) {
      const parts = key.split('/');
      let cur = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    } else {
      if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object') {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// Map Firebase RTDB paths to PostgreSQL tables
// paths: dashboardAccounts/<id>, dashboardUsers/<id>, customers/<id>, settings/<key>, customerEvents/<id>
function pathToTable(p) {
  const parts = p.split('/');
  const root = parts[0];
  const mapping = {
    dashboardAccounts: 'dashboard_accounts',
    dashboardUsers: 'dashboard_accounts',
    customers: 'customers',
    settings: 'settings',
    customerEvents: 'customer_events'
  };
  return { table: mapping[root] || null, root, parts };
}

// Convert snake_case DB row to camelCase for Firebase compat
function rowToFirebase(row, table) {
  if (!row) return null;
  if (table === 'dashboard_accounts') {
    return {
      id: row.id, email: row.email, password: row.password, role: row.role,
      name: row.name, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at, forceLogoutAt: row.force_logout_at || 0
    };
  }
  if (table === 'customers') {
    const base = {
      id: row.id, code: row.code, email: row.email, username: row.username,
      password: row.password, accountType: row.account_type,
      status: row.status, currentStep: row.current_step,
      lastPage: row.last_page, lastAction: row.last_action,
      selectedWatch: row.selected_watch, userAgent: row.user_agent,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
    if (row.data && typeof row.data === 'object') {
      const expanded = expandSlashKeys(row.data);
      for (const [k, v] of Object.entries(expanded)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
          base[k] = deepMerge(base[k], v);
        } else {
          base[k] = v;
        }
      }
    }
    // Dynamic presence: if lastChangedAt is older than 15s, mark offline
    if (base.presence && typeof base.presence === 'object') {
      const lastSeen = base.presence.lastChangedAt;
      if (lastSeen) {
        const age = Date.now() - (typeof lastSeen === 'number' ? lastSeen : new Date(lastSeen).getTime());
        if (age > 15000) {
          base.presence.state = 'offline';
        }
      } else if (!base.presence.lastChangedAt) {
        base.presence.state = 'offline';
      }
    }
    return base;
  }
  if (table === 'settings') {
    return row.value;
  }
  if (table === 'customer_events') {
    return { id: row.id, customerId: row.customer_id, eventType: row.event_type, data: row.data, createdAt: row.created_at };
  }
  return row;
}

// Convert Firebase-style data to DB columns
function firebaseToRow(data, table) {
  if (table === 'dashboard_accounts') {
    const row = {};
    if (data.id !== undefined) row.id = data.id;
    if (data.email !== undefined) row.email = data.email;
    if (data.password !== undefined) row.password = data.password;
    if (data.role !== undefined) row.role = data.role;
    if (data.name !== undefined) row.name = data.name;
    if (data.status !== undefined) row.status = data.status;
    if (data.createdAt !== undefined) row.created_at = data.createdAt;
    if (data.updatedAt !== undefined) row.updated_at = data.updatedAt;
    if (data.lastLoginAt !== undefined) row.last_login_at = data.lastLoginAt;
    if (data.forceLogoutAt !== undefined) row.force_logout_at = data.forceLogoutAt;
    return row;
  }
  if (table === 'customers') {
    const row = {};
    const knownFields = ['id','code','email','username','password','accountType','status','currentStep','lastPage','lastAction','selectedWatch','userAgent','createdAt','updatedAt'];
    if (data.id !== undefined) row.id = data.id;
    if (data.code !== undefined) row.code = data.code;
    if (data.email !== undefined) row.email = data.email;
    if (data.username !== undefined) row.username = data.username;
    if (data.password !== undefined) row.password = data.password;
    if (data.accountType !== undefined) row.account_type = data.accountType;
    if (data.status !== undefined) row.status = data.status;
    if (data.currentStep !== undefined) row.current_step = data.currentStep;
    if (data.lastPage !== undefined) row.last_page = data.lastPage;
    if (data.lastAction !== undefined) row.last_action = data.lastAction;
    if (data.selectedWatch !== undefined) row.selected_watch = data.selectedWatch;
    if (data.userAgent !== undefined) row.user_agent = data.userAgent;
    if (data.createdAt !== undefined) row.created_at = data.createdAt;
    if (data.updatedAt !== undefined) row.updated_at = data.updatedAt;
    const extra = {};
    for (const [k, v] of Object.entries(data)) {
      if (!knownFields.includes(k)) extra[k] = v;
    }
    if (Object.keys(extra).length) row.data = deepMerge(row.data || {}, extra);
    return row;
  }
  return data;
}

// ── RTDB-compatible CRUD using PostgreSQL ──────────────────

async function rtdbRead(rawPath) {
  if (!supabase) throw new Error('Supabase not initialized — check env vars');
  const p = normPath(rawPath);
  if (!p) return null;

  const { table, root, parts } = pathToTable(p);
  if (!table) return null;

  if (parts.length === 1) {
    if (table === 'settings') {
      const { data, error } = await supabase.from(table).select('*');
      if (error || !data || !data.length) return null;
      const result = {};
      for (const row of data) {
        if (!row.key.startsWith('_da|')) result[row.key] = row.value;
      }
      return result;
    }
    const { data, error } = await supabase.from(table).select('*');
    if (error || !data || !data.length) return null;
    const result = {};
    for (const row of data) {
      result[row.id] = rowToFirebase(row, table);
    }

    // Merge extra fields from settings for dashboard_accounts
    if (table === 'dashboard_accounts') {
      const { data: extras } = await supabase.from('settings').select('*').like('key', '_da|%');
      if (extras) {
        for (const srow of extras) {
          const pipeIdx1 = srow.key.indexOf('|');
          const pipeIdx2 = srow.key.indexOf('|', pipeIdx1 + 1);
          if (pipeIdx1 >= 0 && pipeIdx2 > pipeIdx1) {
            const adminId = srow.key.substring(pipeIdx1 + 1, pipeIdx2);
            const subKey = srow.key.substring(pipeIdx2 + 1);
            if (result[adminId]) {
              const subParts = subKey.split('/');
              let cur = result[adminId];
              for (let i = 0; i < subParts.length - 1; i++) {
                if (!cur[subParts[i]] || typeof cur[subParts[i]] !== 'object') cur[subParts[i]] = {};
                cur = cur[subParts[i]];
              }
              cur[subParts[subParts.length - 1]] = srow.value;
            }
          }
        }
      }
    }

    return result;
  }

  if (parts.length >= 2) {
    const id = parts[1];
    if (table === 'settings') {
      const { data, error } = await supabase.from(table).select('*').eq('key', id).maybeSingle();
      if (error || !data) return null;
      return data.value;
    }
    const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
    if (error || !data) return null;
    const fbData = rowToFirebase(data, table);

    // Merge extra fields from settings for dashboard_accounts
    if (table === 'dashboard_accounts') {
      const prefix = `_da|${id}|`;
      const { data: extras } = await supabase.from('settings').select('*').like('key', prefix + '%');
      if (extras) {
        for (const row of extras) {
          const subKey = row.key.substring(prefix.length);
          const subParts = subKey.split('/');
          let cur = fbData;
          for (let i = 0; i < subParts.length - 1; i++) {
            if (!cur[subParts[i]] || typeof cur[subParts[i]] !== 'object') cur[subParts[i]] = {};
            cur = cur[subParts[i]];
          }
          cur[subParts[subParts.length - 1]] = row.value;
        }
      }
    }

    if (parts.length > 2) {
      let cur = fbData;
      for (let i = 2; i < parts.length; i++) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[parts[i]];
      }
      return cur ?? null;
    }
    return fbData;
  }
  return null;
}

async function rtdbSet(rawPath, value) {
  const p = normPath(rawPath);
  if (!p) return;
  const { table, root, parts } = pathToTable(p);
  if (!table) return;

  if (value === null || value === undefined) {
    return rtdbRemove(rawPath);
  }

  // Store nested dashboard_accounts extra fields (like presence) in settings
  if (table === 'dashboard_accounts' && parts.length > 2) {
    const id = parts[1];
    const subPath = parts.slice(2).join('/');
    const settingsKey = `_da|${id}|${subPath}`;
    const { error } = await supabase.from('settings').upsert({ key: settingsKey, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    return;
  }

  if (parts.length < 2) return;

  const id = parts[1];

  if (table === 'settings') {
    const { error } = await supabase.from(table).upsert({ key: id, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    return;
  }

  if (parts.length === 2) {
    const row = firebaseToRow({ id, ...value }, table);
    row.id = id;
    const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return;
  }

  // Nested path: read, modify, write back
  const { data: existing } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (!existing) {
    const newData = {};
    let cur = newData;
    for (let i = 2; i < parts.length - 1; i++) {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    const row = firebaseToRow({ id, ...newData }, table);
    row.id = id;
    const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return;
  }

  const fbData = rowToFirebase(existing, table);
  let cur = fbData;
  for (let i = 2; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  const row = firebaseToRow(fbData, table);
  row.id = id;
  const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

async function rtdbUpdate(rawPath, updates) {
  const p = normPath(rawPath);
  if (!p || !updates) return;
  const { table, root, parts } = pathToTable(p);
  if (!table || parts.length < 2) return;

  const id = parts[1];
  const expanded = expandSlashKeys(updates);

  if (table === 'settings') {
    const { data: existing } = await supabase.from(table).select('*').eq('key', id).maybeSingle();
    const merged = deepMerge(existing?.value || {}, expanded);
    const { error } = await supabase.from(table).upsert({ key: id, value: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    return;
  }

  // For dashboard_accounts, separate known fields from extra fields
  if (table === 'dashboard_accounts') {
    const knownAdminFields = ['id','email','password','role','name','status','createdAt','updatedAt','lastLoginAt','forceLogoutAt'];
    const knownUpdates = {};
    const extraUpdates = {};
    for (const [k, v] of Object.entries(expanded)) {
      if (knownAdminFields.includes(k)) {
        knownUpdates[k] = v;
      } else {
        extraUpdates[k] = v;
      }
    }
    // Update known fields in dashboard_accounts table
    if (Object.keys(knownUpdates).length) {
      const { data: existing } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
      const fbData = existing ? rowToFirebase(existing, table) : { id };
      Object.assign(fbData, knownUpdates);
      const row = firebaseToRow(fbData, table);
      row.id = id;
      const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    // Store extra fields in settings
    for (const [k, v] of Object.entries(extraUpdates)) {
      const settingsKey = `_da|${id}|${k}`;
      await supabase.from('settings').upsert({ key: settingsKey, value: v, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    }
    return;
  }

  const { data: existing } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  const fbData = existing ? rowToFirebase(existing, table) : { id };

  if (parts.length > 2) {
    let cur = fbData;
    for (let i = 2; i < parts.length; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    Object.assign(cur, expanded);
  } else {
    for (const [k, v] of Object.entries(expanded)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && fbData[k] && typeof fbData[k] === 'object') {
        fbData[k] = deepMerge(fbData[k], v);
      } else {
        fbData[k] = v;
      }
    }
  }

  const row = firebaseToRow(fbData, table);
  row.id = id;
  const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

async function rtdbPush(rawPath, value) {
  const p = normPath(rawPath);
  const key = genKey();
  const { table, parts } = pathToTable(p);

  if (table === 'customer_events') {
    const row = {
      customer_id: value.customerId || null,
      event_type: value.eventType || 'unknown',
      data: value.data || value,
      created_at: value.createdAt || new Date().toISOString()
    };
    let { error } = await supabase.from(table).insert(row);
    if (error && error.message?.includes('foreign key')) {
      row.customer_id = null;
      ({ error } = await supabase.from(table).insert(row));
    }
    if (error) throw error;
    return key;
  }

  await rtdbSet(`${p}/${key}`, value);
  return key;
}

async function rtdbRemove(rawPath) {
  const p = normPath(rawPath);
  if (!p) return;
  const { table, parts } = pathToTable(p);
  if (!table) return;

  if (parts.length === 1) {
    await supabase.from(table).delete().neq('id', '___never___');
    return;
  }

  const id = parts[1];

  if (parts.length === 2) {
    if (table === 'settings') {
      await supabase.from(table).delete().eq('key', id);
    } else {
      await supabase.from(table).delete().eq('id', id);
    }
    return;
  }

  // Nested remove: read, delete key, write back
  const { data: existing } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (!existing) return;
  const fbData = rowToFirebase(existing, table);
  let cur = fbData;
  for (let i = 2; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
  const row = firebaseToRow(fbData, table);
  row.id = id;
  await supabase.from(table).upsert(row, { onConflict: 'id' });
}

// ── Firebase-compatible data API ────────────────────────────

app.post('/api/fb/read', async (req, res) => {
  try {
    const val = await rtdbRead(req.body.path);
    res.json({ value: val });
  } catch (e) {
    console.error('fb/read error:', req.body.path, e.message, e.stack);
    res.status(500).json({ error: e.message, path: req.body.path, stack: (e.stack || '').substring(0, 300) });
  }
});

app.post('/api/fb/set', async (req, res) => {
  try {
    await rtdbSet(req.body.path, req.body.value);
    res.json({ ok: true });
  } catch (e) {
    console.error('fb/set error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fb/update', async (req, res) => {
  try {
    await rtdbUpdate(req.body.path, req.body.value);
    res.json({ ok: true });
  } catch (e) {
    console.error('fb/update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fb/push', async (req, res) => {
  try {
    const key = await rtdbPush(req.body.path, req.body.value);
    res.json({ key });
  } catch (e) {
    console.error('fb/push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fb/remove', async (req, res) => {
  try {
    await rtdbRemove(req.body.path);
    res.json({ ok: true });
  } catch (e) {
    console.error('fb/remove error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Auth API (replaces Firebase Auth) ───────────────────────

function makeToken(email, password) {
  return crypto.createHash('sha256').update('auth:' + email + ':' + password).digest('hex');
}

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'missing fields' });
    const key = email.trim().toLowerCase().replace(/[.#$\[\]]/g, '_');
    const { data: row, error } = await supabase.from('dashboard_accounts').select('*').eq('id', key).maybeSingle();

    if (error || !row) return res.status(401).json({ code: 'auth/user-not-found', message: 'User not found' });
    if (row.status === 'inactive') return res.status(401).json({ code: 'auth/user-disabled', message: 'Account disabled' });
    if (row.password !== password) return res.status(401).json({ code: 'auth/wrong-password', message: 'Wrong password' });

    const uid = key;
    const token = makeToken(email.trim().toLowerCase(), password);
    res.json({ uid, email: email.trim().toLowerCase(), token, claims: { role: row.role } });
  } catch (e) {
    console.error('auth/signin error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/create', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'missing fields' });
    const key = email.trim().toLowerCase().replace(/[.#$\[\]]/g, '_');
    const { data: existing } = await supabase.from('dashboard_accounts').select('*').eq('id', key).maybeSingle();

    if (existing) {
      if (existing.password !== password) {
        await supabase.from('dashboard_accounts').update({ password }).eq('id', key);
      }
      const token = makeToken(email.trim().toLowerCase(), password);
      return res.json({ uid: key, email: email.trim().toLowerCase(), token, existing: true, claims: { role: existing.role } });
    }

    const uid = key;
    const token = makeToken(email.trim().toLowerCase(), password);
    res.json({ uid, email: email.trim().toLowerCase(), token });
  } catch (e) {
    if (e.message?.includes('already-in-use')) {
      return res.status(409).json({ code: 'auth/email-already-in-use', message: 'Email already in use' });
    }
    console.error('auth/create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/signout', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/state', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ uid: null, email: null });
  try {
    const { data: rows } = await supabase.from('dashboard_accounts').select('id, email, password').eq('status', 'active');
    if (rows) {
      for (const row of rows) {
        const expected = makeToken(row.email, row.password);
        if (expected === token) {
          return res.json({ uid: row.id, email: row.email });
        }
      }
    }
  } catch (e) {
    console.error('auth/state error:', e.message);
  }
  res.json({ uid: null, email: null });
});

// ── Settings API (for geo-blocking) ─────────────────────────

app.get(['/api/settings/:key.json', '/settings/:key.json'], async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const { data, error } = await supabase.from('settings').select('value').eq('key', req.params.key).maybeSingle();
    res.json(data?.value || null);
  } catch (e) {
    res.json(null);
  }
});

app.put(['/api/settings/:key.json', '/settings/:key.json'], async (req, res) => {
  try {
    const key = req.params.key;
    const newFields = req.body;
    const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const merged = { ...(existing?.value || {}), ...newFields };
    await supabase.from('settings').upsert({ key, value: merged }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Setup endpoint ────────────────────────────────────────────

app.post('/api/setup', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const dbPass = process.env.SUPABASE_DB_PASS || '';
    const connStr = process.env.DATABASE_URL || `postgresql://postgres:${encodeURIComponent(dbPass)}@db.${SUPABASE_URL.replace('https://','')}/postgres`;
    const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });

    const tables = [
      `CREATE TABLE IF NOT EXISTS dashboard_accounts (
        id text PRIMARY KEY, email text, password text, role text DEFAULT 'admin',
        name text, status text DEFAULT 'active',
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        last_login_at timestamptz, force_logout_at bigint DEFAULT 0,
        data jsonb DEFAULT '{}'::jsonb
      )`,
      `CREATE TABLE IF NOT EXISTS customers (
        id text PRIMARY KEY, code text, email text, username text, password text,
        account_type text, status text DEFAULT 'pending', current_step text,
        last_page text, last_action text, selected_watch text, user_agent text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        data jsonb DEFAULT '{}'::jsonb
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key text PRIMARY KEY, value jsonb,
        updated_at timestamptz DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS customer_events (
        id serial PRIMARY KEY, customer_id text,
        event_type text DEFAULT 'unknown', data jsonb,
        created_at timestamptz DEFAULT now()
      )`
    ];
    for (const sql of tables) {
      await pool.query(sql);
    }
    await pool.end();

    const admins = [
      { id: 'ash@gmail_com', email: 'ash@gmail.com', password: 'Ha1234@@', role: 'superadmin', name: 'المدير العام الأعلى' },
      { id: 'jafar@admin_com', email: 'jafar@admin.com', password: '112233', role: 'admin', name: 'جعفر' },
      { id: 'eng@admin_com', email: 'eng@admin.com', password: 'eng6969', role: 'superadmin', name: 'مدير النظام الرئيسي' },
      { id: 'superadmin@admin_com', email: 'superadmin@admin.com', password: 'superadmin12345', role: 'superadmin', name: 'مدير النظام' }
    ];
    for (const a of admins) {
      await supabase.from('dashboard_accounts').upsert({ ...a, status: 'active' }, { onConflict: 'id' });
    }
    await supabase.from('settings').upsert({ key: 'geoBlocking', value: { enabled: true, allowedCountries: ['EG'] } }, { onConflict: 'key' });
    res.json({ ok: true, seeded: admins.length + 1 });
  } catch (e) {
    console.error('setup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin auth ──────────────────────────────────────────────

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (password === ADMIN_PASS) return res.json({ ok: true });
    res.status(401).json({ error: 'wrong password' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Polling endpoint for real-time simulation ───────────────

app.get('/api/fb/poll', async (req, res) => {
  try {
    const p = normPath(req.query.path);
    if (!p) return res.json({ value: null });
    const val = await rtdbRead(p);
    res.json({ value: val });
  } catch (e) {
    console.error('poll error:', req.query.path, e.message, e.stack);
    res.status(500).json({ error: e.message, path: req.query.path, stack: (e.stack || '').substring(0, 300) });
  }
});

// ── Migration: ensure data columns exist ────────────────────
app.post('/api/migrate', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const connStr = process.env.DATABASE_URL || `${SUPABASE_URL.replace('https://', 'postgresql://postgres:' + encodeURIComponent(process.env.SUPABASE_DB_PASS || '') + '@db.')}/postgres`;
    const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
    const migrations = [
      `ALTER TABLE dashboard_accounts ADD COLUMN IF NOT EXISTS data jsonb DEFAULT '{}'::jsonb`,
      `ALTER TABLE customer_events DROP CONSTRAINT IF EXISTS customer_events_customer_id_fkey`
    ];
    const results = [];
    for (const sql of migrations) {
      try {
        await pool.query(sql);
        results.push({ sql: sql.substring(0, 60), ok: true });
      } catch (e) {
        results.push({ sql: sql.substring(0, 60), error: e.message });
      }
    }
    await pool.end();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Static files ────────────────────────────────────────────

app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html'
}));

app.get('*', (req, res) => {
  const reqPath = req.path;
  if (reqPath.startsWith('/api/')) return res.status(404).json({ error: 'not found' });

  const cleanPath = reqPath.replace(/\/$/, '');
  const candidates = [
    path.join(__dirname, cleanPath + '.html'),
    path.join(__dirname, cleanPath, 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (const c of candidates) {
    try {
      if (require('fs').existsSync(c)) return res.sendFile(c);
    } catch {}
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
