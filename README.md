# Rel.AI Companion

Rel.AI Companion is a browser extension for ChatGPT that adds conversation exports, memory/session controls, navigation helpers, optional privacy controls, and lightweight performance tooling.

Version **1.0.0** is maintained by **Kyne0328**.

## Features

- Conversation export to TXT, Markdown, PDF/print, Word, and JSON
- Selective turn export and Markdown/plain-text copy
- Clean Memory mode for long ChatGPT sessions
- Turn Navigator and optional performance monitor
- Image, animation, DOM, media, and resource-loading controls
- Optional page-level and network-level tracker blocking
- Settings backup/restore and local diagnostics

## Browser support

The v1 package targets **Chromium Manifest V3**.

| Browser | Status | Notes |
| --- | --- | --- |
| Google Chrome | Supported | Primary target; v1 runtime tested in Chromium |
| Microsoft Edge | Compatible target | Chromium extension APIs are largely compatible; smoke-test before release |
| Brave | Expected to work | Chromium-based; not separately tested in v1 |
| Opera / Opera GX | Expected to work | Chromium-based; not separately tested in v1 |
| Firefox | Not packaged in v1 | Needs a Firefox-specific manifest/background compatibility pass |
| Safari | Not packaged in v1 | Requires Safari Web Extension conversion and Xcode packaging |

Experimental features such as prerender-based Instant Chat Switch can remain unavailable when the browser does not expose the required platform API.

## Install from GitHub

For development and manual installation, Chrome-family browsers can load the project without the Chrome Web Store:

1. Download or clone this repository.
2. Open the browser's extensions page.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder containing `manifest.json`.

GitHub distribution is best suited to source builds and manual releases. A GitHub-hosted ZIP does **not** automatically update an extension installed with Load unpacked; users must replace/reload the local copy when a new release is published.

## Development

There is no build step. The extension is plain HTML, CSS, and JavaScript.

Useful validation commands:

```sh
node --check background.js
node --check content.js
node --check main-world.js
node --check popup/popup.js
node --check shared/i18n-data.js
```

After editing `manifest.json`, also verify that it parses as JSON.

## Privacy

Rel.AI Companion stores preferences locally through the browser extension storage API. Network tracker blocking is optional and requests the relevant host permissions only when the user enables it.

## Project

- Author: [Kyne0328](https://github.com/Kyne0328)
- Website: [kyne.is-a.dev](https://kyne.is-a.dev/)

Rel.AI Companion is an independent third-party extension and is not an official OpenAI product.
