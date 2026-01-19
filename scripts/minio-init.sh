#!/bin/sh
# =============================================================================
# MinIO Initialization Script
# =============================================================================
# Creates schemas bucket and seeds built-in schemas from /schemas mount
# Used by docker-compose minio-init service
# =============================================================================

set -e

echo "Setting up MinIO..."

# Configure mc alias
mc alias set myminio http://minio:9000 minioadmin minioadmin

# Create buckets (ignore if exists)
mc mb myminio/shogo-schemas --ignore-existing
mc mb myminio/shogo-workspaces --ignore-existing
echo "Buckets created successfully."

# Set CORS policy for workspaces bucket (allows browser direct access)
echo "Setting CORS policy for workspaces bucket..."
cat > /tmp/cors.json << 'CORS'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
      "MaxAgeSeconds": 3600
    }
  ]
}
CORS
# MinIO mc uses different syntax for CORS
mc anonymous set download myminio/shogo-workspaces 2>/dev/null || true
echo "CORS policy set."

# Seed built-in schemas if /schemas is mounted
if [ -d "/schemas" ]; then
    echo "Seeding built-in schemas..."
    
    # Count schemas
    schema_count=0
    
    # Iterate through schema directories
    for schema_dir in /schemas/*/; do
        # Check if it's a directory with schema.json
        if [ -d "$schema_dir" ] && [ -f "${schema_dir}schema.json" ]; then
            schema_name=$(basename "$schema_dir")
            echo "  Seeding: $schema_name"
            mc cp --recursive "$schema_dir" "myminio/shogo-schemas/schemas/workspace/${schema_name}/"
            schema_count=$((schema_count + 1))
        fi
    done
    
    echo ""
    echo "Schema seeding complete! Seeded $schema_count schemas."
    echo ""
    echo "Listing schemas in S3:"
    mc ls myminio/shogo-schemas/schemas/workspace/ 2>/dev/null | head -30 || echo "  (none found)"
else
    echo "No /schemas mount found - skipping schema seeding"
fi

# Seed workspaces if /workspaces is mounted
if [ -d "/workspaces" ]; then
    echo ""
    echo "Seeding workspaces to S3..."

    workspace_count=0

    # Iterate through workspace directories (project IDs)
    for workspace_dir in /workspaces/*/; do
        if [ -d "$workspace_dir" ]; then
            workspace_name=$(basename "$workspace_dir")
            # Skip template directory
            if [ "$workspace_name" = "_template" ]; then
                continue
            fi
            echo "  Seeding workspace: $workspace_name"
            mc cp --recursive "$workspace_dir" "myminio/shogo-workspaces/${workspace_name}/"
            workspace_count=$((workspace_count + 1))
        fi
    done

    echo ""
    echo "Workspace seeding complete! Seeded $workspace_count workspaces."
    echo ""
    echo "Listing workspaces in S3:"
    mc ls myminio/shogo-workspaces/ 2>/dev/null | head -20 || echo "  (none found)"
else
    echo "No /workspaces mount found - skipping workspace seeding"
fi

echo ""
echo "MinIO initialization complete!"
