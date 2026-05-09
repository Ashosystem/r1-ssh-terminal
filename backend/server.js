#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const os = require('os');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT) || 3000;
const USE_CLOUDFLARED = process.env.USE_CLOUDFLARED !== 'false'; // default ON
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || null;

// Auto-generate AUTH_TOKEN on first run if not set
let AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
  const envPath = path.join(__dirname, '.env');
  const existing = fs.readFileSync(envPath, 'utf8').replace(/^AUTH_TOKEN=.*$/m, '');
  fs.writeFileSync(envPath, existing.trimEnd() + `\nAUTH_TOKEN=${AUTH_TOKEN}\n`);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/host', (_req, res) => res.json(getHostInfo()));

wss.on('connection', (ws) => {
  let authed = false;
  const ssh = new Client();
  let stream = null;
  let connected = false;

  const timeout = setTimeout(() => {
    if (!authed) ws.close(1008, 'Auth timeout');
  }, 5000);

  ssh.on('ready', () => {
    connected = true;
    ssh.shell({ term: 'xterm-256color', cols: 38, rows: 20 }, (err, s) => {
      if (err) { ws.send(JSON.stringify({ type: 'error', message: err.message })); ws.close(); return; }
      stream = s;
      ws.send(JSON.stringify({ type: 'ready' }));
      const send = (data) => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
      };
      stream.on('data', send);
      stream.stderr.on('data', send);
      stream.on('close', () => { ws.send(JSON.stringify({ type: 'closed' })); ws.close(); ssh.end(); });
    });
  });

  ssh.on('error', (err) => {
    console.error('SSH error:', err.message);
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
  });

  ws.on('message', (msg) => {
    try {
      const pkt = JSON.parse(msg);
      if (!authed) {
        if (pkt.type === 'auth') {
          if (pkt.token !== AUTH_TOKEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            ws.close();
            return;
          }
          authed = true;
          clearTimeout(timeout);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        }
        return;
      }
      if (pkt.type === 'connect') {
        const { host, port = 22, user = 'root', password, key } = pkt;
        console.log(`SSH connect attempt: ${user}@${host}:${port} password=${!!password} key=${!!key}`);
        if (!host) { ws.send(JSON.stringify({ type: 'error', message: 'No host specified' })); ws.close(); return; }
        const sshConfig = { host, port: parseInt(port), username: user, readyTimeout: 10000 };
        if (key) {
          sshConfig.privateKey = key;
        } else if (password) {
          sshConfig.password = password;
        } else if (SSH_KEY_PATH) {
          const resolvedKeyPath = SSH_KEY_PATH.replace(/\\/g, '/');
          console.log(`SSH_KEY_PATH set: "${SSH_KEY_PATH}" → resolved: "${resolvedKeyPath}" exists=${fs.existsSync(resolvedKeyPath)}`);
          if (fs.existsSync(resolvedKeyPath)) {
            sshConfig.privateKey = fs.readFileSync(resolvedKeyPath);
            console.log(`Using key file (${sshConfig.privateKey.length} bytes)`);
          } else {
            console.log(`SSH_KEY_PATH file not found — falling back to no credentials`);
            ws.send(JSON.stringify({ type: 'error', message: `Key file not found: ${resolvedKeyPath}` })); ws.close(); return;
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'No credentials provided' })); ws.close(); return;
        }
        ssh.connect(sshConfig);
      } else if (stream) {
        if (pkt.type === 'data') stream.write(Buffer.from(pkt.data, 'base64'));
        else if (pkt.type === 'resize') stream.setWindow(pkt.rows, pkt.cols, 0, 0);
      }
    } catch {}
  });

  ws.on('close', () => {
    clearTimeout(timeout);
    if (stream) try { stream.close(); } catch {}
    if (connected) try { ssh.end(); } catch {}
  });
});

function getHostInfo() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      ips.push(addr.address);
    }
  }
  ips.sort((a, b) => {
    const rank = ip => ip.startsWith('100.') ? 0 : (ip.startsWith('192.168.') || ip.startsWith('10.')) ? 1 : 2;
    return rank(a) - rank(b);
  });
  return { hostname: os.hostname(), user: os.userInfo().username, port: 22, ip: ips[0] || null };
}

function printBanner(baseUrl) {
  const hostInfo = getHostInfo();
  const payload = JSON.stringify({ url: baseUrl, token: AUTH_TOKEN, host: hostInfo });
  console.log(`
╔══════════════════════════════════════════════════════╗
║  r1-ssh-terminal backend running                     ║
╠══════════════════════════════════════════════════════╣
║  1. Add Creation to R1:                              ║
║     https://ashosystem.github.io/r1-ssh-terminal/   ║
║  2. Open it → tap Setup → scan QR below, or enter:  ║
║     URL  : ${baseUrl.padEnd(42)}║
║     Token: ${AUTH_TOKEN.slice(0,42).padEnd(42)}║
╚══════════════════════════════════════════════════════╝
`);
  QRCode.toString(payload, { type: 'terminal', small: true }, (err, qr) => {
    if (!err) console.log(qr);
  });
}

function getLocalUrl() {
  const ifaces = os.networkInterfaces();
  const preferred = [], fallback = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const nameLower = name.toLowerCase();
    // Skip known VPN/virtual interfaces
    if (nameLower.startsWith('tailscale') || nameLower.startsWith('tun') ||
        nameLower.startsWith('utun') || nameLower.startsWith('wg') ||
        nameLower.startsWith('docker') || nameLower.startsWith('veth') ||
        nameLower.startsWith('br-') || nameLower === 'lo') continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (ip.startsWith('100.')) continue; // Tailscale CGNAT
      if (ip.startsWith('172.1') || ip.startsWith('172.2') || ip.startsWith('172.3')) continue; // Docker
      if (ip.startsWith('192.168.')) preferred.push(ip);       // typical LAN — best
      else if (ip.startsWith('10.0.') || ip.startsWith('10.1.')) preferred.push(ip); // common LAN
      else fallback.push(ip); // other 10.x.x.x — likely VPN, use only if nothing better
    }
  }
  const ip = preferred[0] || fallback[0] || 'localhost';
  return `http://${ip}:${PORT}`;
}

server.listen(PORT, () => {
  if (process.env.PUBLIC_URL) {
    printBanner(process.env.PUBLIC_URL.replace(/\/$/, ''));
    return;
  }

  if (USE_CLOUDFLARED) {
    console.log('Starting tunnel (this takes a few seconds)…');
    const cf = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let tunnelUrl = null;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const onData = (data) => {
      const line = data.toString();
      const match = line.match(urlRe);
      if (match && !tunnelUrl) { tunnelUrl = match[0]; printBanner(tunnelUrl); }
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    setTimeout(() => { if (!tunnelUrl) { console.warn('Tunnel timed out — showing local address instead'); printBanner(getLocalUrl()); } }, 30000);
    process.on('exit', () => { try { cf.kill(); } catch {} });
    return;
  }

  printBanner(getLocalUrl());
});
