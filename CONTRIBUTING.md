# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an
issue first so the approach can be agreed before the work is done.

## Setting up

```bash
bun install
bun run dev          # http://localhost:8520
```

Downloads need `yt-dlp` and `ffmpeg` on the `PATH`. Or work against the image:
`docker compose up -d --build`.

## Before a pull request

```bash
bun run typecheck
bun test
```

Both, because **`bun test` does not typecheck**. CI runs them, then builds the
image for amd64 and arm64, starts it and runs `scripts/smoke.sh` against it.

## How this codebase works

- **Read [`docs/DISCOVERIES.md`](docs/DISCOVERIES.md) first.** Each entry is a
  trap somebody already fell into, with the evidence.
- **[`PLAN.md`](PLAN.md) records decisions and the alternatives that lost.** If
  a change reverses one, say so in the PR and say why.
- **`src/core/{schema,types,errors,plugins}.ts` are contracts** everything else
  depends on. Changes there deserve their own discussion.
- **Errors are values** (`better-result`), tagged in `src/core/errors.ts` and
  mapped to HTTP in `src/api/errors.ts`. A new failure gets a new tag, not a
  string.
- **The frontend's API client is derived from the server's types** (Eden), so
  changing a payload is a compile error in `src/web`, not a 404.
- **Database changes are migrations**: edit `src/core/schema.ts`, then
  `bun run db:generate` and commit the generated SQL.

## Tests

**A test nobody has seen fail is not yet a test.** When you add one, break the
code it covers on purpose and check that it notices. Several tests in this
repository once passed while asserting on the wrong thing.

Tests must never touch a real `DATA_DIR`: give every database a path in a temp
directory, `openDb({ path })`. Passing a bare string once opened the developer's
own database from a test, which is why `openDb` now throws on it.

## Style

- English everywhere: code, comments, docs, UI text.
- Comments say **why**, especially when the obvious approach is wrong. The
  markers in use: 🔴 a decision that is easy to undo by accident, ⚠️ a trap,
  📌 context worth knowing.
- Match the surrounding code; there is no formatter config beyond that.

## Releases

Maintainers only: bump `version` in `package.json`, add a `CHANGELOG.md`
section, commit, `git tag vX.Y.Z && git push --tags`. `release.yml` builds and
publishes the multi-arch image and creates the GitHub release.
