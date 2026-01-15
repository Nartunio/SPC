import { useCallback, useState } from "react";

import type { Toast } from "../types";

type Api = {
  move: (sourceKey: string, destFolder: string) => Promise<{ ok: boolean; data: any }>;
};

type PushToast = (variant: Toast["variant"], text: string, details?: string) => void;

type DraggedItem = { type: "file" | "folder"; key: string };

type UploadFiles = (files: File[], targetPath?: string) => void | Promise<void>;

type Refresh = (path?: string) => void | Promise<void>;

type Options = {
  api: Api;
  pushToast: PushToast;
  uploadFiles: UploadFiles;
  refresh: Refresh;
  currentPath: string;
};

export function useDragAndMove({ api, pushToast, uploadFiles, refresh, currentPath }: Options) {
  const [dragActive, setDragActive] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      setDragOverFolder(null);
      const files = Array.from(e.dataTransfer.files || []);
      void uploadFiles(files, currentPath || undefined);
    },
    [currentPath, uploadFiles]
  );

  const handleFolderDragOver = useCallback((e: React.DragEvent, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(folderName);
  }, []);

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
  }, []);

  const moveItem = useCallback(
    async (sourceKey: string, destFolder: string) => {
      try {
        const res = await api.move(sourceKey, destFolder);
        if (!res.ok) {
          const errorMsg = res.data?.details || res.data?.error || "Unknown error";
          console.error("Move error response:", res);

          let details: string | undefined;
          try {
            details = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null, null, 2);
          } catch {
            details = String(res.data);
          }

          pushToast("error", `Error moving item: ${errorMsg}`, details);
          return;
        }
        pushToast("success", "Item moved successfully");
        await refresh(currentPath);
      } catch (err) {
        console.error("Move error:", err);

        const details = err instanceof Error ? err.stack ?? err.message : String(err);
        pushToast(
          "error",
          `Move failed: ${err instanceof Error ? err.message : String(err)}`,
          details
        );
      }
    },
    [api, currentPath, pushToast, refresh]
  );

  const handleFolderDrop = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverFolder(null);

      // Check if dragging internal item or external files
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) {
        void uploadFiles(files, folderPath);
      } else if (draggedItem) {
        // Move internal item
        void moveItem(draggedItem.key, folderPath);
      }
    },
    [draggedItem, moveItem, uploadFiles]
  );

  const handleItemDragStart = useCallback(
    (e: React.DragEvent, itemType: "file" | "folder", key: string) => {
      e.stopPropagation();
      setDraggedItem({ type: itemType, key });
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleItemDragEnd = useCallback(() => {
    setDraggedItem(null);
  }, []);

  return {
    dragActive,
    dragOverFolder,
    draggedItem,

    handleDragOver,
    handleDragLeave,
    handleDrop,

    handleFolderDragOver,
    handleFolderDragLeave,
    handleFolderDrop,

    handleItemDragStart,
    handleItemDragEnd,

    moveItem,
  };
}
