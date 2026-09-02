# Rel.AI Companion

Rel.AI Companion is a browser extension for ChatGPT focused on long-conversation navigation, session health, local productivity tools, optional privacy controls, and lightweight performance management.

Version **1.0.0** is maintained by **Kyne0328**.

## Features

### Long conversations

- Conversation Navigator rail with prompt previews
- Local search across the current loaded conversation
- Per-conversation prompt bookmarks with navigator markers
- Local conversation outline generated from user prompts
- Command palette (`Ctrl+Shift+K`) for navigation and actions
- Focus Mode for a reduced-distraction ChatGPT layout

### Session health and performance

- Local Session Health score using JS heap when available, DOM size, conversation length, and recent long tasks
- Baseline-versus-current session trend measurements
- Optional session-health warnings
- Optional automatic session management with Conservative, Balanced, and Aggressive thresholds
- Memory Reset controls for long-running ChatGPT tabs
- Session Stats chip for live memory, DOM, turn, FPS, lag, and cleanup information
- Image, animation, DOM, media, font, and resource-loading controls

The Session Health score is a local heuristic. It is not presented as a causal performance benchmark or a guarantee of memory savings.

### Presets and privacy

- Balanced, Performance, Privacy, Minimal, and Custom optimization modes
- Optional page-level tracker cleanup
- Optional network-level tracker blocking with runtime host-permission requests
- Session Check remains experimental; the extension does not claim that requesting ChatGPT session state extends login lifetime
- Quick Open is best-effort; Chromium may decline prerender requests

### Reliability and diagnostics

- Compatibility checks for ChatGPT turn selectors, composer detection, navigator state, heap metrics, long-task support, and Speculation Rules support
- Copyable diagnostics for support reports
- Settings and bookmark backup/restore
- Local reset that clears extension settings and bookmarks

Conversation export and code-block collapsing are intentionally not part of this project.

## Browser support

The v1 package targets **Chromium Manifest V3**.

| Browser | Status | Notes |
| --- | --- | --- |
| Google Chrome | Supported | Primary target |
| Microsoft Edge | Compatible target | Chromium extension APIs are largely compatible; smoke-test before release |
| Brave | Expected to work | Chromium-based; not separately certified |
| Opera / Opera GX | Expected to work | Chromium-based; not separately certified |
| Firefox | Not packaged in v1 | Needs a Firefox-specific manifest/background compatibility pass |
| Safari | Not packaged in v1 | Requires Safari Web Extension conversion and Xcode packaging |

## Install from GitHub

For development and manual installation, Chrome-family browsers can load the project without the Chrome Web Store:

1. Download or clone this repository.
2. Open the browser's extensions page.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder containing `manifest.json`.

A GitHub-hosted ZIP does not automatically update an extension installed with Load unpacked; users must replace/reload the local copy when a new release is published.

## Development

There is no build step. The extension is plain HTML, CSS, and JavaScript.

Useful validation commands:

```sh
node --check background.js
node --check content.js
node --check features.js
node --check popup/app.js
node --check shared/i18n-data.js
```

After editing `manifest.json`, also verify that it parses as JSON.

## Privacy

Rel.AI Companion stores preferences, bookmarks, and local session-tool state through the browser extension storage API. Conversation search, outlines, bookmarks, session-health scoring, and the command palette run locally in the browser. Network tracker blocking is optional and requests the relevant host permissions only when the user enables it.

## Project

- Author: [Kyne0328](https://github.com/Kyne0328)
- Website: [kyne.is-a.dev](https://kyne.is-a.dev/)

Rel.AI Companion is an independent third-party extension and is not an official OpenAI product.
