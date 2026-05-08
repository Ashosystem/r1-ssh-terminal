#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(process.cwd(), '.env') });
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
const USE_CLOUDFLARED = process.env.USE_CLOUDFLARED === 'true';
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || null;

// Auto-generate AUTH_TOKEN on first run if not set
let AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
  const envPath = path.join(process.cwd(), '.env');
  fs.appendFileSync(envPath, `\nAUTH_TOKEN=${AUTH_TOKEN}\n`);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
    ssh.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, s) => {
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
        if (!host) { ws.send(JSON.stringify({ type: 'error', message: 'No host specified' })); ws.close(); return; }
        const sshConfig = { host, port: parseInt(port), username: user, readyTimeout: 10000 };
        if (key) {
          sshConfig.privateKey = key;
        } else if (password) {
          sshConfig.password = password;
        } else if (SSH_KEY_PATH && fs.existsSync(SSH_KEY_PATH)) {
          sshConfig.privateKey = fs.readFileSync(SSH_KEY_PATH);
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

function printBanner(publicUrl) {
  const payload = JSON.stringify({ url: publicUrl, token: AUTH_TOKEN });
  console.log(`
╔══════════════════════════════════════════════════════╗
║  r1-ssh-terminal is running                          ║
╠══════════════════════════════════════════════════════╣
║  Scan QR with your R1 or enter manually:             ║
║  URL  : ${publicUrl.padEnd(44)}║
║  Token: ${AUTH_TOKEN.slice(0, 44).padEnd(44)}║
╚══════════════════════════════════════════════════════╝
`);
  QRCode.toString(payload, { type: 'terminal', small: true }, (err, qr) => {
    if (!err) console.log(qr);
  });
}

function getLocalUrl() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Skip Tailscale and other VPN interfaces — R1 won't be on those networks
      if (name.startsWith('tailscale') || name.startsWith('tun') || name.startsWith('utun')) continue;
      if (addr.address.startsWith('100.')) continue; // Tailscale CGNAT range
      candidates.push(addr.address);
    }
  }
  const ip = candidates[0] || 'localhost';
  return `http://${ip}:${PORT}`;
}

server.listen(PORT, () => {
  if (process.env.PUBLIC_URL) {
    printBanner(process.env.PUBLIC_URL.replace(/\/$/, ''));
    return;
  }

  if (USE_CLOUDFLARED) {
    console.log('Starting cloudflared tunnel…');
    const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tunnelUrl = null;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const onData = (data) => {
      const line = data.toString();
      const match = line.match(urlRe);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        printBanner(tunnelUrl);
      }
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    setTimeout(() => {
      if (!tunnelUrl) {
        console.warn('cloudflared did not produce a URL — showing local address');
        printBanner(getLocalUrl());
      }
    }, 15000);
    process.on('exit', () => { try { cf.kill(); } catch {} });
    return;
  }

  printBanner(getLocalUrl());
});
