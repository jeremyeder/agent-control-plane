# ACP Session Manager Browser Extension Design

## 1. Product Surface

Compact operational Chrome side panel for managing ACP sessions while browsing. The extension follows the PWA spec in `README.md` and favors dense, scannable controls over marketing composition.

## 2. Tokens

- Color: `--bg`, `--panel`, `--card`, `--text`, `--muted`, `--border`, `--accent`, `--ok`, `--warn`, `--bad`.
- Typography: system UI stack, 14px base, 12px secondary labels, 15px base on wider surfaces.
- Spacing: 4px base unit; primary gaps use 8px, cards and views use 12-18px.
- Radius: 8px controls, 10px messages, 12px cards and notification panels.

## 3. Layout

The side panel is a single-column task surface that remains useful while users navigate tabs. A sticky title bar anchors cluster status and global controls. Session cards are repeated list items. Create and chat screens are full-panel overlays to avoid nested card layouts.

## 4. States

- Status dot: gray disconnected, yellow loading, green healthy, red error.
- Session badge: Running green, Failed red, transitional phases yellow, default slate.
- Chat messages: user messages use accent left border, errors use danger left border, assistant/system messages use the default card surface.
- Empty and error states use plain text inside the relevant content region.

## 5. Primitives

- Title bar: cluster button, status dot, utility controls.
- Toolbar: section title, project label, refresh/create/settings actions.
- Session card: name, metadata, phase badge, prompt preview, action row.
- Overlay: create and chat screens with back control and fixed chat composer.
- Notification panel: compact stack of recent local notifications.

## 6. Accessibility

Use real buttons and form labels. Visible labels are kept for configuration and creation fields. Side panel controls avoid emoji icons; text labels are preferred where the icon set is unavailable.

## 7. Contract Notes

The live ACP `/messages` SSE endpoint is currently unreliable through the tested local stack, so chat replies are retrieved through JSON polling of `GET /sessions/{id}/messages?after_seq=N`. This is part of the browser-extension contract until the API stream path is verified.
