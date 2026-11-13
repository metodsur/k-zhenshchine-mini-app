# Content Factory bridge — Issue #5

This is an **opt-in extension of the existing Mini App bot**, not a new bot or webhook. `lib/telegram.js` is unchanged. The existing `TELEGRAM_BOT_TOKEN` remains exclusively in the Mini App environment; factory credentials and responses never contain it. No production configuration, deployment, bot setup, or real Telegram calls are part of this implementation.

## Configuration and authorization

Mini App settings:

```dotenv
CF_BRIDGE_ENABLED=1
CONTENT_FACTORY_URL=https://factory.example.test
CF_BRIDGE_SECRET=<shared-strong-random-secret-at-least-32-characters>
CF_ALLOWED_TELEGRAM_IDS=<explicit-comma-separated-ids>
# Existing owner/admin setting, already used by lib/http:
ADMIN_TELEGRAM_IDS=<existing-owner-ids>
```

Without the exact value `CF_BRIDGE_ENABLED=1`, incoming bridge dispatch is inert and the gateway returns 404. Authorization is the **intersection** of `ADMIN_TELEGRAM_IDS` via `lib/http.isAdmin` and `CF_ALLOWED_TELEGRAM_IDS`. A sender must own the exact private chat (`String(userId) === String(chatId)`); groups, channels, usernames, allowlisted non-admin team members, and non-allowlisted admins are denied. Configure the same explicit allowed IDs at the factory.

Issue #5 names the existing **@K_zhenshcine_bot**. Before bridge mode changes, actual media/callback/text dispatch, callback denial answers, any gateway operation except diagnostic `getMe`, and any source download, the bridge calls read-only `getMe` through its existing `botCall` transport with the current existing `TELEGRAM_BOT_TOKEN`. The actual result must have `is_bot === true` and a username equal to `K_zhenshcine_bot` case-insensitively (no `@`, whitespace, prefix, or suffix accepted). A wrong or missing identity fails closed with **503 `BOT_IDENTITY_MISMATCH`**, before bridge state writes, forwarding, sends, `getFile`, filesystem access, or file-byte HTTP downloads. The username is an expected identity constraint, never a fabricated diagnostic response. No bot creation, replacement token, or `setWebhook` is involved.

Identity decisions are cached in process memory for **five minutes**, scoped to SHA-256 digests of the current token plus normalized Bot API base (cloud or the optional already-existing local API). Cache keys do not contain the token. Both matching and mismatching results expire; failed reads do not authorize operations and never use stale results. Diagnostic `getMe` itself is always a fresh read, remains usable when identity is wrong, and returns only the actual sanitized identity. Unrelated updates and disabled legacy behavior do not trigger verification.

`CONTENT_FACTORY_URL` is an HTTPS base URL, optionally with a path prefix, without credentials, query, or fragment. `CF_BRIDGE_SECRET` must have **at least 32 characters**: shorter/missing configured secrets cannot authenticate even an identical header (403) and fail configuration checks (503 `BRIDGE_NOT_CONFIGURED`). Authentication still uses timing-safe comparison. Existing Mini App Redis/Valkey storage must be configured; missing storage fails closed. Bridge data uses separate `cf:bridge:*` keys, never overwriting existing task/database/conversation state.

An authorized `/reels` (also `/reels@botname`) enables per-user media intake for 30 days. `/reels_off` disables new media intake. Existing workflow buttons and explicit replies to workflow prompts remain usable after switching intake off. The commands do not clear existing legacy state.

## Mini App → factory ingress

The Mini App POSTs JSON to:

```text
<CONTENT_FACTORY_URL>/api/workflow/telegram
x-cf-bridge-secret: <CF_BRIDGE_SECRET>
Content-Type: application/json
```

The exact envelopes are:

```ts
{ kind: 'media', input: {
  updateId: number,
  userId: string,
  chatId: string,
  messageId: number,
  fileId: string,
  fileUniqueId: string,
  fileName: string,
  fileSize: number,
  mime: string,
  mediaGroupId?: string
} }
{ kind: 'callback', userId: string, chatId: string,
  id: string, data: string, messageId: number }
{ kind: 'text', userId: string, chatId: string,
  text: string, replyTo: number }
```

Factory ingress must independently use timing-safe secret authentication and enforce workflow ownership/stale revision checks. Respond with JSON, normally `{ "ok": true }`. Transport failures and `{ "ok": false }` produce a retryable webhook 503. Atomic update/file deduplication remains the factory store's responsibility; the Mini App deliberately preserves both `updateId` and `fileUniqueId` and may forward retries.

`cf:<32-lowercase-hex-job-id>:<revision>:<action>` callbacks are dispatched directly, before legacy callback handlers. Supported actions are `publish`, `schedule`, `revise`, `skip`, and `status`; callback data is at most 64 bytes. Callback answer authorization is remembered for ten minutes.

Media dispatch happens **after** the existing database, tasks, master, and conversation handlers. A second fail-closed check rejects media with an existing conversation or a `tmsg`/`dbmsg` reply mapping, including when a legacy handler failed. Native videos/video notes/video animations and video documents are accepted only within **MP4/MOV/M4V/WEBM** boundaries: `video/mp4`, `video/quicktime`, `video/x-m4v`, or `video/webm`. A provided filename extension must be one of those four, case-insensitively. Documents need a supported MIME, or absent/octet-stream MIME with a supported extension. Conflicting or unsupported MIME is rejected; MKV, AVI, and GIF are not accepted. Native media without MIME defaults to MP4; generated filenames use the supported MIME's extension. Photos, audio, arbitrary documents, URLs as file IDs, and invalid IDs/sizes are not forwarded. Albums preserve `mediaGroupId`.

There is no general text interception. Only a text reply to a remembered **gateway `sendMessage` with `reply_markup.force_reply === true`** is forwarded; ordinary gateway messages and arbitrary bot replies do not qualify. Prompt IDs are stored per chat for seven days. Legacy reply handling still has priority. The receipt is kept after forwarding so a rejected schedule can be corrected; the factory's pending job/message state decides whether text remains actionable.

## Factory → Mini App JSON gateway

Configure at the factory:

```dotenv
CF_TELEGRAM_GATEWAY_URL=https://mini-app.example.test/api/content-factory/telegram
CF_BRIDGE_SECRET=<same-secret>
CF_ALLOWED_TELEGRAM_IDS=<same-explicit-ids>
```

POST to the full gateway endpoint with `x-cf-bridge-secret` and JSON:

```json
{ "method": "sendMessage", "payload": { "chat_id": "900", "text": "Review this result" } }
```

Success response:

```json
{ "ok": true, "result": { "message_id": 123 } }
```

`result` follows the Telegram result shape, except the sanitized diagnostic/metadata results described below. `sendText` returns `result.message_id`. ForceReply prompt registration is automatic for authenticated gateway sends. Unknown methods or unexpected payload fields return 400. No arbitrary Bot API proxy, token lookup, webhook changes, multipart uploads, or raw base64 uploads are provided.

| Method | Accepted payload fields |
| --- | --- |
| `sendMessage` | `chat_id`, `text`, `parse_mode`, `reply_markup`, `disable_web_page_preview`, `disable_notification`, `protect_content` |
| `sendVideo` | `chat_id`, `video`, `caption`, `parse_mode`, `reply_markup`, `supports_streaming`, `duration`, `width`, `height`, `disable_notification`, `protect_content` |
| `sendDocument` | `chat_id`, `document`, `caption`, `parse_mode`, `reply_markup`, `disable_content_type_detection`, `disable_notification`, `protect_content` |
| `answerCallbackQuery` | `callback_query_id`, `text`, `show_alert`, `cache_time` |
| `getFile` | **`chat_id`**, `file_id` |
| `getMe` | Empty object `{}` |
| `getWebhookInfo` | Empty object `{}` |

Every outgoing send requires an authorized owner/private chat. `answerCallbackQuery` requires a callback receipt created by an authorized `cf:` ingress callback; it needs no additional chat field because the core interface supplies only callback ID/text.

For `sendVideo.video` and `sendDocument.document`, **only** signed HTTPS URLs at the exact configured factory origin/base path and existing `/api/public/<numeric-item>/<encoded-file>` route are accepted. They require a future integer `exp` and a 64-character hex `sig`, with no extra query keys, duplicate signature parameters, embedded credentials, or fragment. The factory public-file route performs the actual signature verification. Telegram downloads the signed URL; the Mini App does not fetch or buffer output. Arbitrary file IDs, foreign URLs, token-bearing Telegram URLs, and unvalidated thumbnail fields are rejected.

For large rendered output, the factory should send an authorized signed private download link as message text rather than promise a raw upload above Telegram's limits. `sendDocument` is an alternate delivery format where supported, **not** a guarantee that it removes Telegram cloud download/upload limits. There is no raw 50 MiB upload workaround here.

Mutating egress is not idempotent. A transport error or prompt-registration failure can occur after Telegram accepted a send. The factory must apply its uncertain-delivery handling rather than blindly retry sends/publications.

## Protected source download

`getFile` and download both require a receipt for the exact incoming `file_id` + private `chat_id` pair, saved for 30 days during authorized media intake. An allowlisted owner cannot fetch someone else's source file or an arbitrary bot file.

Optional metadata request:

```json
{ "method": "getFile", "payload": { "chat_id": "900", "file_id": "telegram-file-id" } }
```

Returns `{ "ok": true, "result": { "file_id", "file_unique_id", "file_size", "file_path" } }`. No bot token or Telegram download URL is returned. Cloud `file_path` is a validated relative path. Local `file_path` is an **opaque** `local/<sha256-file-id>` marker; absolute paths and token-containing local directory names are never exposed. The factory must download through the gateway, never construct a Telegram URL from metadata.

Download request to the **same full gateway endpoint**:

```http
GET /api/content-factory/telegram?file_id=<url-encoded-file-id>&chat_id=900
x-cf-bridge-secret: <CF_BRIDGE_SECRET>
```

Success is a streamed binary 200 response with input video MIME, `Content-Length` when available, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. No buffering of large input, redirect to Telegram, token in the query, or public unauthenticated source route is used. The Mini App calls `getFile` using its existing token and streams the Telegram source internally. Redirects are prohibited; cloud HTTP body size is bounded. The factory should stream this response to its source file and inspect non-200 JSON before saving bytes.

Errors are JSON `{ "ok": false, "error": "CODE", "message"?: "actionable guidance" }`, including 403 auth/receipt denial, 400 unsupported operation, 503 missing bridge configuration/storage or `BOT_IDENTITY_MISMATCH`, 502 sanitized upstream/identity-read failure, and:

```json
{ "ok": false, "error": "LARGE_FILE", "message": "...Offer the authenticated factory direct-upload link..." }
```

`LARGE_FILE` has status **413** and must trigger the factory's manual/authenticated upload UI, not repeated Telegram downloads. This bridge does not invent that UI or link. Telegram cloud source downloads are limited to **20 MiB**, including documents; a known oversized source fails before calling `getFile`. Unknown-size upstream `file is too big` also maps to `LARGE_FILE`. Other unavailable files return actionable `TELEGRAM_FILE_UNAVAILABLE` (502). If an unknown-size stream exceeds the cap after response headers have been sent, the stream terminates; the factory must reject an incomplete source.

## Optional ALREADY existing local Bot API

These settings are strictly optional and do not create or deploy a Bot API server:

```dotenv
CF_TELEGRAM_API_BASE=http://127.0.0.1:8081
CF_TELEGRAM_FILE_ROOT=/absolute/mounted/telegram-bot-api/files
```

The configured Bot API receives method calls using the **same existing token**. Administrators must ensure the existing bot/webhook and local Bot API arrangement is already valid; this code does not migrate it. Never expose an unauthenticated local Bot API publicly. `CF_TELEGRAM_FILE_ROOT` must be an absolute directory accessible to the Mini App process, including any required existing mount.

When both settings exist and `getFile` returns an absolute file path, the gateway resolves both root/path with `realpath`, verifies strict containment (including symlink escape rejection), requires a regular file, and enforces a **6 GiB** cap. Download opens with `O_NOFOLLOW`, verifies the opened Linux file descriptor path remains inside the root, stats again, and streams the file. Neither paths nor file bytes are returned to unauthorized requesters. Relative file paths still use the bounded HTTP download path and do not silently enable cloud-large support. Absolute paths without both local settings are rejected.

This optional filesystem streaming requires a Linux Node runtime with `/proc/self/fd`, matching the existing Timeweb server. It is not a generic serverless local-file arrangement.

## Read-only diagnostics

`getMe` returns only identity/capability fields from the existing bot's actual diagnostic result, including a wrong bot's real identity; it is not blocked by `BOT_IDENTITY_MISMATCH` and does not use or refresh the operational identity cache. `getWebhookInfo` first requires matching bot identity, then returns only certificate presence, pending update count, maximum connections, allowed updates, and last error date. It deliberately omits webhook URL, IP, and error text because those can contain sensitive material. Both require gateway opt-in, a configured secret of at least 32 characters, and timing-safe secret authentication. Neither mutates configuration.

## Tests

```bash
node --test tests/content-factory.test.js
npm test
```

Bridge tests use synthetic credentials, in-memory Redis, mocked factory/Telegram HTTP (with actual `getMe` reads explicitly intercepted for cloud and local API bases), and disposable local files. They cover disabled behavior, authorization intersection, precise envelopes, legacy task/database precedence, explicit ForceReply ownership, callback scope, signed URL restrictions, receipt-bound streaming, cloud limits, token/error redaction, local containment/symlink rejection, and the local cap. Negative identity tests assert no dispatch, state changes, non-diagnostic Telegram egress, filesystem access, or byte downloads. Additional coverage includes strict identity flags/name boundaries, case-insensitive matching, five-minute expiry, token/API-base cache separation, failed reads, live wrong-bot diagnostics, short-secret rejection and the exact 32-character boundary, and MP4/MOV/M4V/WEBM MIME/extensions. No real service calls are made.
