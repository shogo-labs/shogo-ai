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

# Create bucket (ignore if exists)
mc mb myminio/shogo-schemas --ignore-existing
echo "Bucket created successfully."

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

echo ""
echo "MinIO initialization complete!"
