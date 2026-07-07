# ACP Session Manager Browser Extension

Manifest V3 browser extension for managing Agent Control Plane sessions from the Chrome side panel. This implementation uses the same API contract as the ACP Session Manager PWA.

This MVP uses only the ACP APIs confirmed in `openshift-online/agent-control-plane`:

- `GET /api/ambient/v1/sessions`
- `POST /api/ambient/v1/sessions`
- `POST /api/ambient/v1/sessions/{id}/start`
- `POST /api/ambient/v1/sessions/{id}/stop`
- `DELETE /api/ambient/v1/sessions/{id}`
- `GET /api/ambient/v1/sessions/{id}/messages?after_seq=N`
- `POST /api/ambient/v1/sessions/{id}/messages`

## What works

- Chrome side panel shell opened from the extension toolbar action
- Resizable side-panel layout
- Manual ACP server URL, project, and bearer-token setup
- Local token/config storage using `localStorage`
- Session list with adaptive polling
- Create/start/stop/delete sessions
- Chat history and message sending
- Chat message polling while the session chat is open
- In-app notification drawer
- Optional Web Notification permission for local notifications while the app/browser is active

## Notification model

MVP notifications are client-side only:

- Session phase changes to `Failed` create error notifications.
- Session phase changes to `Completed` or `Stopped` create finished notifications.
- Message payloads containing `AskUserQuestion`, `input needed`, `human-in-the-loop`, or `requires input` create input-needed notifications.
- Error messages create error notifications.

Important limitation: notifications are local to the active extension side panel. Background notification delivery requires a credential-aware background poller.

## Load in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose this `components/browser-extension` directory.
5. Click the extension toolbar action to open the Chrome side panel.
6. Enter ACP server URL, project/workspace, and bearer token.

## Run locally for testing

```bash
cd components/browser-extension
python3 -m http.server 8080
```

Then open `http://localhost:8080` in Chrome for static-page testing. Loading as an unpacked extension is still required to validate extension permissions and side panel behavior.

## Local ACP configuration

For the current local Kind instance used during development:

```bash
TOKEN=$(kubectl --context kind-ambient-main get secret test-user-token -n ambient-code \
  -o jsonpath='{.data.token}' | base64 -d)
```

Use:

- ACP server URL: `http://localhost:12856`
- Project / workspace: `tenant-a`
- Bearer token: value from `TOKEN`

## Chat behavior

The live local ACP stack reliably persists assistant replies in:

```text
GET /api/ambient/v1/sessions/{id}/messages?after_seq=N
```

The extension intentionally uses JSON polling instead of SSE because the tested local API server did not replay `/messages` SSE responses through the current response-writer chain.
