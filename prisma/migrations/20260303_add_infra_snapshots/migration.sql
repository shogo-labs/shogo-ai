-- CreateTable
CREATE TABLE "infra_snapshots" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalNodes" INTEGER NOT NULL,
    "asgDesired" INTEGER NOT NULL,
    "asgMax" INTEGER NOT NULL,
    "totalPodSlots" INTEGER NOT NULL,
    "usedPodSlots" INTEGER NOT NULL,
    "totalCpuMillis" INTEGER NOT NULL,
    "usedCpuMillis" INTEGER NOT NULL,
    "warmAvailable" INTEGER NOT NULL,
    "warmTarget" INTEGER NOT NULL,
    "warmAssigned" INTEGER NOT NULL,
    "coldStarts" INTEGER NOT NULL DEFAULT 0,
    "totalProjects" INTEGER NOT NULL,
    "readyProjects" INTEGER NOT NULL,
    "runningProjects" INTEGER NOT NULL,
    "scaledToZero" INTEGER NOT NULL,
    "orphansDeleted" INTEGER NOT NULL DEFAULT 0,
    "idleEvictions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "infra_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infra_snapshots_timestamp_idx" ON "infra_snapshots"("timestamp");
