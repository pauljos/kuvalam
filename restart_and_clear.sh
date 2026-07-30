#!/bin/bash
set -e

echo "=== 1. Clearing Redis cache ==="
docker exec axon_redis redis-cli FLUSHALL && echo "✅ Redis cache cleared"

echo ""
echo "=== 2. Verifying Medical Chart Designer system prompt ==="
PGPASSWORD=axon_dev_password psql -h localhost -p 5434 -U axon -d axon_db -t -c "SELECT LEFT(system_prompt, 250) FROM agents WHERE id = '5f3d7649-8703-49f6-93c2-ec623a9fdc0c';"

echo ""
echo "=== 3. Restarting API (port 3001) ==="
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "✅ Old API killed" || echo "No old API process"
sleep 1
cd /Users/PaulJoseph/pgent/apps/api
node src/index.js &
echo "✅ API starting in background (pid $!)"

echo ""
echo "=== Done! Wait a few seconds for the API to boot, then run your dental chart task. ==="
