const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { Server: OscServer } = require('node-osc');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'osc-overlay-config.json');

const DEFAULT_CONFIG = {
  connections: [],   // { id, name, port, inputs: [] }
  httpPort: 3000,
  bgColor: '#00ff00'
};

function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const cfg = { ...DEFAULT_CONFIG, ...raw };

      // ── Migrate old flat format (oscPorts + inputs) ──
      let migrated = false;
      if (!cfg.connections || cfg.connections.length === 0) {
        const ports     = Array.isArray(cfg.oscPorts) ? cfg.oscPorts : [cfg.oscPort || 8000];
        const oldInputs = cfg.inputs || [];
        cfg.connections = ports.map((port, i) => ({
          id:     makeId(),
          name:   i === 0 ? 'Default' : `Connection ${i + 1}`,
          port,
          inputs: i === 0 ? oldInputs : []
        }));
        migrated = true;
      }

      delete cfg.oscPorts; delete cfg.oscPort; delete cfg.inputs;

      // Write the migrated format immediately so old inputs don't reappear on restart
      if (migrated) {
        try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (_) {}
      }

      return cfg;
    }
  } catch (e) { console.error('Config load error:', e); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('Config save error:', e); }
}

// ─── State ────────────────────────────────────────────────────────────────────

let config     = loadConfig();
const oscValues  = {};           // address → latest value (flat, last-write-wins)
const msgLogs    = {};           // connId  → [{ address, value, ts }, ...]
const MAX_LOG    = 150;
let oscServers   = [];           // [{ server: OscServer, connId }]
const tcpClients = {};           // connId → { socket, rxBuf, reconnTimer, host, port }
let httpServer   = null;
let wss          = null;
let configWindow = null;
let tray         = null;

// ─── TCP OSC helpers ──────────────────────────────────────────────────────────

function _pad4(n) { return n + (4 - (n % 4)) % 4; }

function _encStr(s) {
  const len = Buffer.byteLength(s, 'ascii') + 1;
  const buf = Buffer.alloc(_pad4(len), 0);
  buf.write(s, 'ascii');
  return buf;
}

function buildOscFrame(address, args = []) {
  let tag = ','; const argBufs = [];
  for (const a of args) {
    if (typeof a === 'string')    { tag += 's'; argBufs.push(_encStr(a)); }
    else if (Number.isInteger(a)) { tag += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a, 0); argBufs.push(b); }
    else                          { tag += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a, 0); argBufs.push(b); }
  }
  const msg = Buffer.concat([_encStr(address), _encStr(tag), ...argBufs]);
  const hdr = Buffer.alloc(4); hdr.writeUInt32BE(msg.length, 0);
  return Buffer.concat([hdr, msg]);
}

function parseOscBuf(buf) {
  let off = 0;
  function readStr() {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    const s = buf.toString('ascii', off, end);
    off = _pad4(end + 1);
    return s;
  }
  const address = readStr();
  const typeTag = readStr();
  const args = [];
  for (let i = 1; i < typeTag.length; i++) {
    const t = typeTag[i];
    if      (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
    else if (t === 's') { args.push(readStr()); }
    else if (t === 'T') { args.push(true); }
    else if (t === 'F') { args.push(false); }
    // skip blobs and other exotic types
  }
  return { address, args };
}

// ─── TCP connection management ────────────────────────────────────────────────

function notifyTcpStatus(connId, connected) {
  if (configWindow && !configWindow.isDestroyed())
    configWindow.webContents.send('tcp-status', { connId, connected });
}

function closeTcp(connId) {
  const tc = tcpClients[connId];
  if (!tc) return;
  clearTimeout(tc.reconnTimer);
  try { tc.socket.destroy(); } catch (_) {}
  delete tcpClients[connId];
  notifyTcpStatus(connId, false);
}

function connectTcp(conn) {
  const cid = conn.id;
  const tcp  = conn.tcp || {};
  if (!tcp.enabled || !tcp.host) return;

  closeTcp(cid);

  const host = tcp.host.trim();
  const port = tcp.port || 3032;
  const socket = net.createConnection({ host, port });

  tcpClients[cid] = { socket, rxBuf: Buffer.alloc(0), reconnTimer: null, host, port };

  socket.on('connect', () => {
    console.log(`TCP OSC [${conn.name}] connected → ${host}:${port}`);
    notifyTcpStatus(cid, true);
    // Subscribe to show data changes
    if (tcp.subscribe !== false) {
      try { socket.write(buildOscFrame('/eos/subscribe', [1])); } catch (_) {}
    }
    // Send configured get requests
    (tcp.requests || []).forEach(addr => {
      if (addr && addr.trim()) {
        try { socket.write(buildOscFrame(addr.trim())); } catch (_) {}
      }
    });
  });

  socket.on('data', chunk => {
    const tc = tcpClients[cid];
    if (!tc) return;
    tc.rxBuf = Buffer.concat([tc.rxBuf, chunk]);
    // Parse OSC 1.0 length-prefixed frames
    while (tc.rxBuf.length >= 4) {
      const msgLen = tc.rxBuf.readUInt32BE(0);
      if (msgLen === 0 || tc.rxBuf.length < 4 + msgLen) break;
      const msgBuf = tc.rxBuf.slice(4, 4 + msgLen);
      tc.rxBuf = tc.rxBuf.slice(4 + msgLen);
      try {
        const { address, args } = parseOscBuf(msgBuf);
        handleOscMsg([address, ...args], cid);
      } catch (e) { console.error('TCP OSC parse:', e.message); }
    }
  });

  socket.on('close', () => {
    console.log(`TCP OSC [${conn.name}] disconnected`);
    notifyTcpStatus(cid, false);
    const tc = tcpClients[cid];
    if (tc) {
      tc.reconnTimer = setTimeout(() => {
        const c = (config.connections || []).find(x => x.id === cid);
        if (c?.tcp?.enabled) connectTcp(c);
      }, 5000);
    }
  });

  socket.on('error', err => console.error(`TCP OSC [${conn.name}]:`, err.message));
}

function startTcpConnections() {
  // Close clients for removed/disabled connections
  Object.keys(tcpClients).forEach(cid => {
    const conn = (config.connections || []).find(c => c.id === cid);
    if (!conn || !conn.tcp?.enabled || !conn.tcp?.host) closeTcp(cid);
  });
  // Start/restart as needed
  (config.connections || []).forEach(conn => {
    if (!conn.tcp?.enabled || !conn.tcp?.host) return;
    const tc   = tcpClients[conn.id];
    const same = tc && tc.host === conn.tcp.host.trim() && tc.port === (conn.tcp.port || 3032)
                    && !tc.socket.destroyed;
    if (!same) connectTcp(conn);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAllEnabledInputs() {
  const out = [];
  (config.connections || []).forEach(conn =>
    (conn.inputs || []).forEach(inp => { if (inp.enabled !== false) out.push(inp); })
  );
  return out;
}

function findInputById(id) {
  for (const conn of (config.connections || [])) {
    const input = (conn.inputs || []).find(i => i.id === id);
    if (input) return { conn, input };
  }
  return null;
}

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastState() {
  broadcast({
    type:   'config-update',
    inputs: getAllEnabledInputs(),
    values: oscValues,
    bgColor: config.bgColor || '#00ff00'
  });
}

// ─── OSC message handling ─────────────────────────────────────────────────────

function logMessage(connId, address, value) {
  if (!msgLogs[connId]) msgLogs[connId] = [];
  msgLogs[connId].unshift({ address, value, ts: Date.now() });
  if (msgLogs[connId].length > MAX_LOG) msgLogs[connId].pop();

  // Push live update to config window
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send('osc-message', { connId, address, value });
  }
}

function handleOscMsg(msg, connId) {
  const address = msg[0];
  if (!address || typeof address !== 'string') return;

  const args  = msg.slice(1);
  const value = args.length === 1 ? String(args[0]) : args.map(String).join(' ');

  oscValues[address] = value;
  logMessage(connId, address, value);

  // Find the matching input within this connection only
  const conn  = (config.connections || []).find(c => c.id === connId);
  const input = conn?.inputs?.find(i => i.address === address && i.enabled !== false);
  if (input) {
    broadcast({ type: 'value', address, value, label: input.label });
  }
}

// ─── OSC servers ──────────────────────────────────────────────────────────────

function startOscServers() {
  oscServers.forEach(({ server }) => { try { server.close(); } catch (_) {} });
  oscServers = [];

  (config.connections || []).forEach(conn => {
    if (!conn.port) return;
    try {
      const server = new OscServer(conn.port, '0.0.0.0');
      const cid    = conn.id;

      server.on('message', msg => handleOscMsg(msg, cid));
      server.on('bundle',  bundle => {
        if (Array.isArray(bundle.elements)) bundle.elements.forEach(m => handleOscMsg(m, cid));
      });
      server.on('error', err => console.error(`OSC [${conn.name}]:`, err));

      oscServers.push({ server, connId: cid });
      console.log(`OSC [${conn.name}] listening on port ${conn.port}`);
    } catch (e) {
      console.error(`Failed to start OSC [${conn.name}] port ${conn.port}:`, e);
    }
  });
}

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────

function startHttpServer() {
  if (httpServer) {
    try { if (wss) wss.close(); } catch (_) {}
    try { httpServer.close(); }  catch (_) {}
    httpServer = null; wss = null;
  }

  const app2 = express();
  app2.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
  app2.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
  app2.get('/api/state', (req, res) => res.json({
    inputs:  getAllEnabledInputs(),
    values:  oscValues,
    bgColor: config.bgColor || '#00ff00'
  }));

  httpServer = http.createServer(app2);
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', ws => {
    ws.send(JSON.stringify({
      type:   'init',
      inputs: getAllEnabledInputs(),
      values: oscValues,
      bgColor: config.bgColor || '#00ff00'
    }));

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'save-positions' && Array.isArray(msg.positions)) {
          msg.positions.forEach(({ id, x, y }) => {
            const found = findInputById(id);
            if (found) { found.input.x = Math.round(x); found.input.y = Math.round(y); }
          });
          saveConfig(config); broadcastState();
        }

        if (msg.type === 'update-input' && msg.id && msg.changes) {
          const found = findInputById(msg.id);
          if (found) {
            Object.assign(found.input, msg.changes);
            saveConfig(config); broadcastState();
          }
        }
      } catch (_) {}
    });
  });

  httpServer.listen(config.httpPort, '127.0.0.1', () =>
    console.log(`Overlay: http://localhost:${config.httpPort}/overlay`)
  );
  httpServer.on('error', err => console.error('HTTP error:', err));
}

// ─── Config window ────────────────────────────────────────────────────────────

function createConfigWindow() {
  if (configWindow) { configWindow.show(); configWindow.focus(); return; }

  configWindow = new BrowserWindow({
    width: 660, height: 780,
    title: 'OSC Overlay',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  configWindow.loadFile('config.html');
  configWindow.on('closed', () => { configWindow = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'OSC Overlay', enabled: false },
    { type: 'separator' },
    { label: 'Open Config',          click: createConfigWindow },
    { label: 'Open Overlay',         click: () => shell.openExternal(`http://localhost:${config.httpPort}/overlay`) },
    { label: 'Edit Layout',          click: () => shell.openExternal(`http://localhost:${config.httpPort}/overlay?edit=1`) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startOscServers();
  startTcpConnections();
  startHttpServer();

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('OSC');
  tray.setToolTip('OSC Overlay');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', createConfigWindow);

  createConfigWindow();
});

app.on('activate', createConfigWindow);
app.on('window-all-closed', () => { /* keep in tray */ });
app.on('before-quit', () => {
  oscServers.forEach(({ server }) => { try { server.close(); } catch (_) {} });
  try { if (httpServer) httpServer.close(); } catch (_) {}
});

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => ({ ...config }));

ipcMain.handle('save-config', (event, newConfig) => {
  const prevPorts    = JSON.stringify((config.connections || []).map(c => c.port));
  const prevHttpPort = config.httpPort;
  const prevTcp      = JSON.stringify((config.connections || []).map(c => c.tcp));

  // ── Bug fix: preserve overlay-edited layout properties for existing inputs ──
  // The config UI's in-memory copy goes stale after overlay edits (which save
  // directly to disk via WebSocket). Merge server-side values back in so an
  // "Add Input" from the config UI doesn't clobber positions/styles.
  const layoutFields = ['x', 'y', 'fontSize', 'labelFontSize', 'color', 'labelColor', 'fontFamily'];
  if (Array.isArray(newConfig.connections)) {
    newConfig.connections.forEach(newConn => {
      const oldConn = (config.connections || []).find(c => c.id === newConn.id);
      if (!oldConn) return;
      (newConn.inputs || []).forEach(newInp => {
        const oldInp = (oldConn.inputs || []).find(i => i.id === newInp.id);
        if (!oldInp) return;
        layoutFields.forEach(f => { if (oldInp[f] !== undefined) newInp[f] = oldInp[f]; });
      });
    });
  }

  config = { ...DEFAULT_CONFIG, ...newConfig };
  saveConfig(config);

  const newPorts = JSON.stringify((config.connections || []).map(c => c.port));
  const newTcp   = JSON.stringify((config.connections || []).map(c => c.tcp));

  if (prevPorts !== newPorts) startOscServers();
  if (prevTcp   !== newTcp)   startTcpConnections();

  if (prevHttpPort !== config.httpPort) startHttpServer();
  else broadcastState();

  if (tray) tray.setContextMenu(buildTrayMenu());
  return { success: true };
});

ipcMain.handle('open-overlay',      () => shell.openExternal(`http://localhost:${config.httpPort}/overlay`));
ipcMain.handle('open-edit-overlay', () => shell.openExternal(`http://localhost:${config.httpPort}/overlay?edit=1`));
ipcMain.handle('get-log',           (event, connId) => msgLogs[connId] || []);

ipcMain.handle('get-tcp-status', () => {
  const out = {};
  (config.connections || []).forEach(conn => {
    const tc = tcpClients[conn.id];
    out[conn.id] = !!(tc && !tc.socket.destroyed && tc.socket.readyState === 'open');
  });
  return out;
});

ipcMain.handle('send-tcp-request', (event, connId, address, args) => {
  const tc = tcpClients[connId];
  if (!tc || tc.socket.destroyed || tc.socket.readyState !== 'open')
    return { success: false, error: 'not connected' };
  try {
    tc.socket.write(buildOscFrame(address, args || []));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});
