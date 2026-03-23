# OKE ARM64 (A4 Flex) Custom Image Setup

OKE doesn't ship ARM images compatible with VM.Standard.A4.Flex. This guide covers how to create a custom OKE image with A4 shape compatibility and handle the boot volume expansion (oci-growfs) that can't be passed via `user_data` on custom images.

## Problem

- **A4 Flex is ARM (aarch64)** but OKE's ARM images only list A1/A2 as compatible shapes
- **K8s 1.35 requires cgroups v2**, which is only pre-enabled in OKE images with build >= 1367
- Setting `user_data` in node metadata on custom OKE images **breaks node registration** (overrides bootstrap)
- Without `oci-growfs`, the root filesystem stays at ~35GB regardless of boot volume size

## Solution: Export/Import OKE Image + Add Shape Compatibility

### 1. Find the right OKE ARM image

```bash
oci ce node-pool-options get --auth security_token \
  --node-pool-option-id all \
  --query 'data.sources[?contains("source-name", `aarch64`) && contains("source-name", `OKE-1.35`)]'
```

Look for build >= 1367 (has cgroups v2 enabled):
`Oracle-Linux-8.10-aarch64-2026.01.29-0-OKE-1.35.0-1367`

### 2. Export the OKE image to Object Storage

```bash
oci os bucket create --auth security_token \
  --compartment-id $COMPARTMENT_ID \
  --name oke-image-export

oci compute image export to-object --auth security_token \
  --image-id $OKE_IMAGE_OCID \
  --namespace $OS_NAMESPACE \
  --bucket-name oke-image-export \
  --name oke-arm-1.35.0-1367.oci \
  --export-format OCI
```

This takes ~15 minutes for a ~47GB image.

### 3. Import as a custom image

```bash
oci compute image import from-object --auth security_token \
  --compartment-id $COMPARTMENT_ID \
  --namespace $OS_NAMESPACE \
  --bucket-name oke-image-export \
  --name oke-arm-1.35.0-1367.oci \
  --display-name "OKE-ARM-1.35.0-1367-A4-Custom" \
  --launch-mode PARAVIRTUALIZED
```

Takes ~10 minutes.

### 4. Add A4 Flex shape compatibility

```bash
oci compute image-shape-compatibility-entry add --auth security_token \
  --image-id $CUSTOM_IMAGE_OCID \
  --shape-name VM.Standard.A4.Flex
```

### 5. Create the node pool (NO user_data)

**Critical**: Do NOT pass `--node-metadata` with `user_data`. Custom OKE images have their own bootstrap process and custom `user_data` overrides it, causing `RegisterTimeOut`.

```bash
oci ce node-pool create --auth security_token \
  --cluster-id $CLUSTER_ID \
  --compartment-id $COMPARTMENT_ID \
  --name "node-pool-arm" \
  --kubernetes-version "v1.35.0" \
  --node-shape "VM.Standard.A4.Flex" \
  --node-shape-config '{"ocpus": 2, "memoryInGBs": 12}' \
  --node-image-id $CUSTOM_IMAGE_OCID \
  --size 2 \
  --placement-configs '[{"availabilityDomain": "XYpk:US-ASHBURN-AD-2", "subnetId": "'$WORKER_SUBNET_ID'"}]' \
  --pod-subnet-ids '["'$POD_SUBNET_ID'"]' \
  --node-boot-volume-size-in-gbs 100 \
  --ssh-public-key "$(cat ~/.ssh/sky-key.pub)"
```

Nodes register in ~4 minutes.

### 6. Expand the root filesystem via DaemonSet

Since we can't use `user_data`, deploy a DaemonSet to run `oci-growfs` on each node after registration. **Do this immediately** — before pods start pulling images — or the 35GB root FS fills up and triggers disk pressure.

```bash
# Cordon nodes first to prevent pods from scheduling
kubectl cordon <node1>
kubectl cordon <node2>

# Deploy growfs DaemonSet
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: oci-growfs
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: oci-growfs
  template:
    metadata:
      labels:
        app: oci-growfs
    spec:
      hostPID: true
      priorityClassName: system-node-critical
      initContainers:
      - name: growfs
        image: busybox:latest
        command: ["chroot", "/host", "/usr/libexec/oci-growfs", "-y"]
        securityContext:
          privileged: true
        volumeMounts:
        - name: host
          mountPath: /host
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
      volumes:
      - name: host
        hostPath:
          path: /
      tolerations:
      - operator: Exists
      nodeSelector:
        kubernetes.io/arch: arm64
EOF
```

Wait for the init containers to complete (~2-3 minutes), then verify disk pressure is cleared:

```bash
kubectl describe node <node> | grep DiskPressure
```

Once `DiskPressure: False`, uncordon:

```bash
kubectl uncordon <node1>
kubectl uncordon <node2>
```

### 7. Label nodes

```bash
kubectl label node <node1> node.kubernetes.io/purpose=system
kubectl label node <node2> node.kubernetes.io/purpose=system
```

## Important Notes

- **A4 Flex availability varies by AD** — in us-ashburn-1, only AD-2 had capacity
- **PersistentVolumes are AD-bound** — if migrating from another AD, you must delete and recreate PVCs (data loss for staging, plan migration for production)
- **Container images must be arm64** — rebuild all app images with `platforms: linux/arm64` in CI
- The DaemonSet can be left running — it's idempotent and only runs growfs once via the init container
