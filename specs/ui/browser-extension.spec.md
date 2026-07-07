# Browser Extension Specification

## Purpose

The browser extension provides a compact, always-available ACP session manager in the user's browser side panel. It allows a user to connect to an ACP instance, manage sessions in the active project, and continue session conversations without switching away from the page they are browsing. The extension is a browser UI surface over existing ACP Session and SessionMessage APIs; it does not introduce new persistent platform entities.

## Requirements

### Requirement: Chrome Side Panel Surface
The browser extension SHALL run as a Chrome-compatible side panel opened from the extension toolbar action.

#### Scenario: Toolbar action opens side panel
- GIVEN the extension is installed and enabled in Chrome
- WHEN the user clicks the extension toolbar action
- THEN Chrome opens the ACP Sessions side panel
- AND the side panel displays the current ACP connection state

#### Scenario: Persistent navigation escape hatch
- GIVEN the user is viewing a session chat with enough history to scroll
- WHEN the user scrolls to the bottom of the chat
- THEN a browser-style left-arrow Back control remains visible
- AND activating Back returns to the session list without losing connection state

### Requirement: Connection Configuration
The extension SHALL allow a user to configure an ACP server URL, project/workspace, and bearer token before loading sessions.

#### Scenario: Manual local development configuration
- GIVEN a local ACP API server is reachable at `http://localhost:12856`
- WHEN the user configures server URL `http://localhost:12856`, project `tenant-a`, and a valid bearer token
- THEN the extension loads sessions from project `tenant-a`
- AND all API requests include the bearer token and project header required by ACP

#### Scenario: Reconfiguration
- GIVEN the extension is connected to an ACP instance
- WHEN the user opens settings and saves a different server URL, project, or bearer token
- THEN the extension uses the new configuration for subsequent API requests
- AND existing stored configuration is replaced

### Requirement: Session List
The extension SHALL display a compact list of sessions for the configured project.

#### Scenario: Sessions render with operational state
- GIVEN the configured project has sessions
- WHEN the session list loads
- THEN each session card shows name, model, relative age, prompt preview, and phase badge
- AND session actions reflect the current phase

#### Scenario: Empty project
- GIVEN the configured project has no sessions
- WHEN the session list loads
- THEN the extension displays an empty state instead of an empty card list

#### Scenario: Polling updates transitional sessions
- GIVEN at least one session is in `Pending`, `Creating`, or `Stopping`
- WHEN the session list is open
- THEN the extension polls often enough for phase transitions to appear without a manual refresh

### Requirement: Session Lifecycle Actions
The extension SHALL allow users to create, start, stop, delete, and open chat for sessions according to ACP lifecycle rules.

#### Scenario: Create session
- GIVEN the extension is connected to a project
- WHEN the user enters a session name, model, repository URL, and initial prompt
- THEN the extension creates a session using the ACP sessions create API
- AND the new session appears in the session list

#### Scenario: Start only when startable
- GIVEN a session is in `Ready`, `Stopped`, `Failed`, or `Completed`
- WHEN the session card renders
- THEN the Start action is available

#### Scenario: Creating session cannot be started again
- GIVEN a session has moved to `Creating`
- WHEN the session card renders
- THEN the Start action is not available
- AND the phase badge shows `Creating`, not `Unknown`

#### Scenario: Refetch before start
- GIVEN the UI has stale state showing a session as startable
- WHEN the user activates Start
- THEN the extension refetches the session before calling the start endpoint
- AND if the server reports a non-startable phase, the extension SHALL NOT call the start endpoint
- AND the card updates to the server-reported phase

#### Scenario: Stop confirmation
- GIVEN a session is `Pending`, `Creating`, `Running`, or `Stopping`
- WHEN the user activates Stop
- THEN the extension asks for confirmation before calling the stop endpoint

#### Scenario: Delete confirmation
- GIVEN a session is not in a busy phase
- WHEN the user activates Delete
- THEN the extension asks for confirmation before deleting the session

### Requirement: Chat Transcript
The extension SHALL provide a conversation-focused chat view for a session.

#### Scenario: Load visible conversation messages
- GIVEN a session has persisted messages
- WHEN the user opens chat
- THEN the extension loads messages using `GET /api/ambient/v1/sessions/{id}/messages?after_seq=0`
- AND visible user and assistant messages are rendered as chat transcript entries

#### Scenario: Hide non-conversation lifecycle rows
- GIVEN the message history includes lifecycle or system-hook events
- WHEN the chat transcript renders
- THEN lifecycle rows such as `run started` and `run finished` are not displayed as conversation messages
- AND hidden rows still advance the polling cursor so future polling does not replay them

#### Scenario: Localized message timestamps
- GIVEN a visible chat message has a creation timestamp
- WHEN it renders in the browser
- THEN the message shows a localized timestamp with seconds and the browser's local timezone

#### Scenario: Send message with Enter
- GIVEN the chat input contains text
- WHEN the user presses Enter
- THEN the extension sends the message immediately
- AND Shift+Enter inserts a newline instead of sending

#### Scenario: Poll for replies
- GIVEN the chat view is open
- WHEN the user sends a message or the agent replies
- THEN the extension polls `GET /api/ambient/v1/sessions/{id}/messages?after_seq=N`
- AND appends newly visible user and assistant messages without duplicating prior messages

### Requirement: Notifications
The extension SHALL display local in-panel alerts for session events that require user attention.

#### Scenario: Alert panel distinct from sessions
- GIVEN an unread notification exists
- WHEN the session list renders
- THEN notifications appear in a visually distinct alert panel
- AND notification cards are not visually confusable with session cards

#### Scenario: Mark notifications read
- GIVEN unread notifications are visible
- WHEN the user activates Mark all read
- THEN all notifications are persisted as read
- AND the alert panel is hidden immediately
- AND the toolbar unread badge is cleared

#### Scenario: Toast placement
- GIVEN a toast message is shown while the session list toolbar is visible
- WHEN the toast renders
- THEN it does not overlap Refresh, New, or Settings actions

### Requirement: Authentication and Storage
The extension SHALL store configuration and tokens locally in the browser and SHALL NOT expose tokens in logs, errors, or rendered output.

#### Scenario: Token stored locally
- GIVEN the user saves a bearer token
- WHEN the extension is reopened
- THEN the token is available for API calls without re-entry
- AND the token is not displayed except in the settings form where the user pasted it

#### Scenario: Authentication failure
- GIVEN the stored token is invalid or expired
- WHEN an API request returns 401
- THEN the extension displays an authentication error directing the user to paste a fresh token
- AND the token value is not included in the error

### Requirement: API Contract
The extension SHALL use existing ACP APIs without introducing browser-extension-specific backend endpoints.

#### Scenario: Read paths
- GIVEN the extension is connected
- WHEN it needs projects, sessions, or messages
- THEN it uses existing ACP REST read endpoints with the configured bearer token and project header

#### Scenario: Write paths
- GIVEN the user creates, starts, stops, deletes, or sends a chat message
- WHEN the extension performs the action
- THEN it uses the existing ACP REST write endpoint for that action
- AND it handles non-2xx responses as user-visible errors without leaking credentials

### Requirement: Visual QA and Packaging
The browser extension SHALL have a repeatable local browser QA path that loads the unpacked extension and validates the primary workflows.

#### Scenario: Side panel behavior verified
- GIVEN the extension is loaded in a browser QA profile
- WHEN the QA harness starts
- THEN it verifies the toolbar action is configured to open the side panel

#### Scenario: Core workflow verified
- GIVEN the QA harness is provided a live ACP server URL, project, and bearer token
- WHEN the harness runs
- THEN it captures the configured session list
- AND opens a chat with visible user and assistant messages
- AND verifies lifecycle rows are hidden
- AND verifies timestamps include seconds
- AND verifies Enter submits the chat form
- AND verifies notification mark-read behavior
- AND verifies phase/action gating for `Ready` and `Creating`

## Data Model

No new ACP server-side entity is introduced. The extension consumes existing `Project`, `Session`, and `SessionMessage` representations. Local browser storage MAY hold extension configuration, bearer token, repository history, unread notifications, and chat draft state.

## API Paths

The extension SHALL use these existing ACP paths:

- `GET /api/ambient/v1/projects`
- `GET /api/ambient/v1/sessions`
- `POST /api/ambient/v1/sessions`
- `GET /api/ambient/v1/sessions/{id}`
- `POST /api/ambient/v1/sessions/{id}/start`
- `POST /api/ambient/v1/sessions/{id}/stop`
- `DELETE /api/ambient/v1/sessions/{id}`
- `GET /api/ambient/v1/sessions/{id}/messages?after_seq=N`
- `POST /api/ambient/v1/sessions/{id}/messages`

## RBAC and Security

The extension SHALL rely on the user's configured bearer token and ACP's existing project-scoped RBAC enforcement. It SHALL send the configured project context on API requests and SHALL NOT use a platform service-account token or backend proxy. Browser permissions SHALL be limited to side panel operation, local notifications, and configured ACP host access.

## Migration Plan

The initial implementation SHALL be reimplemented from this spec rather than treated as canonical. The current prototype MAY be used as behavior evidence for the first reconciliation gap analysis. A production implementation SHALL live under a dedicated browser-extension component, include a package manifest and browser QA harness, and be added to the appropriate build/test surfaces only after the spec is registered.
