# Knative Maintenance Guide

This guide covers common Knative maintenance tasks for Shogo's per-project pod infrastructure.

## Common Issues

### ImagePullBackOff Pods

When you see many pods in `ImagePullBackOff` or `Pending` state, it's usually due to:
1. Stale Knative revisions referencing old/deleted images
2. Image registry authentication issues
3. Resource quota exceeded

### Diagnosis Commands

```bash
# List all pods in the workspaces namespace
kubectl get pods -n shogo-staging-workspaces

# See detailed pod status (look for ImagePullBackOff, Pending, Evicted)
kubectl get pods -n shogo-staging-workspaces -o wide

# Check events for a specific pod
kubectl describe pod <pod-name> -n shogo-staging-workspaces

# List all Knative revisions
kubectl get revisions -n shogo-staging-workspaces

# Check image pull secrets
kubectl get secret ghcr-pull-secret -n shogo-staging-workspaces -o yaml
```

## Cleanup Commands

### Clean Up Stale Revisions

Knative automatically creates a new revision for each deployment. Old revisions can accumulate and reference deleted images.

```bash
# List all revisions (sorted by creation time)
kubectl get revisions -n shogo-staging-workspaces --sort-by=.metadata.creationTimestamp

# Delete a specific old revision
kubectl delete revision <revision-name> -n shogo-staging-workspaces

# Delete all revisions older than a certain age (be careful!)
# First, list them to verify:
kubectl get revisions -n shogo-staging-workspaces -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}'

# Delete revisions that aren't the latest for their service
# This script keeps only the latest 2 revisions per service:
kubectl get revisions -n shogo-staging-workspaces -o json | jq -r '
  .items | 
  group_by(.metadata.ownerReferences[0].name) | 
  .[] | 
  sort_by(.metadata.creationTimestamp) | 
  reverse | 
  .[2:] | 
  .[].metadata.name
' | xargs -I {} kubectl delete revision {} -n shogo-staging-workspaces
```

### Clean Up Evicted Pods

Evicted pods can accumulate when resources are constrained.

```bash
# Delete all evicted pods
kubectl get pods -n shogo-staging-workspaces | grep Evicted | awk '{print $1}' | xargs kubectl delete pod -n shogo-staging-workspaces

# Delete all failed/errored pods
kubectl delete pods -n shogo-staging-workspaces --field-selector=status.phase=Failed
```

### Clean Up Old Knative Services

If a project is deleted but its Knative Service remains:

```bash
# List all project services
kubectl get ksvc -n shogo-staging-workspaces -l shogo.io/component=project-runtime

# Delete a specific project's service
kubectl delete ksvc project-<project-id> -n shogo-staging-workspaces
```

## Garbage Collection Configuration

Apply this ConfigMap to configure automatic Knative garbage collection:

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-gc
  namespace: knative-serving
data:
  # Keep only 2 non-active revisions per service
  max-non-active-revisions: "2"
  # Retain revisions created in last 48h
  retain-since-create-time: "48h"
  # Delete revisions 30 minutes after becoming inactive
  retain-since-last-active-time: "30m"
  # Always keep at least 1 revision
  min-non-active-revisions: "1"
EOF
```

After applying, the Knative controller will automatically clean up old revisions.

## Image Pull Issues

### Check Image Pull Secret

```bash
# Verify the pull secret exists and is valid
kubectl get secret ghcr-pull-secret -n shogo-staging-workspaces

# Decode and verify credentials (caution: shows credentials!)
kubectl get secret ghcr-pull-secret -n shogo-staging-workspaces -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq

# Test pulling an image manually
kubectl run test-pull --image=ghcr.io/shogo-ai/project-runtime:staging-latest -n shogo-staging-workspaces --rm -it --restart=Never -- echo "Image pull successful"
```

### Update Image Pull Secret

If the secret is expired or invalid:

```bash
# Create/update the secret
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<github-pat> \
  --docker-email=<email> \
  -n shogo-staging-workspaces \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Resource Quota Issues

If pods are pending due to resource constraints:

```bash
# Check resource quotas
kubectl describe resourcequota -n shogo-staging-workspaces

# Check current resource usage
kubectl top pods -n shogo-staging-workspaces

# Check node resource usage
kubectl top nodes
```

## Monitoring

### Watch Pod Status

```bash
# Watch pods in real-time
watch kubectl get pods -n shogo-staging-workspaces

# Watch Knative services
watch kubectl get ksvc -n shogo-staging-workspaces
```

### Check Knative Controller Logs

```bash
# Check activator logs (handles scale-from-zero)
kubectl logs -l app=activator -n knative-serving --tail=100

# Check controller logs
kubectl logs -l app=controller -n knative-serving --tail=100
```
