# Getting help

CasaTube is a personal project, maintained by one person in their spare time and provided as is
([disclaimer](README.md#disclaimer)). There is no paid support and no SLA; help is best effort.
These are the places to go, in order:

1. **Docs first.** The [README](README.md), then [docs/DEPLOY.md](docs/DEPLOY.md) for every
   environment variable, volumes, network-mounted libraries, permissions, updating yt-dlp and
   troubleshooting, and [plugins/README.md](plugins/README.md) for plugins. A failed job's log
   (Queue → the job) usually says what went wrong.
2. **Is it yt-dlp?** If one site stopped working, check whether `yt-dlp` alone can download the
   URL. Most site breakages are fixed upstream, and `latest` picks up a new yt-dlp every week —
   `docker compose pull && docker compose up -d`. If yt-dlp cannot do it either, the report belongs
   with [yt-dlp](https://github.com/yt-dlp/yt-dlp/issues).
3. **Search the [issues](https://github.com/xantiagoma/casatube/issues)**, open and closed.
4. **Open an issue.** Use the
   [bug](https://github.com/xantiagoma/casatube/issues/new?template=bug.yml) template for
   something broken and the
   [feature request](https://github.com/xantiagoma/casatube/issues/new?template=feature.yml)
   template for something missing. Questions are welcome as issues too. Include the version
   (`/api/health` shows it) and the job or container log, **with cookies, tokens and private URLs
   removed**.

A **security vulnerability** never goes in an issue. Report it privately, as
[SECURITY.md](SECURITY.md) explains.

Not in scope: help downloading a specific piece of content you may not have the right to, getting
past DRM or another technical protection, and problems with a site's or service's account, limits
or blocks — those are for that service's own support.
