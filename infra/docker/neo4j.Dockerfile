FROM neo4j:5
EXPOSE 7474 7687
HEALTHCHECK --interval=15s --timeout=10s --retries=5 \
  CMD cypher-shell -u neo4j -p "${NEO4J_PASSWORD:-kuvalam123}" 'RETURN 1' || exit 1
