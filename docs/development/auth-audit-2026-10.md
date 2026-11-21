# Authentication audit — October 2026

Base: `77af6bc4` (OpenCLI 1.8.8). The audit covers all 70 `auth.js` / `whoami.js` entry files, shared registration, CLI status/refresh aggregation, Browser Bridge cookie transport, direct CDP cookie scope, command discovery, and dependency advisories. The complete unit, extension and adapter suites were run before and after the changes. This is a source and regression audit; it is not a claim that every website was tested with a live account.

## Confirmed defects addressed

| Layer | Defect | Verification |
| --- | --- | --- |
| Ctrip | `login_uid` was required before any account check; stale cookies also counted as an account | Current homepage's `getMemberSummaryInfo` request inspected; anonymous and signed-in browser probes; fixture CLI tests for absent legacy cookies, stale cookies, API outages and schema changes |
| Ctrip identity | Successful current responses may redact `uid` and `userName` | Live response verified against the homepage membership label; missing identity fields remain empty instead of triggering login |
| Shared auth | Null/empty/invalid identity responses could become `logged_in: true`; adapter metadata could override the site; unknown quick checks became false | Contract tests for invalid responses, explicit logout and unknown signals |
| CLI status | Full probes ignored explicit negative results; lazy import errors could abort the entire batch | Negative/invalid response tests and mixed working/broken adapter tests |
| CLI refresh | Unknown checks were classified as logout; explicit profiles shared a throttle | Tri-state checks and independent profile throttle tests |
| Browser Bridge | Malformed cookie replies silently became empty cookie jars | Transport response validation tests |
| Direct CDP | Domain cookie reads were limited to the current page; domain filtering differed from Chrome | Storage-wide reads, parent/subdomain and URL/path tests; `Storage.getCookies` verified in Chrome |
| Gemini / Gmail / NotebookLM | Cookie gates, locale-specific account selectors and an incorrectly escaped Gmail regex | Actual browser probe JS evaluated against English and simplified/traditional Chinese DOM fixtures; signed-in Gemini live probe |
| Google apps / ChatGPT | Login polling could navigate away from OAuth forms or wait forever for a legacy cookie | Polling tests keep the login form open and complete on return without cookie preconditions |
| Claude | A successful authenticated organizations response still required an analytics cookie | Authenticated response with no analytics cookies |
| DeepSeek / HF / Gitee / Jimeng / Quark | Polling swallowed API/transport failures as “waiting for login” | HTTP 503 during polling remains a command error |
| 12306 / Xiaohongshu | Service failures could be reported as login failures | HTTP 503 and malformed-response tests |
| Reddit | Loading the login module could replace the rich `whoami` command | Import-order regression test; existing output preserved |
| Production dependencies | `undici` 7.29.0 was affected by published advisories | Upgrade to 7.29.1; `npm audit --omit=dev` reports zero vulnerabilities |

## Auth result contract

- A full probe must return a verified account or throw a typed error. `AUTH_REQUIRED` means a positive login-required signal; network failures, unexpected responses and unsupported DOM layouts are command errors.
- A quick probe is optional and may return unknown. Ctrip, ChatGPT and the three Google adapters no longer infer a valid session from cookie names. Use `opencli auth status --site ctrip --full` or `opencli ctrip whoami` for verification.
- Missing display names or redacted IDs do not invalidate an account established by the authoritative probe.
- Login polling must preserve the user's login surface and keep infrastructure errors separate from pending authentication.

## Reproduction and checks

```sh
npm run build
npm test
npx vitest run --project e2e tests/e2e/auth-contract.test.ts
npm run typecheck
npm run check:typed-error-lint
npm run check:silent-column-drop
npm audit --omit=dev
```

The CLI fixture test starts an isolated CDP server on a random port, evaluates the actual adapter JavaScript against fixture responses, and invokes the built CLI in child processes. It checks output, error codes and full/quick status behavior without requiring accounts or modifying the user's daemon.

Live Ctrip and Gemini probes used the existing browser connection with the repository's actual adapter functions. The separate v1.8.8 CLI Browser Bridge extension was disconnected, so live browser checks and CLI transport checks were performed separately. No cookies or tokens are stored in fixtures or this report.

## Remaining verification limits

Other adapters still have site-specific cookie/DOM assumptions. In particular, cookie-only identities (1688/JD), cookie preconditions in other API-backed adapters, and DOM absence or challenge pages interpreted as logout require individual live fixtures before changing their contracts. The audit found these as risk patterns, not confirmed current failures on those accounts. Blanket removal or guessing replacement endpoints would not establish correctness.

Several development-tool dependency advisories remain in the Vite/VitePress/Vue toolchain; the production dependency tree is clear. The existing static-lint baselines also remain (they are not evidence of a clean repository).

### Entry-file inventory

The following inventory records the reviewed entrypoints, not live-site certification.

- `clis/12306/auth.js`
- `clis/1688/auth.js`
- `clis/1point3acres/auth.js`
- `clis/amazon/auth.js`
- `clis/band/auth.js`
- `clis/bilibili/auth.js`
- `clis/boss/auth.js`
- `clis/chaoxing/auth.js`
- `clis/chatgpt/auth.js`
- `clis/claude/auth.js`
- `clis/coupang/auth.js`
- `clis/ctrip/auth.js`
- `clis/deepseek/auth.js`
- `clis/dianping/auth.js`
- `clis/douban/auth.js`
- `clis/doubao/auth.js`
- `clis/douyin/auth.js`
- `clis/dribbble/auth.js`
- `clis/facebook/auth.js`
- `clis/flomo/auth.js`
- `clis/gemini/auth.js`
- `clis/gitee/auth.js`
- `clis/github/auth.js`
- `clis/gmail/auth.js`
- `clis/grok/auth.js`
- `clis/hf/auth.js`
- `clis/hupu/auth.js`
- `clis/instagram/auth.js`
- `clis/jd/auth.js`
- `clis/jianyu/auth.js`
- `clis/jike/auth.js`
- `clis/jimeng/auth.js`
- `clis/ke/auth.js`
- `clis/kimi/auth.js`
- `clis/linkedin/auth.js`
- `clis/linkedin-learning/auth.js`
- `clis/linux-do/auth.js`
- `clis/maimai/auth.js`
- `clis/manus/auth.js`
- `clis/midjourney/whoami.js`
- `clis/notebooklm/auth.js`
- `clis/nowcoder/auth.js`
- `clis/pixiv/auth.js`
- `clis/powerchina/auth.js`
- `clis/quark/auth.js`
- `clis/qwen/auth.js`
- `clis/reddit/auth.js`
- `clis/reddit/whoami.js`
- `clis/rednote/auth.js`
- `clis/reuters/auth.js`
- `clis/slock/whoami.js`
- `clis/suno/auth.js`
- `clis/taobao/auth.js`
- `clis/tiktok/auth.js`
- `clis/toutiao/auth.js`
- `clis/twitter/auth.js`
- `clis/upwork/auth.js`
- `clis/v2ex/auth.js`
- `clis/wechat-channels/auth.js`
- `clis/weibo/auth.js`
- `clis/weread/auth.js`
- `clis/xianyu/auth.js`
- `clis/xiaoe/auth.js`
- `clis/xiaohongshu/auth.js`
- `clis/xiaoyuzhou/auth.js`
- `clis/xueqiu/auth.js`
- `clis/youtube/auth.js`
- `clis/yuanbao/auth.js`
- `clis/zhihu/auth.js`
- `clis/zsxq/auth.js`
