/**
 * Deterministic, zero-JEV-cost safety gates run every step BEFORE candidate
 * building and before any JEV call: CAPTCHA/challenge detection and login-
 * wall detection. Both selectors are ported verbatim from
 * yan-skills/backlink/scripts/safe-fill.mjs (the same rules already trusted
 * in the backlink submission pipeline) rather than reinvented, so the two
 * pipelines agree on what counts as "stop, don't try to solve/log in".
 *
 * Neither gate is a JEV question — a page either has a captcha widget/login
 * form in its DOM or it doesn't; asking a probabilistic model to judge a
 * fact that a selector answers exactly would just add cost and a failure
 * mode (a low-confidence "maybe") to a case that must never be ambiguous.
 */

// Selector ported from safe-fill.mjs's `captcha` query — matches common
// class/id naming plus known CAPTCHA vendor iframes (reCAPTCHA, hCaptcha,
// Cloudflare Turnstile).
const CAPTCHA_SELECTOR =
  '[class*="captcha" i],[id*="captcha" i],[class*="turnstile" i],[id*="turnstile" i],' +
  '[data-sitekey],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],' +
  'iframe[src*="turnstile" i],iframe[src*="challenges.cloudflare.com" i]';

// Text fallback ported from safe-fill.mjs — catches a challenge rendered
// without any of the above markers (rare, but the keyword scan is cheap).
const CAPTCHA_TEXT_RE = /\b(captcha|recaptcha|hcaptcha|turnstile|security challenge)\b/i;

/** Self-contained probe JS (no external bindings) — evaluated via page.evaluate(). */
export function pageGateProbeJs(): string {
  return `
    (() => {
      const captchaEl = document.querySelector(${JSON.stringify(CAPTCHA_SELECTOR)});
      const bodyText = (document.body && document.body.innerText || '').slice(0, 5000);
      const captchaByText = ${CAPTCHA_TEXT_RE.toString()}.test(bodyText);
      const captchaDetected = !!captchaEl || captchaByText;
      const captchaEvidence = captchaEl
        ? ('selector: ' + (captchaEl.className || captchaEl.id || captchaEl.tagName))
        : (captchaByText ? 'body text mentions captcha/turnstile/security challenge' : undefined);

      let loginWallDetected = false;
      let loginWallEvidence;
      for (const form of document.forms) {
        const actionMatch = typeof form.action === 'string' && /login/i.test(form.action);
        const pwField = form.querySelector('input[type="password"]');
        if (actionMatch || pwField) {
          loginWallDetected = true;
          loginWallEvidence = actionMatch ? 'form action contains "login"' : 'form has an input[type=password]';
          break;
        }
      }
      // A bare password field outside any <form> (rare, but real on some SPAs).
      if (!loginWallDetected && document.querySelector('input[type="password"]')) {
        loginWallDetected = true;
        loginWallEvidence = 'a password input exists outside any <form>';
      }

      return { captchaDetected, captchaEvidence, loginWallDetected, loginWallEvidence };
    })()
  `.trim();
}

export interface PageGateProbeResult {
  captchaDetected: boolean;
  captchaEvidence?: string;
  loginWallDetected: boolean;
  loginWallEvidence?: string;
}
