import { useMemo } from "react";
import useSWR from "swr";
import type { VisibilityType } from "@/components/visibility-selector";

export function useChatVisibility({
  chatId,
  initialVisibilityType,
}: {
  chatId: string;
  initialVisibilityType: VisibilityType;
}) {
  const { data: localVisibility, mutate: setLocalVisibility } = useSWR(
    `${chatId}-visibility`,
    null,
    {
      fallbackData: initialVisibilityType,
    }
  );

  const visibilityType = useMemo(() => {
    return localVisibility || "private";
  }, [localVisibility]);

  const setVisibilityType = async (updatedVisibilityType: VisibilityType) => {
    setLocalVisibility(updatedVisibilityType);

    // Update on the server
    try {
      await fetch(`/api/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: updatedVisibilityType }),
      });
    } catch (error) {
      console.error("Failed to update chat visibility:", error);
    }
  };

  return { visibilityType, setVisibilityType };
}
