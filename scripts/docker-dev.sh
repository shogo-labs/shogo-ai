#!/bin/bash
# =============================================================================
# Shogo AI - Docker Development Helper Script
# =============================================================================
# This script helps manage the Docker development environment.
#
# Usage:
#   ./scripts/docker-dev.sh start    # Start dev environment (all services)
#   ./scripts/docker-dev.sh infra    # Start only infrastructure (postgres, redis, minio)
#   ./scripts/docker-dev.sh stop     # Stop dev environment
#   ./scripts/docker-dev.sh restart  # Restart dev environment
#   ./scripts/docker-dev.sh logs     # Follow all logs
#   ./scripts/docker-dev.sh clean    # Stop and remove all volumes
#   ./scripts/docker-dev.sh reset    # Clean rebuild (remove node_modules volumes)
# =============================================================================

set -e

COMPOSE_FILE="docker-compose.dev.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PROJECT_DIR"

case "${1:-start}" in
  start)
    echo "🚀 Starting Shogo development environment..."
    docker-compose -f "$COMPOSE_FILE" up -d
    echo ""
    echo "✅ Services started!"
    echo ""
    echo "📍 Access points:"
    echo "   Web:      http://localhost:5173"
    echo "   API:      http://localhost:8002"
    echo "   MCP:      http://localhost:3100"
    echo "   Postgres: localhost:5432"
    echo "   Redis:    localhost:6379"
    echo "   MinIO:    http://localhost:9001 (console)"
    echo ""
    echo "📋 Useful commands:"
    echo "   View logs:  docker-compose -f $COMPOSE_FILE logs -f"
    echo "   Stop:       docker-compose -f $COMPOSE_FILE down"
    echo ""
    ;;
  infra)
    echo "🚀 Starting infrastructure only (postgres, redis, minio)..."
    docker-compose -f "$COMPOSE_FILE" up -d postgres redis minio
    echo ""
    echo "✅ Infrastructure started!"
    echo ""
    echo "📍 Access points:"
    echo "   Postgres: localhost:5432 (user: shogo, password: shogo_dev, db: shogo)"
    echo "   Redis:    localhost:6379"
    echo "   MinIO:    http://localhost:9001 (console)"
    echo ""
    echo "💡 First time setup:"
    echo "   ./scripts/docker-dev.sh init  # Initialize database tables"
    echo ""
    echo "💡 Then run your apps locally:"
    echo "   bun run dev        # Start all apps with turbo"
    echo "   bun run web:dev    # Start web only"
    echo "   bun run api:dev    # Start API only"
    echo "   bun run mcp:http   # Start MCP only"
    echo ""
    ;;
  stop)
    echo "🛑 Stopping Shogo development environment..."
    docker-compose -f "$COMPOSE_FILE" down
    echo "✅ Services stopped."
    ;;
  restart)
    echo "🔄 Restarting Shogo development environment..."
    docker-compose -f "$COMPOSE_FILE" down
    docker-compose -f "$COMPOSE_FILE" up -d
    echo "✅ Services restarted."
    ;;
  logs)
    docker-compose -f "$COMPOSE_FILE" logs -f
    ;;
  clean)
    echo "🧹 Cleaning up Shogo development environment..."
    docker-compose -f "$COMPOSE_FILE" down -v
    echo "✅ All services stopped and volumes removed."
    ;;
  reset)
    echo "🔥 Resetting Shogo development environment (removing node_modules)..."
    docker-compose -f "$COMPOSE_FILE" down -v
    echo "Removing node_modules volumes..."
    docker volume rm shogo-mcp-node-modules-dev shogo-api-node-modules-dev shogo-web-node-modules-dev shogo-state-api-node-modules-dev shogo-web-app-node-modules-dev 2>/dev/null || true
    echo ""
    echo "✅ Environment reset. Run './scripts/docker-dev.sh start' to rebuild."
    ;;
  status)
    docker-compose -f "$COMPOSE_FILE" ps
    ;;
  init)
    echo "🗄️  Initializing database..."
    echo ""
    # Check if postgres is running
    if ! docker-compose -f "$COMPOSE_FILE" ps postgres | grep -q "running"; then
      echo "⚠️  PostgreSQL is not running. Starting infrastructure first..."
      docker-compose -f "$COMPOSE_FILE" up -d postgres
      echo "Waiting for PostgreSQL to be ready..."
      sleep 5
    fi
    # Run database initialization script
    bun apps/api/scripts/init-database.ts
    echo ""
    ;;
  *)
    echo "Usage: $0 {start|infra|stop|restart|logs|clean|reset|status|init}"
    exit 1
    ;;
esac
