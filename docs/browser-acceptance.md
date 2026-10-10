# Extension acceptance

The extension captures Runtime console events and uncaught exceptions before navigation.
`browser <session> console` reports `captureSupported` and `startedAt`; an empty
message array without supported capture is not evidence of an error-free page.

Set an exact persistent CSS viewport before opening a page:

```sh
opencli browser accept-example viewport set 390 900
opencli browser accept-example open http://localhost:3000/
opencli browser accept-example eval '({width:innerWidth,height:innerHeight})'
opencli browser accept-example screenshot /tmp/accept-example.png
opencli browser accept-example viewport reset
opencli browser accept-example close
```

DPR is 1. This does not simulate touch or a mobile user agent. Screenshots restore
persistent metrics after any temporary screenshot dimensions. Closing the session
removes its override. Older extensions do not support persistent viewport.

The OpenCLI Skill's `scripts/accept.mjs` probes viewport support, validates actual
width and height, and uses a same-origin iframe only on an explicit probe failure.
The fallback reason and console capture support are retained in its summary.
New extensions allow exact `about:blank` navigation for the pre-navigation capture
check; the legacy iframe path keeps HTTP navigation so it works with old extensions.
Captured console errors fail acceptance. Iframe fallback does not cover pages
that prohibit embedding; external resource detection is observation, not blocking.

## Installation-window check

After building and installing the new CLI and reloading the newly built extension,
run `node scripts/live-check.mjs` (or set `OPENCLI_ACCEPT_CLI` to the CLI build).
It serves a local fixture on a fresh port and asserts console.error, an uncaught
exception, horizontal overflow, 1440/390 viewport persistence across open/click/eval,
PNG dimensions, temporary screenshot restoration, reset, and close. Its finally
block closes only its own unique session and its local server.

Until this script passes against the loaded extension, build and mock tests are
only local implementation evidence. Do not reload an extension or restart the
daemon while other users/tasks have active sessions.
