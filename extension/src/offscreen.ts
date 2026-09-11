/**
 * OpenCLI — offscreen document.
 *
 * MV3 service workers have no `document`, so `document.execCommand('paste')`
 * / `navigator.clipboard.readText()` cannot run there. A normal tab's
 * document is also gated behind window/document focus, and opencli's
 * automation tabs run in background windows by default — so this offscreen
 * document (created by background.ts with reason `CLIPBOARD`) is the
 * documented, focus-exempt place to do clipboard I/O.
 *
 * This file is a second, independent entry point. It is NOT imported by
 * background.ts — it only talks to the service worker over
 * chrome.runtime.sendMessage / onMessage.
 */

interface ReadClipboardRequest {
  type: 'opencli-read-clipboard';
}

interface ReadClipboardResponse {
  text?: string;
  error?: string;
}

function isReadClipboardRequest(msg: unknown): msg is ReadClipboardRequest {
  return typeof msg === 'object' && msg !== null
    && (msg as { type?: unknown }).type === 'opencli-read-clipboard';
}

function readClipboardViaExecCommand(): string {
  const textarea = document.getElementById('paste-target') as HTMLTextAreaElement | null;
  if (!textarea) throw new Error('offscreen document missing #paste-target');

  textarea.value = '';
  textarea.focus();
  const ok = document.execCommand('paste');
  if (!ok) throw new Error('document.execCommand(\'paste\') returned false');

  const text = textarea.value;
  textarea.value = '';
  return text;
}

// Real-machine finding (2026-09-11): on macOS, document.execCommand('paste')
// in this offscreen document reads non-ASCII text back MOJIBAKE'd — the
// bytes come back as if the system pasteboard's text were decoded with
// Mac OS Roman instead of UTF-8 (verified: re-decoding the corrupted string
// with the 'macintosh' charset round-trips it to the original text exactly).
// This looks like a Chromium bug specific to the legacy execCommand paste
// path in an unfocused offscreen document — it does not happen for
// plain-ASCII text, only multi-byte UTF-8. navigator.clipboard.readText()
// (the modern async Clipboard API) does not go through that legacy code
// path and reads the pasteboard's public.utf8-plain-text flavor correctly,
// so it is tried first; execCommand stays as a fallback for older Chrome
// versions or if the async API is ever unavailable in this context.
async function readClipboardViaAsyncApi(): Promise<string> {
  if (!navigator.clipboard?.readText) throw new Error('navigator.clipboard.readText unavailable in this context');
  return navigator.clipboard.readText();
}

async function readClipboardText(): Promise<string> {
  try {
    return await readClipboardViaAsyncApi();
  } catch (asyncErr) {
    try {
      return `[DEBUG_ASYNC_FAILED: ${asyncErr instanceof Error ? asyncErr.message : String(asyncErr)}]\n` + readClipboardViaExecCommand();
    } catch (execErr) {
      throw new Error(
        `both clipboard read paths failed — async: ${asyncErr instanceof Error ? asyncErr.message : String(asyncErr)}; `
        + `execCommand: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
      );
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isReadClipboardRequest(msg)) return undefined;

  readClipboardText()
    .then((text) => sendResponse({ text } satisfies ReadClipboardResponse))
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) } satisfies ReadClipboardResponse));
  return true; // keep the message channel open for the async sendResponse
});
