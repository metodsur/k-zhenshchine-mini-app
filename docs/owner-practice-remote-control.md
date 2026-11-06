# Owner-only practice remote control — implementation plan

Status: prototype implemented on `feature/owner-practice-remote-control`. No production changes. Branch: `feature/owner-practice-remote-control`.

## Verified existing app
- Timeweb Cloud Apps runs `server.js` from `main`; the app has `/practice`, `/integrity`, `/accept`, `/abundance`, `/mirror` pages.
- Practice video URLs come from `/api/schedule` and may not be configured in the live store.
- Telegram Desktop displays the Mini App in a separate webview window.

## Important limitation
The standard ChatGPT voice conversation has no demonstrated API/tool path to emit remote-control commands. Do not promise that a spoken recommendation automatically changes Telegram UI. First test the navigation channel independently, then select a supported voice interface that can call a backend API.

## Proposed architecture
1. Owner proves identity with Telegram initData. The server validates its HMAC and 5-minute freshness, then compares Telegram ID with the dedicated server-only `PRACTICE_REMOTE_OWNER_ID`; it does not trust a client-provided ID or grant access to other staff in `ADMIN_TELEGRAM_IDS`.
2. Owner starts an ephemeral remote-control session from `/practice` in the Mini App. The server issues a random device-bound credential with a 30-minute absolute lifetime. It is never embedded in URLs or logs; the UI shows active state and has a Stop control.
3. The command endpoint validates fresh owner initData, session state, expiry and target against a fixed same-origin path allowlist: `/practice`, `/integrity`, `/accept`, `/abundance`, `/mirror`. It applies request-ID replay protection and a 20-commands/minute rate limit; event logs exclude credentials.
4. An already-open Mini App receives commands by short polling. Each poll validates the current signed Telegram initData and checks that its user ID matches the session owner, so a device token shared in browser storage does not authorize another Telegram account. Navigation uses the allowlisted same-origin path only. The app stops responding when disabled or expired.
5. Owner-only control script should be loaded through the existing app shell (or a carefully scoped entry point) after authentication; it must be inert for all other users. Do not expose new practice content or bypass current access controls.
6. Integrate voice only after confirming a real voice-to-tool invocation path. If ChatGPT voice cannot invoke the API, build a separate owner-only voice UI, or use an explicit button trigger for the first end-to-end demo.

## Validation and remaining manual test
- Automated tests cover non-owner and expired initData on both control and poll requests, invalid target, disabled session, allowlist, one-time delivery and rate limit.
- Manual verification in Telegram Desktop on Windows 10, including media loading, remains to be performed by the owner. The Sandbox cannot launch the user's desktop application.
- Never push to `main` or deploy without explicit approval.

## First milestone
Prove one authorized command can open `/practice` in the already-open Telegram Desktop Mini App, while another user is unaffected. Voice comes second.
