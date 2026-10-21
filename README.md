# Agent Terminal

A voice-driven AI agent display for the Pebble Time 2 (emery). Speak to your watch, get an HTML response rendered on the e-paper screen, scroll with buttons, and ask follow-ups in context.

Built on the display-list pipeline from [coredevices/pebble-browser-app](https://github.com/coredevices/pebble-browser-app). The agent (Mistral AI) generates HTML with inline CSS, which is rendered phone-side into a display list and streamed to the watch.

## Architecture

```
Watch (C)                          PKJS (phone, Android)              Mistral API
┌──────────────┐                  ┌──────────────────────┐           ┌──────────┐
│ State machine │                 │ index.js              │           │          │
│ idle → record │──Dictation────►│  • AppMessage handler │           │          │
│ → thinking    │                 │  • Settings page      │           │          │
│ → browsing    │◄──chunked DL───│                       │           │          │
│               │                 │ agent.js              │           │          │
│ dl.c ✅       │                 │  • Mistral API client │──────────►│  LLM     │
│ net.c ✅      │                 │  • Conversation hist  │◄──────────│  + skill │
│ touch.c ✅    │                 │  • HTML extraction    │  (HTML)   │          │
│               │                 │ renderer.js           │           │          │
│               │                 │  • HTML → display list│           │          │
│               │                 │ transport.js          │           │          │
│               │                 │  • Chunked AppMessage │           │          │
└──────────────┘                  └──────────────────────┘           └──────────┘
```

## Interaction model

| State | UP / DOWN | SELECT | BACK |
|-------|-----------|--------|------|
| **idle** | — | Start dictation | Exit app |
| **recording** | — | (system dictation screen) | Cancel |
| **thinking** | — | — | Cancel request |
| **browsing** | Scroll | Follow-up dictation | Back to idle |

## The Skill

The agent is instructed via a system prompt (see [SKILL.md](SKILL.md)) to produce HTML with inline CSS designed for a 200×228 e-paper screen. Key constraints:

- Colored header div for titles
- Short, scannable paragraphs
- No tables, multi-column, images, links, or buttons
- Grayscale first; color only for headers
- Content can exceed screen height (user scrolls)

## Setup

### Prerequisites

- Android phone with the Core Devices Pebble app
- Mistral API key from [console.mistral.ai](https://console.mistral.ai)

### Install from GitHub Release

1. Download the latest `.pbw` from [Releases](../../releases)
2. Open the Pebble app → More → Developer → Sideload App, select the `.pbw`

### Build from source

```bash
pip install pebble-tool
pebble sdk install latest
pebble build
pebble install --phone 127.0.0.1   # via CoreApp LAN dev connection
```

### Configure

Open the Pebble app → Agent Terminal → Settings (gear icon):

- **API Key**: Your Mistral API key (`sk-...`)
- **Model**: `mistral-small-latest` (default), `mistral-medium-latest`, etc.
- **System Prompt**: Customize the skill (advanced)

## Development

```
pebble-agent-terminal/
├── package.json          # Pebble project manifest
├── wscript               # Build configuration
├── SKILL.md              # The agent skill (system prompt)
├── src/
│   ├── c/
│   │   ├── main.c            # State machine + UI (rewritten)
│   │   ├── dl.c / dl.h       # Display-list decode/draw (from pebble-browser-app)
│   │   ├── net.c / net.h     # Chunked AppMessage transport
│   │   └── touch_input.c/h   # Touch gestures
│   └── pkjs/
│       ├── index.js          # PKJS entry point
│       ├── agent.js          # Mistral API client + conversation
│       ├── skill.js          # Skill prompt as JS constant
│       ├── renderer.js       # HTML → display list
│       ├── dl.js             # Display-list encoder
│       ├── transport.js      # Chunked transport
│       ├── pebble_fonts.js   # Font metrics
│       └── pebble_text.js    # Text layout
├── test/
│   ├── test_agent.js         # Agent client tests (19 tests)
│   └── test_dl.js            # Display-list encoder tests (21 tests)
└── .github/workflows/build.yml  # CI: build .pbw on push
```

### Testing

```bash
node --test test/*.js   # 40 tests total
```

## Roadmap

- [x] **v0**: Voice → Mistral → HTML → display list → scroll/follow-up
- [ ] **v1**: Link support (`<a href="url">`)
- [ ] **v1.1**: Tap zones (`<a href="action:id">`)
- [ ] **v1.2**: Speaker TTS
- [ ] **v2**: Sandboxed JS widgets

## Credits

- Display-list pipeline: [coredevices/pebble-browser-app](https://github.com/coredevices/pebble-browser-app)
- Agent backend: [Mistral AI](https://mistral.ai)

## License

MIT
