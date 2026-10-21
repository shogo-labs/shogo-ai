// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace usage panel for the Analytics screen: rolling-window progress,
 * spend summary, team usage chart, and the usage event log.
 *
 * Works in local mode too: the API serves these endpoints from the local DB,
 * and usage/cost figures for a linked cloud plan come from the cloud summary.
 */

import { useState, useEffect, useCallback } from "react";
import { View, Pressable, Platform, Linking } from "react-native";
import { useRouter } from "expo-router";
import {
  Coins as CoinsIcon,
  CreditCard as CreditCardIcon,
  Download as DownloadIcon,
  Zap as ZapIcon,
} from "lucide-react-native";
import {
  Text,
  useAccountSheetIcons,
} from "../settings/account-sheet-chrome";
import { useDomainHttp } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useCloudBillingSummary } from "../../hooks/useCloudBillingSummary";
import { useBillingData } from "@shogo/shared-app/hooks";
import { getWindowDisplays } from "../../lib/billing-config";
import { api } from "../../lib/api";
import { useUsageLogCsvUrl } from "../../lib/usage-log-csv";
import { usePlatformConfig } from "../../lib/platform-config";
import { useVisibleModels } from "../../lib/visible-models";
import { BillingProgressCard } from "../billing/BillingProgressCard";
import { SetSpendLimitDialog } from "../billing/SetSpendLimitDialog";
import {
  type AnalyticsPeriod,
  type UsageSummaryData,
  type UsageLogData,
  type ChatAnalyticsData,
  type UsageBreakdownData,
  type SpendGroupBy,
  type SpendMetric,
  StatCard,
  UsageTableSection,
  ChatAnalyticsSection,
  UsageBreakdownSection,
  UsageTimeseriesChart,
} from "./SharedAnalytics";
import { DateRangePills } from "./DateRangePills";
import { LoadErrorNotice, type LoadErrors } from "./LoadErrorNotice";
import { UsageLeaderboard } from "./UsageLeaderboard";
import { WorkspaceActivitySection } from "./WorkspaceActivitySection";

const USAGE_ICON_MAP = {
  Coins: CoinsIcon,
  CreditCard: CreditCardIcon,
  Download: DownloadIcon,
  Zap: ZapIcon,
} as const;

function useUsageIcons() {
  return useAccountSheetIcons(USAGE_ICON_MAP);
}

interface SpendTimeseriesPayload {
  days: { date: string; byModel: Record<string, number>; total: number }[];
  totals: {
    totalSpendUsd: number;
    totalIncludedUsd: number;
    totalOnDemandUsd: number;
    uniqueModels: number;
  };
  models: string[];
  groupBy: "model" | "user" | "source";
  metric: "spend" | "tokens" | "requests";
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** A labelled block of the Usage tab, so the long scroll reads as distinct parts. */
function Section({
  title,
  subtitle,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View className="gap-3" testID={testID}>
      <View>
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        {subtitle ? (
          <Text className="text-xs text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function WorkspaceUsagePanel() {
  const { Coins, CreditCard, Download, Zap } = useUsageIcons();
  const http = useDomainHttp();
  const router = useRouter();
  const workspace = useActiveWorkspace();
  const workspaceId = workspace?.id;
  const { localMode } = usePlatformConfig();
  const { subscription, effectiveBalance, usageWindows, refetchUsageWallet } =
    useBillingData(workspaceId);
  const cloudBilling = useCloudBillingSummary(localMode);
  // Warm the visible-models metadata cache so chart series can be labeled with
  // model display names (e.g. "Hoshi 1.0") rather than raw ids (mimo-v2.5).
  useVisibleModels();

  const planId = subscription?.planId?.toLowerCase() ?? "";
  const isBusinessOrHigher =
    localMode ||
    planId.startsWith("business") ||
    planId.startsWith("enterprise");

  const [period, setPeriod] = useState<AnalyticsPeriod>("7d");
  const [logPage, setLogPage] = useState(1);
  const [groupBy, setGroupBy] = useState<SpendGroupBy>("model");
  const [metric, setMetric] = useState<SpendMetric>("spend");
  const [spendLimitOpen, setSpendLimitOpen] = useState(false);

  const [usageSummary, setUsageSummary] = useState<{
    data: UsageSummaryData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [usageLog, setUsageLog] = useState<{
    data: UsageLogData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [spend, setSpend] = useState<{
    data: SpendTimeseriesPayload | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [usage, setUsage] = useState<{
    data: UsageBreakdownData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [chatStats, setChatStats] = useState<{
    data: ChatAnalyticsData | null;
    loading: boolean;
  }>({ data: null, loading: true });

  const [loadErrors, setLoadErrors] = useState<LoadErrors>({});

  const loadAll = useCallback(async () => {
    if (!workspaceId) return;
    const p = { period };
    const errors: LoadErrors = {};
    const section = <T,>(label: string, request: Promise<T>) =>
      request.catch((err: any) => {
        errors[label] = err?.message || "Request failed";
        return null;
      });

    setUsageSummary((s) => ({ ...s, loading: true }));
    setUsageLog((s) => ({ ...s, loading: true }));
    setSpend((s) => ({ ...s, loading: true }));

    const basicFetches = [
      section(
        "usage summary",
        api.getWorkspaceAnalytics<UsageSummaryData>(
          http,
          workspaceId,
          "usage-summary",
          p
        )
      ),
      section(
        "event log",
        api.getWorkspaceAnalytics<UsageLogData>(http, workspaceId, "usage-log", {
          ...p,
          page: String(logPage),
          limit: "50",
        })
      ),
      section(
        "team usage chart",
        api.getWorkspaceAnalytics<SpendTimeseriesPayload>(
          http,
          workspaceId,
          "spend-timeseries",
          { ...p, groupBy, metric }
        )
      ),
    ] as const;

    if (isBusinessOrHigher) {
      setUsage((s) => ({ ...s, loading: true }));
      setChatStats((s) => ({ ...s, loading: true }));

      const [uSum, uLog, sp, us, ch] = await Promise.all([
        ...basicFetches,
        section(
          "usage breakdown",
          api.getWorkspaceAnalytics<UsageBreakdownData>(
            http,
            workspaceId,
            "usage",
            p
          )
        ),
        section(
          "chat stats",
          api.getWorkspaceAnalytics<ChatAnalyticsData>(
            http,
            workspaceId,
            "chat",
            p
          )
        ),
      ]);

      setUsageSummary({ data: uSum, loading: false });
      setUsageLog({ data: uLog, loading: false });
      setSpend({ data: sp, loading: false });
      setUsage({ data: us, loading: false });
      setChatStats({ data: ch, loading: false });
    } else {
      const [uSum, uLog, sp] = await Promise.all(basicFetches);
      setUsageSummary({ data: uSum, loading: false });
      setUsageLog({ data: uLog, loading: false });
      setSpend({ data: sp, loading: false });
    }
    setLoadErrors(errors);
  }, [http, workspaceId, period, logPage, groupBy, metric, isBusinessOrHigher]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">
          No workspace selected
        </Text>
      </View>
    );
  }

  // ─── Progress card data ──────────────────────────────────
  // Coupled window display: weekly-at-100% forces the 5-hour card to 100% too.
  // In local mode usage is metered against the linked Shogo Cloud workspace,
  // so read windows from the cloud billing summary, not the local plan.
  const cloudPlan = cloudBilling.summary?.plan;
  const displayWindows = localMode
    ? (cloudPlan?.usageWindows as typeof usageWindows)
    : usageWindows;
  const analyticsWindowDisplays = getWindowDisplays(displayWindows);
  const onDemandUsed = localMode
    ? cloudPlan?.overageAccumulatedUsd ?? 0
    : effectiveBalance?.overageAccumulatedUsd ?? 0;
  const onDemandLimit = localMode
    ? cloudPlan?.overageHardLimitUsd ?? null
    : effectiveBalance?.overageHardLimitUsd ?? null;
  const onDemandPct =
    onDemandLimit && onDemandLimit > 0
      ? Math.min(100, (onDemandUsed / onDemandLimit) * 100)
      : onDemandUsed > 0
      ? Math.min(100, (onDemandUsed / 1000) * 100)
      : 0;

  // ─── Summary cards ───────────────────────────────────────
  const totalSpend = spend.data?.totals.totalSpendUsd ?? 0;
  const includedSpend = spend.data?.totals.totalIncludedUsd ?? 0;
  const onDemandSpend = spend.data?.totals.totalOnDemandUsd ?? 0;

  // The tab and the download describe one workspace: while a paired computer's
  // workspace is open, both come from that machine (SHO-108/SHO-91).
  const csvUrl = useUsageLogCsvUrl(workspaceId, { period });
  const handleExportCsv = () => {
    if (typeof window !== "undefined") {
      window.open(csvUrl, "_blank", "noopener");
    } else {
      Linking.openURL(csvUrl);
    }
  };

  return (
    <View className="gap-6">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Usage</Text>
        <Text className="text-xs text-muted-foreground">
          {localMode
            ? "Token usage and agent activity for this workspace"
            : "Usage metrics and spend for this workspace"}
        </Text>
      </View>

      {/* Date range pills: one period drives every section below */}
      <View className="flex-row items-center justify-between flex-wrap gap-3">
        <DateRangePills value={period} onChange={setPeriod} />
      </View>

      <LoadErrorNotice errors={loadErrors} />

      <Section
        title="Plan & limits"
        subtitle="Rolling usage windows and on-demand spend for this workspace."
        testID="usage-section-plan"
      >
        <View className="flex-row flex-wrap gap-3">
          {(["fiveHour", "weekly"] as const).map((key) => {
            const w = displayWindows?.[key];
            const label = key === "fiveHour" ? "5-hour usage" : "Weekly usage";
            const { pct, uncapped, countdown } = analyticsWindowDisplays[key];
            return (
              <BillingProgressCard
                key={key}
                title={label}
                current={!w ? "—" : uncapped ? "Unlimited" : `${pct}%`}
                total={null}
                percent={uncapped ? 0 : pct}
                tone={
                  pct >= 100 ? "destructive" : pct >= 90 ? "warning" : "primary"
                }
                helper={
                  uncapped
                    ? "Unlimited — no usage window"
                    : countdown
                    ? pct >= 100
                      ? `Limit reached — resets in ${countdown}`
                      : `Resets in ${countdown}`
                    : "Window not started"
                }
              />
            );
          })}
          <BillingProgressCard
            title="On-Demand Usage (Team)"
            current={fmtUsd(onDemandUsed)}
            total={onDemandLimit != null ? fmtUsd(onDemandLimit) : null}
            percent={onDemandPct}
            tone={onDemandPct > 80 ? "warning" : "primary"}
            helper="Pay for extra usage beyond your plan limits."
            subHelper={
              onDemandLimit != null
                ? `${fmtUsd(onDemandLimit)} team spend cap`
                : "No spend cap set"
            }
            {...(Platform.OS !== "ios" &&
            (!localMode ||
              (cloudBilling.summary?.signedIn === true &&
                cloudBilling.summary.plan?.paidTier === true))
              ? {
                  actionLabel: "Set Limit",
                  onActionPress: () => setSpendLimitOpen(true),
                }
              : {})}
          />
        </View>
      </Section>

      <Section
        title="Spend"
        subtitle="What this workspace spent in the selected period."
        testID="usage-section-spend"
      >
        <View className="flex-row flex-wrap gap-2">
          <StatCard label="Total spend" value={fmtUsd(totalSpend)} icon={Coins} />
          <StatCard
            label="Included"
            value={fmtUsd(includedSpend)}
            icon={CreditCard}
          />
          <StatCard label="On-demand" value={fmtUsd(onDemandSpend)} icon={Zap} />
        </View>

        <UsageTimeseriesChart
          data={spend.data}
          loading={spend.loading}
          groupBy={groupBy}
          metric={metric}
          onGroupByChange={setGroupBy}
          onMetricChange={setMetric}
          isLocalMode={localMode}
          title="Team Usage"
          subtitle="Team usage per day across this billing period"
          groupByOptions={["model", "user", "source"]}
          showTotals={false}
        />
      </Section>

      <Section
        title="Usage"
        subtitle="Every billable event in the period, and who used the most."
        testID="usage-section-usage"
      >
        <View className="gap-2">
          <View className="flex-row items-center justify-end">
            <Pressable
              onPress={handleExportCsv}
              className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background active:bg-muted"
            >
              <Download size={14} className="text-foreground" />
              <Text className="text-xs font-medium text-foreground">
                Export CSV
              </Text>
            </Pressable>
          </View>
          <UsageTableSection
            summaryData={usageSummary.data}
            logData={usageLog.data}
            summaryLoading={usageSummary.loading}
            logLoading={usageLog.loading}
            onLogPageChange={setLogPage}
            logPage={logPage}
            isLocalMode={localMode}
          />
        </View>

        <UsageLeaderboard
          data={usageSummary.data}
          loading={usageSummary.loading}
        />
      </Section>

      {isBusinessOrHigher && (
        <Section
          title="Chat & agents"
          subtitle="Chat traffic and the models behind it."
          testID="usage-section-chat"
        >
          <ChatAnalyticsSection
            data={chatStats.data}
            loading={chatStats.loading}
          />
          <UsageBreakdownSection data={usage.data} loading={usage.loading} />
        </Section>
      )}

      {/* Who is doing what: team table + dashboard for admins, own stats for members */}
      {workspaceId ? (
        <Section
          title="Team"
          subtitle="Activity, streaks and work done per member."
          testID="usage-section-team"
        >
          <WorkspaceActivitySection
            workspaceId={workspaceId}
            isBusinessOrHigher={isBusinessOrHigher}
          />
        </Section>
      ) : null}

      {Platform.OS !== "ios" && (
        <SetSpendLimitDialog
          visible={spendLimitOpen}
          onClose={() => setSpendLimitOpen(false)}
          workspaceId={workspaceId}
          currentLimitUsd={onDemandLimit}
          accumulatedUsageUsd={onDemandUsed}
          onSave={localMode ? cloudBilling.setSpendingLimit : undefined}
          onSaved={() => {
            if (localMode) {
              void cloudBilling.refresh();
            } else {
              refetchUsageWallet();
            }
          }}
        />
      )}
    </View>
  );
}
