/**
 * Parses the `[N]<tag attr=val ...>text</tag>` lines emitted by
 * src/browser/dom-snapshot.ts's serializer (see the `walk()` function there)
 * into structured refs the auto-loop can reason about.
 *
 * Deliberately independent of dom-snapshot.ts's internals: it only depends
 * on the *text contract* documented at the top of that file, the same
 * contract yan-skills/opencli/scripts/jev-step-demo.mjs's parseState()
 * already relies on. Handles both the self-closed form (`<input ... />`)
 * and the open/close form (`<button ...>text</button>`), plus the leading
 * `*` (diff marker) and `|scroll|`/`|scroll[N]|` prefixes.
 */

import type { SnapshotRef } from './types.js';

const REF_LINE = /^\s*\*?(?:\|scroll\|)?(?:\|scroll)?\[(\d+)\]\|?<([a-zA-Z][\w-]*)((?:\s+[^<>]*)?)\/?>(.*)$/;

/**
 * Tokenize an attribute string like `type=text name=custname placeholder=Your name`
 * into key/value pairs.
 *
 * dom-snapshot.ts's serializeAttrs() does NOT quote values, so a multi-word
 * value (placeholder="Your name", aria-label="Sign in with Google") is
 * genuinely ambiguous in the space-delimited text — there is no way to tell
 * where one attribute's value ends and the next key= begins short of
 * scanning for the next `key=` token, which is what this does: each
 * attribute's value is "everything up to the next `word=` boundary".
 * `checked` is special-cased because it's the one bare (valueless) token
 * the serializer ever emits (real boolean HTML attrs like `required`/
 * `disabled` are dropped entirely upstream when empty — see serializeAttrs).
 */
function parseAttrs(raw: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  let s = raw.trim();
  if (!s) return attrs;

  const checkedMatch = /(^|\s)checked(?=\s|$)/.exec(s);
  if (checkedMatch) {
    attrs.checked = true;
    s = (s.slice(0, checkedMatch.index) + ' ' + s.slice(checkedMatch.index + checkedMatch[0].length)).trim();
  }
  if (!s) return attrs;

  const keyRe = /([a-zA-Z][\w-]*)=/g;
  const starts: Array<{ key: string; valueStart: number; keyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(s)) !== null) starts.push({ key: m[1], valueStart: keyRe.lastIndex, keyStart: m.index });

  for (let i = 0; i < starts.length; i++) {
    const { key, valueStart } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].keyStart : s.length;
    let value = s.slice(valueStart, end).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    attrs[key] = value;
  }
  return attrs;
}

/** Strip a trailing `</tag>` close from a captured text tail, if present. */
function stripClose(text: string, tag: string): string {
  const closeIdx = text.indexOf(`</${tag}>`);
  const cut = closeIdx >= 0 ? text.slice(0, closeIdx) : text;
  return cut.trim();
}

/**
 * Parse every `[N]<tag ...>` line in a `page.snapshot()` text tree.
 * Lines that don't match the interactive-ref contract (page headers, plain
 * text content lines, `|iframe|` markers, the `hidden_interactive` footer)
 * are silently skipped — this function only extracts actionable refs.
 */
export function parseSnapshotRefs(snapshotText: string): SnapshotRef[] {
  const refs: SnapshotRef[] = [];
  for (const rawLine of snapshotText.split('\n')) {
    const line = rawLine.replace(/^\s*\d+↑\s*\d+↓.*$/, '').trimEnd();
    if (!line.includes('[')) continue;
    const m = REF_LINE.exec(line);
    if (!m) continue;
    const [, ref, tag, attrsRaw, tail] = m;
    // The self-close `/` (from ` />`) rides along inside attrsRaw because
    // `[^<>]*` can't distinguish it from a legitimate trailing char — strip it.
    const cleanedAttrs = (attrsRaw ?? '').replace(/\s*\/\s*$/, '');
    refs.push({
      ref,
      tag: tag.toLowerCase(),
      attrs: parseAttrs(cleanedAttrs),
      text: stripClose(tail ?? '', tag.toLowerCase()),
    });
  }
  return refs;
}

/**
 * Extract `url:` / `title:` header lines that dom-snapshot.ts prints before
 * `---`. Uses `[ \t]*` (not `\s*`) between the label and the value: `\s`
 * matches newlines too, so on an empty `title: ` line (real pages with no
 * <title>, e.g. httpbin's form page) a greedy `\s*` would cross the line
 * break and silently borrow the *next* line's text (`viewport: ...`) as the
 * title. `.*` (not `.+`) so an empty value matches as `''` instead of
 * falling through to search for a later, unrelated line.
 */
export function parseSnapshotHeader(snapshotText: string): { url: string; title: string } {
  const url = (snapshotText.match(/^url:[ \t]*(.*)$/m) || [])[1]?.trim() ?? '';
  const title = (snapshotText.match(/^title:[ \t]*(.*)$/m) || [])[1]?.trim() ?? '';
  return { url, title };
}

function attrString(attrs: Record<string, string | true>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' ? v : null;
}

export function attrBool(attrs: Record<string, string | true>, key: string): boolean {
  return attrs[key] === true || typeof attrs[key] === 'string';
}

export { attrString };
