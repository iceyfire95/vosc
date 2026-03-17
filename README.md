# OSC Overlay

A macOS Electron app that receives OSC messages and displays them as a chroma-key overlay for use as an OBS Browser Source.

## Requirements

- **Node.js** (v18+) — https://nodejs.org
- **npm** (bundled with Node.js)

## Quick start (dev mode)

```bash
cd osc-overlay
npm install
npm start
```

The app opens a config window and lives in your menu bar as **OSC**.

## Building a distributable .dmg

```bash
npm run dist
```

The `.dmg` installer will appear in `dist/`.

---

## Setup

### 1. Add your OSC inputs

In the config window, click **+ Add Input** and fill in:

| Field | Example | Notes |
|---|---|---|
| OSC Address | `/eos/out/active/cue/text` | Full path as sent by your console |
| Display Label | `Cue` | Short name shown above the value |
| Font Size | `72` | Pixels |
| Text Colour | white | Picker |

Enable/disable each input with the toggle. Disabled inputs are ignored.

### 2. Configure ports

| Setting | Default | Notes |
|---|---|---|
| OSC Listen Port | `8000` | Port your EOS / media server sends OSC to |
| HTTP Overlay Port | `3000` | Port OBS browser source connects to |

Click **Save** to apply.

### 3. Add to OBS

1. In OBS, add a **Browser Source**
2. Set URL to `http://localhost:3000/overlay`
3. Set width/height to match your scene (e.g. 1920×1080)
4. Enable **"Use custom frame rate"** → 60fps recommended
5. Add a **Chroma Key** filter: key colour `#00FF00`, similarity ~80

The green background will disappear, leaving only your text.

---

## Common ETC EOS OSC addresses

| Data | OSC Address |
|---|---|
| Active cue text | `/eos/out/active/cue/text` |
| Active cue number | `/eos/out/active/cue` |
| Pending cue text | `/eos/out/pending/cue/text` |
| Show name | `/eos/out/show/name` |
| Time (clock) | `/eos/out/time` |

Configure EOS to send OSC to this machine's IP on the OSC Listen Port you set.

---

## Architecture

```
[EOS / Media Server]
        │  OSC UDP
        ▼
  [Electron main.js]
  ┌─────────────────────┐
  │  OSC listener :8000  │
  │  Express   :3000/overlay │
  │  WebSocket :3000     │
  └─────────────────────┘
        │  WebSocket
        ▼
  [OBS Browser Source]
  overlay.html  ← green chroma key page
```
