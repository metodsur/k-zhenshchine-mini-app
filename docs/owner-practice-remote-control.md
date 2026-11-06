# Owner-only practice remote control — implementation plan

Status: design only. No production changes. Branch: `feature/owner-practice-remote-control`.

## Verified existing app
- Timeweb Cloud Apps runs `server.js` from `main`; the app has `/practice`, `/integrity`, `/accept`, `/abundance`, `/mirror` pages.
- Practice video URLs come from `/api/schedule` and may not be configured in the live store.
- Telegram Desktop displays the Mini App in a separate webview window.

## Important limitation
The standard ChatGPT voice conversation has no demonstrated API/tool path to emit remote-control commands. Do not promise that a spoken recommendation automatically changes Telegram UI. First test the navigation channel independently, then select a supported voice interface that can call a backend API.

## Proposed architecture
1. Owner signs into the existing Mini App via Telegram initData. Server validates initData signature with the bot token, checks auth_date freshness, and checks owner ID against the server-side `ADMIN_TELEGRAM_IDS` allowlist; do not trust client-provided ID.
2. Owner starts an ephemeral remote-control session from within the Mini App. The server issues a short-lived, session-bound credential, never embedded in URLs, logs, or repository. UI clearly shows whether remote control is active and has a Stop control.
3. An authenticated command endpoint validates caller, session, expiry, action and target against a fixed allowlist: `practice`, `integrity`, `accept`, `abundance`, `mirror`. Use replay protection, rate limits and audit entries without secrets.
4. The already-open owner's Mini App receives commands using authenticated SSE or short polling; it navigates via same-origin app paths only, never arbitrary URLs. On disconnect/expiry it stops responding.
5. Owner-only control script should be loaded through the existing app shell (or a carefully scoped entry point) after authentication; it must be inert for all other users. Do not expose new practice content or bypass current access controls.
6. Integrate voice only after confirming a real voice-to-tool invocation path. If ChatGPT voice cannot invoke the API, build a separate owner-only voice UI, or use an explicit button trigger for the first end-to-end demo.

## Validation before deployment
- Add unit tests: invalid/expired/replayed initData, non-owner denied, invalid targets denied, expired session denied, stop revokes session, no navigation for other users.
- Test that each practice route opens in Telegram Desktop and video assets load where configured.
- Run `npm test`; perform a manual demo on a staging environment.
- Never push to `main` or deploy without explicit approval.

## First milestone
Prove one authorized command can open `/practice` in the already-open Telegram Desktop Mini App, while another user is unaffected. Voice comes second.
