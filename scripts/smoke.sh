#!/usr/bin/env bash
# Is the deployed app actually usable?
#
# ⚠️ `curl /api/health` is not that check. A client bundle that fails to build
# leaves the API answering 200 while the page is blank — the server logs one
# line and carries on. So this fetches the page, extracts the script it points
# at, and fetches that too. Found the hard way: a value imported from a core
# module dragged bun:sqlite into a browser target, typechecked fine, and killed
# the bundle while every curl said 200.
set -uo pipefail
BASE="${1:-http://127.0.0.1:8520}"
fail=0
say() { printf '  %-32s %s\n' "$1" "$2"; }

code=$(curl -s -m 20 -o /tmp/smoke.html -w '%{http_code}' "$BASE/")
[ "$code" = 200 ] || { say page "HTTP $code"; fail=1; }

asset=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' /tmp/smoke.html | head -1)
if [ -z "$asset" ]; then
  say "client script" "NOT REFERENCED — bundle never built"; fail=1
else
  size=$(curl -s -m 30 -o /dev/null -w '%{size_download}' "$BASE$asset")
  if [ "${size:-0}" -lt 10000 ]; then
    say "client script" "only ${size} bytes"; fail=1
  else
    say "client script" "$((size / 1024)) KB"
  fi
fi

for r in api/health api/jobs api/library api/sources api/scheduler \
         api/stats/storage api/notifications api/plugins api/settings \
         api/credentials api/transcode api/destinations; do
  c=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/$r")
  [ "$c" = 200 ] || { say "$r" "HTTP $c"; fail=1; }
done
[ $fail -eq 0 ] && say "every area" "200"

if docker logs casatube 2>&1 | grep -qi 'bundle failed'; then
  say "server log" "SAYS THE BUNDLE FAILED"; fail=1
fi
exit $fail
