export type ProjectStatus = "draft" | "scripting" | "generating" | "review" | "approved" | "live";

export type AssetType = "video" | "image";

export type VideoModel = "seedance-2.0" | "sora-2" | "veo-3.1" | "kling-3.0" | "nano-banana";

export type QAStatus = "clean" | "needs-review" | "failed" | "pending";

export interface Project {
  id: string;
  name: string;
  product: string;
  platform: string;
  status: ProjectStatus;
  createdAt: string;
  assetCount: number;
  totalCredits: number;
}

export interface Asset {
  id: string;
  projectId: string;
  type: AssetType;
  model: VideoModel;
  prompt: string;
  thumbnailUrl?: string;
  duration?: number;
  creditCost: number;
  qaStatus: QAStatus;
  createdAt: string;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  avatarUrl?: string;
  style: string;
  usageCount: number;
  lastUsed?: string;
}

export interface CreditUsage {
  total: number;
  used: number;
  remaining: number;
  lastUpdated: string;
}
