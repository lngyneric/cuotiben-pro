#!/bin/bash
# Deploy the sysmex Presenton template into the presenton-trial container.
#
# Run ON idcaitool8svr, from the wiki worktree:
#   cd /home/sysmex/cuotiben-pro-blog && bash presenton-templates/deploy.sh
#
# Steps: refuse while a PPT job is generating/queued -> copy sysmex/ into
# the container -> verify files -> restart presenton -> wait for startup.
# /app/templates is not a volume, so re-run this after any container
# recreation from the image.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== guard: no active PPT jobs =="
ACTIVE=$(python3 -c "
import sqlite3, shutil, sys, time
shutil.copyfile('/var/lib/docker/volumes/cuotiben-pro-blog_cuotiben-blog-data/_data/blog.db', '/tmp/ppt-deploy-audit.db')
c = sqlite3.connect('/tmp/ppt-deploy-audit.db')
# Only jobs updated in the last 60 minutes count as in-flight. A job stuck in
# 'generating' with a frozen updated_at (e.g. 495f3eca, dead since 2026-11-25
# 14:19 after Presenton's LiteParse timed out on logo.png) is not a live
# generation — the hourly tracker already reports those as STUCK.
cutoff = int(time.time() * 1000) - 60 * 60 * 1000
rows = c.execute(\"SELECT id, status, updated_at FROM presentation_job WHERE status IN ('queued','generating')\").fetchall()
live = [r for r in rows if (r[2] or 0) >= cutoff]
for r in rows:
    if (r[2] or 0) < cutoff:
        print(f'skipping stuck job {r[0][:8]} status={r[1]} (no update for >60 min)', file=sys.stderr)
print(len(live))
")
if [ "$ACTIVE" != "0" ]; then
  echo "REFUSE: $ACTIVE PPT job(s) still generating/queued — wait for them to finish, then re-run."
  exit 1
fi
echo "ok (0 active jobs)"

echo "== copy presenton-templates/sysmex into the container =="
docker cp presenton-templates/sysmex presenton-trial:/app/templates/sysmex

echo "== verify files inside the container =="
docker exec presenton-trial python3 - << 'PYEOF'
import json, hashlib
t = json.load(open('/app/templates/sysmex/template.json'))
assert t['id'] == 'sysmex', t.get('id')
n = json.dumps(t).count('sysmex_logo')
assert n >= 24, f"expected >=24 sysmex_logo placements, got {n}"
logo = open('/app/templates/sysmex/static/logo.png','rb').read()
assert logo[:8] == b'\x89PNG\r\n\x1a\n', "logo.png is not a PNG"
print(f"ok: template id=sysmex, sysmex_logo occurrences={n}, logo.png {len(logo)} bytes")
PYEOF

echo "== restart presenton-trial =="
docker restart presenton-trial >/dev/null
echo -n "waiting for startup"
for _ in $(seq 1 60); do
  if docker logs presenton-trial --since 2m 2>&1 | grep -q "Application startup complete"; then
    echo ""
    echo "ok: presenton restarted and serving"
    exit 0
  fi
  echo -n "."
  sleep 5
done
echo ""
echo "ERROR: presenton did not report startup within 5 minutes — check 'docker logs presenton-trial'"
exit 1
