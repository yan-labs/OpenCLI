# Proton Mail

**Mode**: 🔐 Browser · **Domain**: `mail.proton.me`

Reuse the signed-in Chrome session. Account identity and inbox metadata come from Proton's Mail API. Passwords and session credentials stay in the browser; this adapter does not implement Proton's authentication or cryptography.

## Commands

| Command | Description |
|---------|-------------|
| `opencli proton login` | Open Chrome and wait for interactive sign-in, then verify the account through the API |
| `opencli proton whoami` | Return the API-verified account ID, username, and email |
| `opencli proton inbox` | List inbox messages, newest first, with optional sender and time filters |

## Usage Examples

```bash
opencli proton login --timeout 300
opencli proton whoami -f json
opencli proton inbox --from ifood --limit 10 -f json

# Optional: open only the newest matching message and inspect its decrypted content.
opencli proton inbox --from ifood --read-code --limit 1 -f json

# Exclude messages received before the start of your current sign-in attempt.
opencli proton inbox --from ifood --since 1791878400 --read-code -f json
```

`--from` matches the sender name or address, not the subject or body. `--since` is an inclusive Unix timestamp in seconds. `--limit` is 1–100. API pagination errors fail the command instead of returning a partial result.

The active `/u/<account>/` browser session is preserved. `whoami` returns the API account identity even when the mailbox needs unlocking; that does not assert that encrypted message content is accessible.

## Code extraction

By default, `inbox` reads metadata only and returns `id`, `sender`, `subject`, `time` (Unix seconds), and `code: null` for each message.

With `--read-code`, the adapter opens **only the newest matching message**. This may mark that message as read. It waits for the browser to decrypt the exact message ID, reads its content iframe, and excludes quoted history. It never searches neighboring messages or the entire page. Only the newest row can contain a code; other rows have `code: null`.

Numeric codes must have 4–8 digits; six-digit candidates take precedence. Years in the 2000–2099 range and digits embedded in longer numbers or words are ignored. Missing or ambiguous codes return `null`; this heuristic does not prove that a code is valid or unused. Use `--since` to restrict freshness. A locked mailbox or unavailable decrypted message times out rather than returning an unrelated code.

## Prerequisites and limitations

- Chrome with Browser Bridge, or `OPENCLI_CDP_ENDPOINT` pointing at Chrome.
- Complete sign-in, two-factor authentication, human verification, and mailbox unlocking in Chrome. No password flags or password environment variables are used.
- These are Proton's internal web-client APIs, not a guaranteed public integration contract. The adapter derives the app version from the deployed client and fails explicitly if its expected response or client structure changes.
- API requests use the active browser session and remain same-origin. Credentials, private keys, and encrypted session blobs are not returned.

API and DOM references: [users](https://github.com/ProtonMail/WebClients/blob/main/packages/shared/lib/api/user.ts), [messages](https://github.com/ProtonMail/WebClients/blob/main/packages/shared/lib/api/messages.ts), [message identity](https://github.com/ProtonMail/WebClients/blob/main/applications/mail/src/app/components/message/MessageView.tsx), and [browser-side decryption](https://github.com/ProtonMail/WebClients/blob/main/applications/mail/src/app/helpers/message/messageDecrypt.ts).
