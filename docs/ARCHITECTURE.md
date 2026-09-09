# sshterm Architecture

> Updated: 2026-09-09

## Overview

sshterm is a **loopback Node.js** multi-protocol terminal (SSH / Telnet / Serial / VNC) with a browser UI based on **xterm.js**. It intentionally stays off Electron: the Node process owns protocol sockets and credentials (DPAPI on Windows); the browser owns rendering and local UX state.

Borrowed ideas (not code copies):

| Project | What we borrow |
|---|---|
| **Tabby** | Plugin-ish domain modules on the front end (`web/js/*`), split panes, search addon |
| **electerm** | Web UI + Node protocol backend split; SFTP panel alongside the terminal |
| **SecureCRT / Xshell** | Paste confirm, session groups, tunnels UI habits |

## Server layout (`server/`)

| Module | Responsibility |
|---|---|
| `index.js` | Thin bootstrap: process state, HTTP server, WS upgrade, `doConnect`, listen |
| `security.js` | Token / Origin / CSP / `isTrustedRequest` helpers |
| `logging.js` | Ring buffer + on-disk logs, redaction, cleanup |
| `sessions-store.js` | Load/save/merge sessions + DPAPI secret glue |
| `ssh-config-loader.js` | Parse `~/.ssh/config` |
| `sftp-http.js` | `/api/sftp/*` + Zmodem download HTTP handlers |
| `vnc-bridge.js` | Direct VNC WebSocket bridge |
| `net-scan.js` | Private-network scan / CIDR helpers |
| `ws-handlers.js` | JSON WS message switch (`createWsMessageHandler(ctx)`) |
| `connections/*` | Per-protocol connection classes |
| `dpapi.js` / `encoding.js` / … | Existing focused helpers |

Public CLI flags (`--port`, `--no-open`, `--auto-exit`) and listen behavior are unchanged: tests still spawn `node server/index.js`.

## Web layout (`web/`)

| Path | Role |
|---|---|
| `js/theme-settings.js` | Themes, font, scrollback, settings dialog helpers |
| `js/i18n.js` | zh/en dictionary + DOM translation |
| `js/host-cpu.js` | SSH status-bar CPU sparkline |
| `js/clipboard.js` | Copy/paste + multiline `safeSendInput` |
| `js/reconnect.js` | Auto-reconnect policy + Ctrl+R |
| `js/tunnel-ui.js` | Tunnel list panel |
| `js/sftp-panel.js` | SFTP panel listing / toolbar / column width |
| `js/sftp-xfer.js` | SFTP transfer helpers + file/folder drag-drop upload |
| `js/vnc-ui.js` | VNC tab connect / RFB UI |
| `js/hotkeys.js` | Configurable hotkey map (localStorage sshterm.hotkeys) |
| `js/split-panes.js` | Split panes + divider drag |
| `app.main.js` | Remaining glue (tabs, SFTP UI, VNC tab, events) |
| `app.js` | **Generated concat** of `js/*` + `app.main.js` for contract tests |

### Concat pipeline

1. Edit `web/js/*.js` and/or `web/app.main.js`.
2. Run `node scripts/sync-web-app.js` (also invoked from static contract tests).
3. `web/app.js` is rewritten as an AUTO-GENERATED concatenation in a fixed order.

`index.html` loads the classic scripts under `/js/*.js` in dependency order, then `/app.main.js` (not ES modules — avoids CORS/`type=module` issues on loopback).

Contract tests that assert substrings / `vm`-extract functions continue to read `web/app.js` as a single UTF-8 string.

## Security boundary

- HTTP/WS bind to `127.0.0.1` only.
- Bootstrap token + Origin/Referer (or CLI `X-SSHTERM-Token`) gate privileged APIs.
- Session secrets use Windows DPAPI when “remember password” is enabled; browser storage never keeps credentials.

## Recent UX additions (2026-09-09)

- Sidebar session-filter; hotkeys.js; SFTP directory drag-drop; sync:web.
