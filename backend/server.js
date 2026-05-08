require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT) || 3000;

// Auto-generate AUTH_TOKEN on first run if not set
let AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
  const envPath = path.join(__dirname, '.env');
  fs.appendFileSync(envPath, `\nAUTH_TOKEN=${AUTH_TOKEN}\n`);
  console.log('\n⚠️  No AUTH_TOKEN set — generated one and saved to .env');
}

const SSH_KEY_PATH = process.env.SSH_KEY_PATH;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  r1-ssh-terminal backend                                     ║
╠══════════════════════════════════════════════════════════════╣
║  Port        : ${PORT}
║  Auth token  : ${AUTH_TOKEN}
╠══════════════════════════════════════════════════════════════╣
║  Expose publicly with:                                       ║
║    npx cloudflared tunnel --url http://localhost:${PORT}
╚══════════════════════════════════════════════════════════════╝
`);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

wss.on('connection', (ws, req) => {
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

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
