# syntax=docker/dockerfile:1.7
#
# CasaTube — one self-contained image: the app, yt-dlp and ffmpeg (PLAN §14).
# No host dependencies. Runs on plain Docker, Compose and CasaOS.
#
# Build (see docs/DEPLOY.md for the full recipe, including how the tag is built):
#
#   docker build --build-arg YTDLP_VERSION=2026.08.19 \
#     -t casatube:0.1.0-ytdlp-2026.08.19 .
#
# ⚠️ The tag carries the yt-dlp release date, not just the app version. yt-dlp
# breaks when sites change; a bare app version silently pins a stale yt-dlp.

ARG BUN_VERSION=1.4
ARG ALPINE_VERSION=3.22

# yt-dlp releases are dated (2026.08.19), so the version *is* the build date.
# Bump it deliberately; the image tag must be bumped with it.
ARG YTDLP_VERSION=2026.08.19


# ─── bun ──────────────────────────────────────────────────────────────────────
# Only used as a source for the `bun` binary and for installing dependencies.
# The runtime stage is plain Alpine, so none of this image's cruft ships.
FROM oven/bun:${BUN_VERSION}-alpine AS bun


# ─── the frontend is NOT built here ───────────────────────────────────────────
# `src/api/web.ts` bundles the browser client with `Bun.build` at startup and
# keeps it in memory, by decision: `bun src/server.ts` is the whole story, and
# there is no dist/ that can go stale against the source. So the image ships the
# sources and pays a few hundred milliseconds once, on boot.
#
# 📌 If a `build` script is ever added to package.json, a builder stage goes
# here (full `bun install`, `bun run build`) and its output gets copied below.


# ─── prod-deps ────────────────────────────────────────────────────────────────
# A second, production-only install. Separate from `deps` so devDependencies
# (typescript, drizzle-kit) never reach the runtime image.
FROM bun AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# Bun auto-installs peer dependencies, and elysia/drizzle-orm peer on the
# TypeScript toolchain: `typescript` 7 alone drags in @typescript/native-preview,
# a ~27 MB native compiler. None of it is imported at runtime — these are types,
# erased at transpile time — so they are dropped. ~37 MB.
RUN rm -rf node_modules/typescript \
           node_modules/@typescript \
           node_modules/@types \
           node_modules/bun-types \
           node_modules/undici-types


# ─── ytdlp ────────────────────────────────────────────────────────────────────
# The official standalone build from the GitHub release, *not* pip.
#
# Why it matters: `yt-dlp -U` refuses to run on a pip/wheel install ("you
# installed with pip, use that to update"). The release binary replaces itself,
# which is the whole point of YTDLP_AUTO_UPDATE and of the Settings button.
# We take the musllinux build because the runtime image is Alpine (musl).
FROM alpine:${ALPINE_VERSION} AS ytdlp
ARG YTDLP_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset="yt-dlp_musllinux" ;; \
      arm64) asset="yt-dlp_musllinux_aarch64" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --retry-delay 2 \
      -o /yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
    chmod 0755 /yt-dlp; \
    # Fail the build here rather than at 3am: check it runs and is what we asked for.
    got="$(/yt-dlp --version)"; \
    [ "$got" = "${YTDLP_VERSION}" ] || { echo "yt-dlp reports $got, expected ${YTDLP_VERSION}" >&2; exit 1; }


# ─── runtime ──────────────────────────────────────────────────────────────────
FROM alpine:${ALPINE_VERSION} AS runtime
ARG YTDLP_VERSION

LABEL org.opencontainers.image.title="CasaTube" \
      org.opencontainers.image.description="Self-hosted media downloader that does not lose your work" \
      org.opencontainers.image.source="https://github.com/xantiagoma/casatube" \
      org.opencontainers.image.licenses="MIT AND GPL-3.0-or-later AND GPL-2.0-or-later AND LGPL-2.1-or-later" \
      io.casatube.ytdlp.version="${YTDLP_VERSION}"

# ffmpeg is the real thing from the Alpine repository (remux, embed subtitles,
# fix metadata — PLAN §13: no transcoding, but it must actually work).
# libstdc++ is what the bun binary links against; su-exec drops privileges;
# tini reaps the yt-dlp/ffmpeg children so a cancelled job leaves no zombies.
# zip streams a bundle of a video with its subtitles and thumbnail. It is used
# with -0 (store, no compression): an mp4 is already compressed, so deflating it
# again spends CPU to save almost nothing — and streaming its output keeps
# memory flat, where building the archive in memory would mean holding a
# multi-gigabyte file in RAM.
RUN apk add --no-cache \
        ffmpeg \
        zip \
        libstdc++ \
        su-exec \
        tini \
        tzdata \
        ca-certificates \
 && rm -rf /var/cache/apk/*

COPY --from=bun       /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ytdlp     /yt-dlp            /opt/yt-dlp/yt-dlp.pinned

# /opt/yt-dlp/yt-dlp.pinned is never written to. It is the known-good copy the
# entrypoint seeds from, and the one you restore to after a bad self-update.

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
# The image is itself a distribution — of CasaTube (MIT) and of GPL software
# (yt-dlp's release binary, ffmpeg, x264) — so the licence and the notice that
# says where those sources are travel with it.
COPY LICENSE NOTICE /usr/share/licenses/casatube/
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production \
    PORT=8520 \
    DATA_DIR=/data \
    TEMP_DIR=/data/tmp \
    LIBRARY_DIR=/library \
    MAX_CONCURRENT_DOWNLOADS=3 \
    LOG_LEVEL=info \
    PUID=1000 \
    PGID=1000 \
    UMASK=022 \
    TZ=Etc/UTC \
    YTDLP_BIN=/opt/yt-dlp/yt-dlp \
    YTDLP_AUTO_UPDATE=false \
    CASATUBE_YTDLP_PINNED_VERSION=${YTDLP_VERSION}

# ⚠️ `/library` is deliberately NOT declared here.
#
# A VOLUME line means "if nothing is mounted here, make an anonymous volume".
# For /data that is a safety net worth having: the database is the thing this
# project exists to protect, and without the declaration it would live in the
# container's writable layer and vanish on the next recreate, silently.
#
# For /library it is pure leak. LIBRARY_DIR makes the path configurable, and the
# real deployment mounts nothing at /library at all — it binds the *parent* of
# an rclone FUSE mount and points LIBRARY_DIR inside it. So Docker honoured this
# line and made a fresh anonymous volume on every recreate; six had piled up
# before anyone noticed. A library nobody mounted is not a library worth
# preserving — it is an empty directory nothing will ever read.
VOLUME ["/data"]
EXPOSE 8520

COPY <<'ENTRYPOINT' /usr/local/bin/casatube-entrypoint
#!/bin/sh
# Runs as root, prepares the container, then drops to PUID:PGID and execs the app.
set -eu

log() { printf 'casatube-entrypoint: %s\n' "$*" >&2; }

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-022}"
DATA_DIR="${DATA_DIR:-/data}"
TEMP_DIR="${TEMP_DIR:-$DATA_DIR/tmp}"
LIBRARY_DIR="${LIBRARY_DIR:-/library}"
YTDLP_BIN="${YTDLP_BIN:-/opt/yt-dlp/yt-dlp}"
YTDLP_AUTO_UPDATE="${YTDLP_AUTO_UPDATE:-false}"
YTDLP_PINNED="/opt/yt-dlp/yt-dlp.pinned"

export DATA_DIR TEMP_DIR LIBRARY_DIR YTDLP_BIN

# Files written to the library must be readable by the media server (PLAN §15).
umask "$UMASK"

is_true() {
  case "$1" in 1|y|Y|yes|YES|true|True|TRUE|on|ON) return 0 ;; *) return 1 ;; esac
}

# ── Identity ────────────────────────────────────────────────────────────────
# PUID/PGID are the linuxserver.io convention, which is what the rest of the
# reference deployment (transmission, metube) already uses.
if [ "$(id -u)" -eq 0 ]; then
  RUNNING_AS_ROOT=1

  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" casatube
  fi
  APP_GROUP="$(getent group "$PGID" | cut -d: -f1)"

  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    # -h "$DATA_DIR": su-exec resets HOME from /etc/passwd, so the home has to
    # be right *there* or the export further down is silently overridden.
    adduser -D -H -h "$DATA_DIR" -u "$PUID" -G "$APP_GROUP" -s /sbin/nologin casatube
  fi
  APP_USER="$(getent passwd "$PUID" | cut -d: -f1)"
else
  RUNNING_AS_ROOT=0
  PUID="$(id -u)"
  PGID="$(id -g)"
  # busybox `id -un` on an unmapped uid prints the number *and* exits non-zero,
  # so `|| echo` would concatenate two values. Take the first line, or fall back.
  APP_USER="$(id -un 2>/dev/null | head -n1)"; [ -n "$APP_USER" ] || APP_USER="$PUID"
  APP_GROUP="$(id -gn 2>/dev/null | head -n1)"; [ -n "$APP_GROUP" ] || APP_GROUP="$PGID"
  log "not running as root (uid $PUID) — PUID/PGID and ownership fixes are skipped"
fi

# yt-dlp keeps its user config and its player cache under HOME and the XDG
# directories. Pointing them at DATA_DIR means both live in the volume:
# $DATA_DIR/.config/yt-dlp/config survives a container recreate, and the player
# cache is not re-fetched on every start.
export HOME="$DATA_DIR"
export XDG_CACHE_HOME="$DATA_DIR/.cache"
export XDG_CONFIG_HOME="$DATA_DIR/.config"

# -- Directories -------------------------------------------------------------
# The owner of DATA_DIR is read *before* anything is created inside it. A bind
# mount that already belongs to PUID:PGID would otherwise hide the fact that the
# directories created just below belong to root.
data_owner=""
[ -d "$DATA_DIR" ] && data_owner="$(stat -c '%u:%g' "$DATA_DIR")"

mkdir -p "$DATA_DIR" "$TEMP_DIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

if [ "$RUNNING_AS_ROOT" -eq 1 ]; then
  # Cheap and non-recursive: exactly the directories this script just created.
  chown "$PUID:$PGID" "$DATA_DIR" "$TEMP_DIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

  # Recursive only when DATA_DIR itself had the wrong owner -- first run, or a
  # changed PUID. Otherwise every restart would walk the whole volume.
  if [ -n "$data_owner" ] && [ "$data_owner" != "$PUID:$PGID" ]; then
    log "taking ownership of $DATA_DIR ($data_owner -> $PUID:$PGID)"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi

  # A TEMP_DIR outside DATA_DIR is a deliberate choice (a bigger disk, usually),
  # so it gets the same treatment on its own.
  case "$TEMP_DIR" in
    "$DATA_DIR"/*) : ;;
    *) temp_owner="$(stat -c '%u:%g' "$TEMP_DIR")"
       [ "$temp_owner" = "$PUID:$PGID" ] || chown -R "$PUID:$PGID" "$TEMP_DIR" ;;
  esac
fi

# ⚠️ LIBRARY_DIR is deliberately NOT chowned. It is usually a network mount:
# a recursive chown there would be slow, might not be permitted, and would
# rewrite ownership of files CasaTube did not create. We only check and warn.
as_app_user() {
  if [ "$RUNNING_AS_ROOT" -eq 1 ]; then
    su-exec "$PUID:$PGID" "$@"
  else
    "$@"
  fi
}

if [ ! -d "$LIBRARY_DIR" ]; then
  log "WARNING: LIBRARY_DIR $LIBRARY_DIR does not exist — finished downloads will have nowhere to go"
elif ! as_app_user test -w "$LIBRARY_DIR" 2>/dev/null; then
  log "WARNING: $LIBRARY_DIR is not writable by $PUID:$PGID — check the export's ownership, not just the mount"
fi

# -- yt-dlp ------------------------------------------------------------------
# The pinned copy at $YTDLP_PINNED is never written to. $YTDLP_BIN is the one
# that runs and the one the updater rewrites, so it has to be writable by the
# app user; seeding it from the pinned copy is what makes "restore the shipped
# version" a `rm` away.
# /usr/local/bin/yt-dlp is the wrapper that dispatches to YTDLP_BIN. Pointing
# YTDLP_BIN back at it would be an infinite loop, so refuse it out loud.
if [ "$YTDLP_BIN" = "/usr/local/bin/yt-dlp" ]; then
  log "WARNING: YTDLP_BIN may not be /usr/local/bin/yt-dlp (that is the wrapper) — using /opt/yt-dlp/yt-dlp"
  YTDLP_BIN="/opt/yt-dlp/yt-dlp"
  export YTDLP_BIN
fi

ytdlp_dir="$(dirname "$YTDLP_BIN")"
mkdir -p "$ytdlp_dir" 2>/dev/null || true

if [ ! -x "$YTDLP_BIN" ]; then
  if cp "$YTDLP_PINNED" "$YTDLP_BIN.new" 2>/dev/null \
     && chmod 0755 "$YTDLP_BIN.new" 2>/dev/null \
     && mv -f "$YTDLP_BIN.new" "$YTDLP_BIN" 2>/dev/null; then
    log "seeded yt-dlp ${CASATUBE_YTDLP_PINNED_VERSION:-pinned} into $YTDLP_BIN"
  else
    rm -f "$YTDLP_BIN.new" 2>/dev/null || true
    log "WARNING: cannot write $YTDLP_BIN — falling back to the read-only pinned binary. Self-update is disabled; point YTDLP_BIN at a writable path (e.g. $DATA_DIR/bin/yt-dlp) to get it back"
    YTDLP_BIN="$YTDLP_PINNED"
    export YTDLP_BIN
  fi
fi

# The updater rewrites the binary in place, so the app user must own both the
# file and its directory — this is what makes "check and update" work from
# Settings, not only at start.
if [ "$RUNNING_AS_ROOT" -eq 1 ] && [ "$YTDLP_BIN" != "$YTDLP_PINNED" ]; then
  chown "$PUID:$PGID" "$ytdlp_dir" "$YTDLP_BIN"
fi

if is_true "$YTDLP_AUTO_UPDATE"; then
  log "YTDLP_AUTO_UPDATE is on — running yt-dlp -U"
  as_app_user "$YTDLP_BIN" -U \
    || log "WARNING: yt-dlp self-update failed — continuing with the version already present"
fi

log "yt-dlp $("$YTDLP_BIN" --version 2>/dev/null || echo '?') (pinned ${CASATUBE_YTDLP_PINNED_VERSION:-?}) | ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
log "starting as ${APP_USER}:${APP_GROUP} (${PUID}:${PGID}), umask ${UMASK}, data=${DATA_DIR} library=${LIBRARY_DIR}"

if [ "$RUNNING_AS_ROOT" -eq 1 ]; then
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
ENTRYPOINT

COPY <<'HEALTHCHECK' /usr/local/bin/casatube-healthcheck
#!/bin/sh
# Is the HTTP server answering?
#
# Prefers /api/health. A non-5xx reply still proves the server is up and
# serving, which is what a healthcheck is for — and it keeps the check honest
# while the API surface is still being written. 5xx, a refused connection or a
# timeout are all unhealthy.
set -u

URL="http://127.0.0.1:${PORT:-8520}${HEALTHCHECK_PATH:-/api/health}"

if wget -q -T 5 -O /dev/null "$URL" 2>/dev/null; then
  exit 0
fi

# busybox wget puts the status line in its error message on a non-2xx reply.
status="$(wget -q -S -T 5 -O /dev/null "$URL" 2>&1 | grep -oE 'HTTP/1\.[01] [0-9]{3}' | head -1 | awk '{print $2}')"

case "$status" in
  "")   echo "no HTTP response from $URL" >&2; exit 1 ;;
  5??)  echo "$URL returned $status" >&2; exit 1 ;;
  *)    exit 0 ;;
esac
HEALTHCHECK

# `yt-dlp` on PATH is a two-line wrapper rather than a symlink: it resolves
# YTDLP_BIN at call time, so pointing YTDLP_BIN into the data volume needs no
# write to /usr/local/bin — which a container started with `--user` cannot do.
# The updater still sees the real binary (it resolves its own path), so `-U`
# through the wrapper rewrites the right file.
COPY <<'WRAPPER' /usr/local/bin/yt-dlp
#!/bin/sh
exec "${YTDLP_BIN:-/opt/yt-dlp/yt-dlp}" "$@"
WRAPPER

RUN chmod 0755 /usr/local/bin/casatube-entrypoint \
               /usr/local/bin/casatube-healthcheck \
               /usr/local/bin/yt-dlp

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/casatube-healthcheck"]

# tini is PID 1 so SIGTERM reaches the app and cancelled yt-dlp/ffmpeg children
# are reaped instead of piling up as zombies.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/casatube-entrypoint"]
CMD ["bun", "src/server.ts"]
