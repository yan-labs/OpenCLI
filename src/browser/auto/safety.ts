/**
 * Irreversible-action detection for `browser <session> auto`.
 *
 * Without `--allow-submit`, any click candidate that looks like it submits,
 * deletes, pays, sends, or confirms something is dropped from the JEV
 * candidate menu before the model ever sees it — the model cannot choose
 * what it was never offered. This is deliberately conservative (keyword +
 * attribute heuristics, not a whitelist) because the cost of a false
 * positive (one extra confirmation step) is far lower than the cost of a
 * false negative (an unattended purchase/delete/send).
 */

import type { SnapshotRef } from './types.js';
import { attrString } from './snapshot-parse.js';

// Chinese + English keywords for buttons/links whose action should require
// an explicit human (or --allow-submit) go-ahead. Matched as whole-ish
// substrings against the element's visible text, aria-label, title, and id.
const IRREVERSIBLE_KEYWORDS = [
  // submit / confirm
  'submit', 'confirm', 'confirmed', 'proceed', 'place order', 'checkout',
  '提交', '确认', '确定', '下单', '结算', '结账', '立即购买', '立即支付',
  // payment
  'pay', 'payment', 'checkout', 'purchase', 'buy now',
  '支付', '付款', '购买', '充值',
  // send
  'send', 'send message', 'post', 'publish', 'tweet', 'reply',
  '发送', '发布', '发表', '发帖',
  // delete / remove
  'delete', 'remove', 'destroy', 'unsubscribe', 'cancel account', 'deactivate',
  '删除', '移除', '注销', '销毁', '退订',
];

const IRREVERSIBLE_RE = new RegExp(
  IRREVERSIBLE_KEYWORDS
    .map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'i',
);

function textSignals(ref: SnapshotRef): string {
  const aria = attrString(ref.attrs, 'aria-label') ?? '';
  const title = attrString(ref.attrs, 'title') ?? '';
  const id = attrString(ref.attrs, 'id') ?? '';
  const value = attrString(ref.attrs, 'value') ?? '';
  return [ref.text, aria, title, id, value].filter(Boolean).join(' ');
}

/**
 * True when this click candidate looks irreversible: an explicit
 * `type=submit` control, or text/aria-label/title/id matching a
 * submit/pay/send/delete/confirm keyword (Chinese or English).
 */
export function looksIrreversible(ref: SnapshotRef): boolean {
  const type = attrString(ref.attrs, 'type');
  if (type && type.toLowerCase() === 'submit') return true;
  if (ref.tag === 'button' && !type) {
    // A bare <button> inside a <form> defaults to type=submit per the HTML
    // spec; the snapshot serializer only prints `type=` when it differs
    // from the tag name, so an untyped button is a submit candidate too
    // unless the keyword scan below says otherwise. We can't see the
    // enclosing <form> from a single line, so fall through to keywords —
    // this keeps the heuristic conservative without over-blocking plain
    // <button type=button> UI toggles that happen to be untyped in markup
    // that omits type= (rare but real).
  }
  return IRREVERSIBLE_RE.test(textSignals(ref));
}

export { IRREVERSIBLE_KEYWORDS };
