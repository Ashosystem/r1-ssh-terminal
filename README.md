# r1-ssh-terminal

An SSH terminal Creation for the [Rabbit R1](https://www.rabbit.tech/) device. Connect to any SSH server directly from your R1.

## Features

- Full xterm.js terminal with UTF-8 support
- DOM keyboard (no native keyboard pop-up) with shift, symbols, backspace
- Nav row: ESC, TAB, ^C, ^D, arrow keys
- Collapsible keyboard (tap ⌨ in header)
- Auto-rotate to landscape mode
- PTT voice-to-command via R1 physical button (long press)
- Password or SSH key authentication

## Setup

### 1. Deploy the backend

On any machine you want to SSH from (or a relay VPS):

```bash
git clone https://github.com/Ashosystem/r1-ssh-terminal
cd r1-ssh-terminal/backend
npm install
node server.js
```

On first run, an auth token is auto-generated and saved to `.env`. Copy the token printed in the console.

Expose publicly with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Copy the `https://....trycloudflare.com` URL.

### 2. Add the Creation to your R1

Open your R1 and add this URL as a Creation:

```
https://ashosystem.github.io/r1-ssh-terminal/
```

### 3. Configure on first launch

The first time you open the Creation, you'll see a Setup screen. Enter:
- **Backend URL**: your Cloudflare tunnel URL (e.g. `https://abc123.trycloudflare.com`)
- **Auth token**: the token printed when you started the backend

Tap **Save**, then connect to any SSH host.

## Optional: SSH key auth

Set `SSH_KEY_PATH` in `backend/.env` to use a key stored on the backend server (no password needed from the R1):

```env
SSH_KEY_PATH=/home/user/.ssh/id_ed25519
```

## Backend `.env` options

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `AUTH_TOKEN` | auto-generated | Token the R1 uses to authenticate |
| `SSH_KEY_PATH` | *(none)* | Path to SSH private key for key auth |

## License

MIT
