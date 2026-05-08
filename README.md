# r1-ssh-terminal

An SSH terminal Creation for the [Rabbit R1](https://www.rabbit.tech/). Run a backend on any machine, scan a QR on your R1, and get a full SSH terminal.

## How it works

```
R1 (Creation) ──WebSocket──► backend (your machine) ──SSH──► any SSH server
```

- The **frontend** lives at `https://ashosystem.github.io/r1-ssh-terminal/` (installed once as a Creation)
- The **backend** runs on your own machine — a Node.js relay that spawns a public tunnel automatically
- No port forwarding, no static IP needed

## Quickstart

### 1. Run the backend on your computer

```bash
git clone https://github.com/Ashosystem/r1-ssh-terminal
cd r1-ssh-terminal/backend
npm install
node server.js
```

A cloudflared tunnel starts automatically and a QR code prints in the terminal. No separate cloudflared install needed.

### 2. Install the Creation on your R1

Use [boondit.site/r1-generator](https://boondit.site/r1-generator) to install this URL as a Creation:

```
https://ashosystem.github.io/r1-ssh-terminal/
```

### 3. First launch — scan the QR

Open the Creation on your R1. The Setup screen will show step-by-step instructions and a **Scan QR** button. Point your R1 camera at the QR printed in your terminal — done.

### 4. Connect

Enter any SSH host, username, port, and password, then tap **Connect**. The last connection is saved and pre-filled next time.

## PTT button

- **Short press** — sends Enter (submits the current command)
- **Long press** — voice-to-text; release to send transcript to terminal

## Backend `.env` options

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `AUTH_TOKEN` | auto-generated | Saved on first run, included in QR |
| `USE_CLOUDFLARED` | `true` | Set to `false` to disable auto-tunnel |
| `PUBLIC_URL` | *(none)* | Fixed public URL (skips auto-tunnel) |
| `SSH_KEY_PATH` | *(none)* | Path to SSH private key on backend machine |

## SSH key auth

Set `SSH_KEY_PATH` in `backend/.env` to authenticate without typing a password on the R1:

```env
SSH_KEY_PATH=/home/user/.ssh/id_ed25519
```

## License

MIT
