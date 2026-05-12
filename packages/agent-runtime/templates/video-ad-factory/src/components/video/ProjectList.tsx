import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Film, Layers } from "lucide-react";
import type { Project, ProjectStatus } from "./types";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  draft: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  scripting: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  generating: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  review: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  approved: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  live: "bg-green-500/20 text-green-300 border-green-500/30",
};

interface ProjectListProps {
  projects: Project[];
}

export function ProjectList({ projects }: ProjectListProps) {
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Film className="h-10 w-10 text-zinc-400 dark:text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          No projects yet. Ask me to script an ad and I'll create the first campaign.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {projects.map((project) => (
        <Card
          key={project.id}
          className="bg-white dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800"
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {project.name}
              </CardTitle>
              <Badge
                variant="outline"
                className={`text-[10px] uppercase tracking-wider ${STATUS_COLORS[project.status]}`}
              >
                {project.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
              <span>{project.product}</span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>{project.platform}</span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="flex items-center gap-1">
                <Layers className="h-3 w-3" />
                {project.assetCount} assets
              </span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>{project.totalCredits} credits</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
