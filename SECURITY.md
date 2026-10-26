# Security

## Reporting a vulnerability

Please report it privately through
[GitHub's private vulnerability reporting](https://github.com/xantiagoma/casatube/security/advisories/new)
rather than in a public issue. Include what you did, what happened, and the
version (`GET /api/health` returns it). You will get an answer within a week.

Only the latest release is supported.

## The threat model, stated plainly

CasaTube is built for **one household on a private network**. Some of what
follows is a deliberate decision rather than an oversight, and reports that
amount to "this is how it is documented to work" are not vulnerabilities:

- **There is no authentication.** Anyone who can reach the port can use every
  feature. Put it behind a VPN or an authenticating reverse proxy; see the
  README.
- **Plugins run in-process with the server's full privileges.** The plugin
  editor is, by design, a way to run code on the server. A plugin's declared
  capabilities are a contract shown in the UI, not a sandbox.
- **Without `CREDENTIALS_KEY`, stored credentials are plain text** in the
  database. The server warns at every start and the Settings screen says so.

What *is* in scope, among other things:

- Reading or writing files outside the library and data directories (path
  traversal through any route).
- A stored secret — cookie, password, API key, Telegram session — being
  returned by any API route. Credentials are write-only by design.
- Running commands or arbitrary ffmpeg/yt-dlp arguments through any route
  other than the plugin editor.
- A weakness in how credentials are sealed when `CREDENTIALS_KEY` is set.
