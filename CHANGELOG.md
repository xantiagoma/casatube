# Changelog

Notable changes per release. The image tag names both the app version and the
yt-dlp release inside it; weekly rebuilds that only bump yt-dlp are not listed
here.

## [0.1.0]

The first public release.

- A durable server-side queue: jobs survive the browser closing and the service
  restarting, with six visible stages, retries, priorities and per-job logs.
- A download form that shows the resolutions, codecs, audio tracks and subtitles
  each video actually has, with independent audio and subtitle languages and
  correct language tags on the output.
- Custom file names that never overwrite, with sidecars following the final name.
- A library with thumbnails, in-browser playback (HLS remux on demand, audio
  track and subtitle selection), bundle downloads, and a restorable trash.
- Subscriptions to channels and playlists, serviced on a schedule.
- Providers beyond yt-dlp: private Telegram channels (with a sign-in dialog) and
  Google Drive files.
- TypeScript plugins with an in-app editor; Jellyfin, webhook, URL-unshortener
  and Vidarro plugins bundled.
- Credentials (cookies, passwords, API keys, sessions), encrypted at rest with
  `CREDENTIALS_KEY`.
- Storage, analytics, notifications, optional transcoding presets.
- Multi-arch images (amd64, arm64) on GHCR, rebuilt weekly with the newest yt-dlp.
