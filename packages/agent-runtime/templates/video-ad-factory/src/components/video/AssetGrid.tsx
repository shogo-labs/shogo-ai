import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Film, Image, Clock, Coins } from "lucide-react";
import type { Asset, QAStatus, VideoModel } from "./types";

const QA_COLORS: Record<QAStatus, string> = {
  clean: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "needs-review": "bg-amber-500/20 text-amber-400 border-amber-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const MODEL_LABELS: Record<VideoModel, string> = {
  "seedance-2.0": "Seedance 2.0",
  "sora-2": "Sora 2",
  "veo-3.1": "Veo 3.1",
  "kling-3.0": "Kling 3.0",
  "nano-banana": "Nano Banana",
};

interface AssetGridProps {
  assets: Asset[];
}

export function AssetGrid({ assets }: AssetGridProps) {
  if (assets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Image className="h-10 w-10 text-zinc-400 dark:text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          No assets generated yet. Start a project and I'll render your first video here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {assets.map((asset) => (
        <Card
          key={asset.id}
          className="bg-white dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 overflow-hidden"
        >
          <div className="aspect-video bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center relative">
            {asset.thumbnailUrl ? (
              <img
                src={asset.thumbnailUrl}
                alt={asset.prompt}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-1 text-zinc-400 dark:text-zinc-600">
                {asset.type === "video" ? (
                  <Film className="h-8 w-8" />
                ) : (
                  <Image className="h-8 w-8" />
                )}
                <span className="text-[10px] uppercase tracking-wider">
                  {asset.type}
                </span>
              </div>
            )}
            <Badge
              variant="outline"
              className={`absolute top-2 right-2 text-[10px] ${QA_COLORS[asset.qaStatus]}`}
            >
              {asset.qaStatus}
            </Badge>
          </div>
          <CardContent className="p-3">
            <p className="text-xs text-zinc-600 dark:text-zinc-300 line-clamp-2 mb-2">
              {asset.prompt}
            </p>
            <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="font-mono">{MODEL_LABELS[asset.model]}</span>
              {asset.duration && (
                <span className="flex items-center gap-0.5">
                  <Clock className="h-3 w-3" />
                  {asset.duration}s
                </span>
              )}
              <span className="flex items-center gap-0.5">
                <Coins className="h-3 w-3" />
                {asset.creditCost}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
