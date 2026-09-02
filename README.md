# Rel.AI Companion

```text
Rel.AI Companion

Long ChatGPT conversations should stay easy to navigate, inspect, and use.
The extension stays local, keeps the interface small, and adds only the tools
that are useful while a conversation is actually open.
```

Rel.AI Companion is a local-first browser extension for ChatGPT. It adds long-conversation navigation, search, bookmarks, session-health tooling, optional performance controls, privacy controls, Focus Mode, and diagnostics without requiring a separate backend.

I built it around a simple idea: ChatGPT already has the conversation. The extension should help me move through it, keep long sessions manageable, and expose useful local controls without turning the page into another dashboard.

```text
ChatGPT conversation
    -> Rel.AI Companion observes the current page locally
    -> navigation, search, bookmarks, health checks, and optional optimizations run in the browser
    -> I keep using ChatGPT normally
```

Rel.AI Companion is an independent third-party project. It is not an official OpenAI product.

---

## What it does

Rel.AI Companion adds a small set of tools around the ChatGPT web app.

### Conversation tools

- **Conversation Navigator** — a thin rail for moving between your prompts in long conversations.
- **Navigator previews** — hover the rail to preview the nearby prompt before jumping.
- **Conversation search** — search locally across conversation turns currently represented in the ChatGPT page.
- **Bookmarks** — save prompt positions per conversation and show them directly on the navigator.
- **Conversation outline** — browse your prompts as a lightweight local outline.
- **Command palette** — press `Ctrl+Shift+K` inside ChatGPT to search messages or run extension actions.
- **Focus Mode** — hide surrounding ChatGPT chrome and center the conversation when you want a quieter workspace.

### Session health

Long ChatGPT tabs can accumulate a large DOM, long conversation history, loaded media, and browser memory usage. Rel.AI Companion exposes those signals as a local **Session Health** estimate instead of asking users to interpret raw numbers.

The health model can use:

- JavaScript heap usage when Chromium exposes it;
- DOM node count;
- conversation length;
- currently rendered turns;
- recent long-task activity; and
- time spent in the current tab.

The result is grouped into:

```text
Good -> Moderate -> Heavy -> Critical
```

The score is a **local heuristic**, not a benchmark and not a guarantee that a specific extension option caused a measured memory or CPU improvement.

Optional session-health warnings can suggest a Memory Reset when a tab becomes unusually heavy. Automatic session management can use **Conservative**, **Balanced**, or **Aggressive** thresholds.

Before an automatic reload, the extension checks for an active draft or an in-progress response and gives the user a short cancellation window.

### Performance controls

Rel.AI Companion keeps performance controls optional and explicit.

It currently includes:

- Memory Reset when switching conversations;
- Smart switch reset for heavier sessions;
- resource preconnect hints;
- reduced decorative animation;
- conversation layout containment;
- lazy loading for images;
- deferred off-screen media;
- font rendering adjustments;
- Manual Images for user-controlled image loading; and
- optional Session Stats for memory, DOM, turn, FPS, lag, and cleanup information.

Presets provide a faster starting point:

| Mode | Goal |
| --- | --- |
| **Balanced** | Keep the normal ChatGPT experience with sensible defaults |
| **Performance** | Prefer more aggressive session and loading optimizations |
| **Privacy** | Prefer privacy-oriented settings and reduced background activity |
| **Minimal** | Keep only the core conversation-navigation experience |
| **Custom** | Any manually adjusted configuration |

### Privacy controls

Two tracker-related controls are available:

- **Page Tracking Cleanup** removes selected analytics elements after they appear in the page.
- **Network Privacy** uses Chromium declarative network rules for a short list of analytics domains.

Network Privacy requests the additional tracker host permissions only when the user enables it. The extension does not request those optional origins merely because it is installed.

### Diagnostics

Rel.AI Companion includes compatibility checks because ChatGPT is a changing web application and DOM-dependent features can break even when the extension itself still loads.

Diagnostics currently report things such as:

- ChatGPT conversation-turn detection;
- user-turn detection;
- composer detection;
- Conversation Navigator state;
- JavaScript heap-metric availability;
- long-task metric availability;
- Speculation Rules support for Quick Open;
- Session Check status; and
- Network Privacy state.

The report can be copied for troubleshooting.

---

## The normal workflow

I wanted the extension to stay understandable without requiring a setup guide every time I open it.

A normal session looks like this:

```text
Open ChatGPT
    -> Rel.AI Companion connects to the page
    -> use the Conversation Navigator normally
    -> press Ctrl+Shift+K when I need search, bookmarks, outline, health, or an action
    -> leave performance/privacy controls alone unless I want them
```

Most features are deliberately quiet. The extension should not permanently cover the conversation with floating toolbars.

---

## Why I made this

I use long ChatGPT conversations for work that can span many prompts, code changes, explanations, and revisions.

Once a conversation becomes large, three problems start to matter:

```text
finding an earlier prompt
understanding where I am in the conversation
keeping a long-running browser tab manageable
```

Browser search is not always ideal when the page virtualizes or dynamically mounts conversation content. A stack of floating arrow buttons was not the interaction I wanted either. That led to the Conversation Navigator rail, local search, bookmarks, outline, and the command palette.

The performance side came from the same problem. I did not want a giant "optimizer" dashboard claiming magical speed gains. I wanted visible signals, conservative controls, and clear boundaries around what the extension can actually know.

That is why Session Health is presented as a heuristic and why experimental features say when the browser or ChatGPT may decline the requested behavior.

---

## Experimental boundaries

Some browser and ChatGPT behaviors are not under the extension's control.

### Session Check

Session Check periodically requests ChatGPT session state while enabled.

Rel.AI Companion does **not** claim that doing this extends login lifetime or prevents logout. It is treated as experimental until that outcome can be demonstrated reliably.

### Quick Open

Quick Open uses Chromium's Speculation Rules support to ask the browser to prepare a conversation when appropriate.

The browser can decline the request. ChatGPT policy, CSP behavior, resource conditions, or browser heuristics can also prevent prerendering. The option is therefore best-effort rather than a guaranteed instant-navigation feature.

### Conversation search

Conversation search is local and does not send the conversation to an external search service. It searches turns currently represented in the ChatGPT page. If ChatGPT has completely unloaded content from the DOM, the extension does not pretend that content is indexed.

---

## Install

### Install from GitHub

The current v1 release is designed for manual installation from source.

1. Download or clone this repository.
2. Open your browser's extensions page.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository directory containing `manifest.json`.
6. Open or refresh ChatGPT.

For Chrome, the extensions page is:

```text
chrome://extensions
```

For Microsoft Edge:

```text
edge://extensions
```

A GitHub-hosted ZIP or a repository loaded with **Load unpacked** does not receive normal Chrome Web Store automatic updates. Replace or pull the local files and reload the extension when a newer GitHub version is released.

---

## Browser support

Rel.AI Companion v1 targets **Chromium Manifest V3**.

| Browser | Status | Notes |
| --- | --- | --- |
| **Google Chrome** | Supported | Primary v1 target |
| **Microsoft Edge** | Compatible target | Chromium extension APIs are largely compatible; release smoke testing is still recommended |
| **Brave** | Expected to work | Chromium-based; not separately certified |
| **Opera / Opera GX** | Expected to work | Chromium-based; not separately certified |
| **Firefox** | Not packaged in v1 | Needs a Firefox-specific background/manifest compatibility pass |
| **Safari** | Not packaged in v1 | Requires Safari Web Extension conversion and Apple packaging |

The current manifest uses a Chromium Manifest V3 service worker and Chromium-specific APIs for optional network blocking and some performance features.

---

## How it works

Rel.AI Companion has no separate application server.

```text
Browser extension
  |
  +-- background.js
  |     preferences, optional network rules, extension-level coordination
  |
  +-- content.js
  |     core ChatGPT page integration and performance controls
  |
  +-- features.js
  |     search, bookmarks, outline, command palette, session health, Focus Mode
  |
  +-- content.css / features.css
  |     injected interface styles
  |
  +-- popup/
        minimalist extension controls and diagnostics
```

Preferences and bookmarks are stored through the browser extension storage API.

There is no account system, subscription backend, license server, or extension-owned cloud API required for the current feature set.

---

## Privacy

The project is intentionally local-first.

Conversation search, bookmarks, outline generation, command-palette actions, Session Health calculation, and compatibility checks run in the browser.

Rel.AI Companion stores local extension state such as:

- preferences;
- per-conversation bookmarks;
- settings backup data; and
- small session-management values used by local features.

The extension does not require a Rel.AI Companion account.

Network Privacy is opt-in. Chromium asks for the relevant analytics host permissions when the user enables that feature.

---

## Settings backup

Settings backup includes the current extension configuration and bookmarks.

The backup is a local JSON file and can later be restored through the extension popup.

The backup format has its own schema version so future releases can migrate it deliberately instead of silently assuming every stored file has the current shape.

---

## Building from source

There is no compile or bundling step in v1. The extension is plain HTML, CSS, and JavaScript.

Clone the repository and load the directory as an unpacked extension.

Useful source checks:

```sh
node --check background.js
node --check content.js
node --check features.js
node --check features-keyboard.js
node --check popup/app.js
node --check shared/i18n-data.js
```

After editing the manifest, also verify that `manifest.json` parses as valid JSON.

Because several features depend on ChatGPT's live page structure, syntax validation alone is not enough for a release. The important manual checks are:

```text
extension installs cleanly
popup opens without console errors
ChatGPT content scripts connect
Conversation Navigator mounts in a long chat
command palette opens and navigates by keyboard
search result jumps work
bookmarks survive reload
Focus Mode restores cleanly
Session Health reports without blocking the page
optional Network Privacy can enable and disable cleanly
```

---

## Design notes

Rel.AI Companion is intentionally opinionated.

- The ChatGPT conversation should remain the primary interface.
- A thin rail is better than a permanent floating toolbar for navigation.
- Most features should stay invisible until they are needed.
- Local search and local bookmarks are preferable to adding a backend for simple conversation utilities.
- A performance mechanism existing is not proof that the page became faster.
- Health scores should be described as heuristics, not causal benchmarks.
- Experimental browser behavior should say when it is best-effort.
- Optional permissions should be requested only for the feature that needs them.
- Diagnostics should explain what is working instead of hiding failures behind an enabled toggle.
- Features that do not justify their complexity should be removed instead of kept for checkbox count.

Conversation export and code-block collapsing are intentionally not part of the current project.

---

## Repository layout

```text
.
├── background.js
├── content.js
├── content.css
├── features.js
├── features-keyboard.js
├── features.css
├── manifest.json
├── popup/
│   ├── app.html
│   ├── app.css
│   └── app.js
├── shared/
│   └── i18n-data.js
└── _locales/
```

Legacy source files may remain in the repository during v1 cleanup, but the manifest is the source of truth for the files that ship and execute.

---

## Developer

Rel.AI Companion is developed by **Kyne0328**.

- GitHub: [github.com/Kyne0328](https://github.com/Kyne0328)
- Website: [kyne.is-a.dev](https://kyne.is-a.dev/)

---

## About

Minimal local-first conversation navigation, productivity, privacy, and session-health tools for ChatGPT.
