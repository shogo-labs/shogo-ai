import { Card, CardContent } from "@/components/ui/card";
import { User, Sparkles } from "lucide-react";
import type { Character } from "./types";

interface CharacterGalleryProps {
  characters: Character[];
}

export function CharacterGallery({ characters }: CharacterGalleryProps) {
  if (characters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <User className="h-10 w-10 text-zinc-400 dark:text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          No AI characters yet. Ask me to create a character sheet and I'll generate your first influencer.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {characters.map((character) => (
        <Card
          key={character.id}
          className="bg-white dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 overflow-hidden"
        >
          <div className="aspect-square bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            {character.avatarUrl ? (
              <img
                src={character.avatarUrl}
                alt={character.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <User className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
            )}
          </div>
          <CardContent className="p-3">
            <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">
              {character.name}
            </h4>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2 mb-2">
              {character.description}
            </p>
            <div className="flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
              <span className="flex items-center gap-0.5">
                <Sparkles className="h-3 w-3" />
                {character.style}
              </span>
              <span>{character.usageCount} uses</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
