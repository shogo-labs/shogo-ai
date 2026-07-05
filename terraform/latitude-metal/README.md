<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Latitude.sh bare-metal fleet (cloud-agnostic Firecracker substrate)

Provisions the bare-metal host(s) that run project runtimes as Firecracker
microVMs, independent of OCI/OKE. This is the cloud-agnostic track of the Cloud
Firecracker snapshots plan.

## Pilot host

`s3-large-x86` — 24-core AMD EPYC 7443P (Milan), **512 GB RAM**, 2× 3.8 TB local
NVMe, ~$0.89/hr (~$650/mo), site **ASH** (same metro as OCI `us-ashburn-1`).
Local NVMe removes the remote-block-volume IOPS/fault-storm risk; a public IPv4
means direct SSH (no bastion).

## Provision

```bash
export LATITUDESH_AUTH_TOKEN=<your-latitude-api-token>   # never commit this
terraform -chdir=terraform/latitude-metal init
terraform -chdir=terraform/latitude-metal apply
```

Outputs the host's public IP. Then benchmark Firecracker restore on it (the
provider-agnostic path built for Phase 1):

```bash
SSH_TARGET=root@<server_ip> bash scripts/firecracker-spike/run-spike-ssh.sh
```

Knobs (see [main.tf](main.tf)): `plan` (default `s3-large-x86`), `site`
(`ASH`), `server_count` (default 1), `ssh_public_key_file`.

## Notes

- **State is LOCAL** for now; it graduates to the shared remote backend once the
  substrate architecture is locked.
- An external box **cannot** join the OKE cluster (OKE bootstrap + VCN-native
  CNI + IAM are OCI-locked). This fleet is a *separate* runtime substrate that
  the shogo API reaches over a cross-cloud link — see the plan's cloud-agnostic
  substrate section for the node-agent + `metal` pod-mode design.

## Teardown (stop billing)

```bash
terraform -chdir=terraform/latitude-metal destroy
```
