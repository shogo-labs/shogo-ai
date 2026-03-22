#!/bin/bash
# =============================================================================
# Toggle S3 Schema Storage Mode for Local Development
# =============================================================================
# Usage:
#   ./scripts/docker-s3-mode.sh enable   # Switch to S3 mode (MinIO)
#   ./scripts/docker-s3-mode.sh disable  # Switch to filesystem mode (default)
#   ./scripts/docker-s3-mode.sh status   # Show current mode
# =============================================================================

set -e

ENV_FILE=".env.local"

enable_s3() {
    echo "Enabling S3 storage mode (MinIO)..."
    
    # Create or update .env.local with S3 settings
    if [ -f "$ENV_FILE" ]; then
        # Remove existing schema storage lines
        grep -v "^SCHEMA_STORAGE=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
        grep -v "^S3_" "$ENV_FILE.tmp" > "$ENV_FILE" || true
        rm -f "$ENV_FILE.tmp"
    fi
    
    # Append S3 configuration
    cat >> "$ENV_FILE" << 'EOF'

# S3 Schema Storage (MinIO)
SCHEMA_STORAGE=s3
S3_SCHEMA_BUCKET=shogo-schemas
S3_SCHEMA_PREFIX=schemas/
S3_ENDPOINT=http://minio:9000
EOF

    echo "✓ S3 mode enabled in $ENV_FILE"
    echo ""
    echo "Restart containers to apply:"
    echo "  docker-compose down && docker-compose up"
    echo ""
    echo "View schemas in MinIO console: http://localhost:9001"
    echo "  Username: minioadmin"
    echo "  Password: minioadmin"
}

disable_s3() {
    echo "Disabling S3 storage mode (using filesystem)..."
    
    if [ -f "$ENV_FILE" ]; then
        # Remove S3-related lines
        grep -v "^SCHEMA_STORAGE=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
        grep -v "^S3_" "$ENV_FILE.tmp" > "$ENV_FILE" || true
        grep -v "^# S3 Schema Storage" "$ENV_FILE" > "$ENV_FILE.tmp" || true
        mv "$ENV_FILE.tmp" "$ENV_FILE"
        
        # Clean up empty lines at end
        sed -i.bak -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$ENV_FILE" 2>/dev/null || true
        rm -f "$ENV_FILE.bak"
    fi
    
    echo "✓ Filesystem mode enabled (default)"
    echo ""
    echo "Restart containers to apply:"
    echo "  docker-compose down && docker-compose up"
}

show_status() {
    echo "Current schema storage configuration:"
    echo ""
    
    if [ -f "$ENV_FILE" ] && grep -q "^SCHEMA_STORAGE=s3" "$ENV_FILE"; then
        echo "  Mode: S3 (MinIO)"
        echo ""
        echo "  S3 Configuration:"
        grep "^S3_" "$ENV_FILE" 2>/dev/null | sed 's/^/    /' || echo "    (using defaults)"
        echo ""
        echo "  MinIO Console: http://localhost:9001"
    else
        echo "  Mode: Filesystem (default)"
        echo ""
        echo "  Schemas stored in: ./.schemas/"
    fi
}

case "${1:-status}" in
    enable|on|s3)
        enable_s3
        ;;
    disable|off|fs|filesystem)
        disable_s3
        ;;
    status)
        show_status
        ;;
    *)
        echo "Usage: $0 {enable|disable|status}"
        echo ""
        echo "Commands:"
        echo "  enable   - Switch to S3 mode (MinIO)"
        echo "  disable  - Switch to filesystem mode (default)"
        echo "  status   - Show current mode"
        exit 1
        ;;
esac
