#!/bin/bash
set -e

echo "=== Login ==="
COOKIE=$(curl -s -c - 'http://localhost:3001/api/v1/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"paul@acme.com","password":"password123"}' \
  | grep kuvalam_token | awk '{print $NF}')
echo "Cookie: ${COOKIE:0:30}..."

echo ""
echo "=== List Knowledge Graphs (should be empty or existing) ==="
curl -s -b "kuvalam_token=$COOKIE" \
  'http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/knowledge-graphs' \
  | python3 -m json.tool

echo ""
echo "=== Create Knowledge Graph ==="
GRAPH=$(curl -s -b "kuvalam_token=$COOKIE" \
  'http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/knowledge-graphs' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Customer 360","description":"Customer entities and relationships","graphKind":"neo4j"}')
echo "$GRAPH" | python3 -m json.tool
GRAPH_ID=$(echo "$GRAPH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
echo "Graph ID: $GRAPH_ID"

echo ""
echo "=== Link Graph to Agent ==="
# Get the first agent
AGENT_ID=$(curl -s -b "kuvalam_token=$COOKIE" \
  'http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/agents' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agents',d.get('data',[{}]))[0].get('id',''))")
echo "Agent ID: $AGENT_ID"

if [ -n "$AGENT_ID" ] && [ -n "$GRAPH_ID" ]; then
  curl -s -b "kuvalam_token=$COOKIE" \
    "http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/agents/$AGENT_ID/knowledge-graphs/$GRAPH_ID" \
    -X POST -H 'Content-Type: application/json' -d '{}' \
    | python3 -m json.tool
fi

echo ""
echo "=== Verify Agent has graph ==="
if [ -n "$AGENT_ID" ]; then
  curl -s -b "kuvalam_token=$COOKIE" \
    "http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/agents/$AGENT_ID" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('knowledge_graph_ids:', d.get('knowledge_graph_ids', 'N/A'))"
fi

echo ""
echo "=== Cleanup: Unlink graph ==="
if [ -n "$AGENT_ID" ] && [ -n "$GRAPH_ID" ]; then
  curl -s -b "kuvalam_token=$COOKIE" \
    "http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/agents/$AGENT_ID/knowledge-graphs/$GRAPH_ID" \
    -X DELETE \
    | python3 -m json.tool
fi

echo ""
echo "=== Delete Graph ==="
if [ -n "$GRAPH_ID" ]; then
  curl -s -b "kuvalam_token=$COOKIE" \
    "http://localhost:3001/api/v1/tenants/712a1cc2-84e8-46c9-9706-9470328bb892/knowledge-graphs/$GRAPH_ID" \
    -X DELETE \
    | python3 -m json.tool
fi

echo ""
echo "=== DONE ==="
