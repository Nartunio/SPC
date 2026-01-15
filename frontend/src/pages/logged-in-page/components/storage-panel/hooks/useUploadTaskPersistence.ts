import { useCallback, useEffect } from "react";

import { UPLOAD_TASKS_STORAGE_KEY } from "../constants";
import type { UploadTask, UploadTaskStatus } from "../types";

type Params = {
  uploadTasks: UploadTask[];
  setUploadTasks: React.Dispatch<React.SetStateAction<UploadTask[]>>;

  uploadTasksRef: React.MutableRefObject<UploadTask[]>;
  uploadPersistTimerRef: React.MutableRefObject<number | null>;
  uploadLocalHydratedRef: React.MutableRefObject<boolean>;
};

export function useUploadTaskPersistence({
  uploadTasks,
  setUploadTasks,
  uploadTasksRef,
  uploadPersistTimerRef,
  uploadLocalHydratedRef,
}: Params) {
  const persistUploadTasks = useCallback(
    (tasks: UploadTask[], options?: { immediate?: boolean }) => {
      try {
        if (typeof window === "undefined") return;
        if (!tasks.length) {
          window.localStorage.removeItem(UPLOAD_TASKS_STORAGE_KEY);
          return;
        }

        const writeNow = () => {
          try {
            const trimmed = tasks
              .slice(0, 50)
              .map((t) => ({
                id: t.id,
                fileName: t.fileName,
                totalBytes: t.totalBytes,
                uploadedBytes: t.uploadedBytes,
                hashedBytes: t.hashedBytes,
                checksumStage: t.checksumStage,
                checksumChunkIndex: t.checksumChunkIndex,
                checksumChunksTotal: t.checksumChunksTotal,
                startedAt: t.startedAt,
                targetPath: t.targetPath,
                status: t.status,
                error: t.error,
                note: t.note,
                fileChecksum: t.fileChecksum,
                savedAt: Date.now(),
              }));

            window.localStorage.setItem(
              UPLOAD_TASKS_STORAGE_KEY,
              JSON.stringify({ v: 1, tasks: trimmed, savedAt: Date.now() })
            );
          } catch {
            // ignore storage errors
          }
        };

        if (options?.immediate) {
          if (uploadPersistTimerRef.current) {
            window.clearTimeout(uploadPersistTimerRef.current);
            uploadPersistTimerRef.current = null;
          }
          writeNow();
          return;
        }

        // Avoid writing very frequently during progress events.
        if (uploadPersistTimerRef.current) window.clearTimeout(uploadPersistTimerRef.current);
        uploadPersistTimerRef.current = window.setTimeout(writeNow, 200);
      } catch {
        // ignore
      }
    },
    [uploadPersistTimerRef]
  );

  useEffect(() => {
    return () => {
      if (uploadPersistTimerRef.current) {
        window.clearTimeout(uploadPersistTimerRef.current);
        uploadPersistTimerRef.current = null;
      }
    };
  }, [uploadPersistTimerRef]);

  // Local hydration: ensures uploads are still visible after reload even if the
  // page was refreshed during hashing (before the server knows about the upload).
  useEffect(() => {
    if (uploadLocalHydratedRef.current) return;
    uploadLocalHydratedRef.current = true;

    try {
      if (typeof window === "undefined") return;
      const raw = window.localStorage.getItem(UPLOAD_TASKS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const tasksRaw = Array.isArray(parsed) ? parsed : parsed?.tasks;
      if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return;

      const now = Date.now();
      const hydrated: UploadTask[] = tasksRaw
        .map((t: any): UploadTask | null => {
          const startedAt = typeof t?.startedAt === "number" ? t.startedAt : NaN;
          // Drop very old entries.
          if (!Number.isFinite(startedAt) || now - startedAt > 1000 * 60 * 60 * 24 * 7) return null;

          const status: UploadTaskStatus =
            t?.status === "error" ||
            t?.status === "paused" ||
            t?.status === "hashing" ||
            t?.status === "uploading" ||
            t?.status === "finalizing"
              ? t.status
              : "paused";

          const wasActive = status === "hashing" || status === "uploading";
          const hasServerHandle = Boolean(String(t?.fileChecksum || "").trim());
          const note =
            typeof t?.note === "string" && t.note
              ? t.note
              : status === "finalizing"
                ? "Finalizing on server. This can take a bit for large files."
                : wasActive
                ? hasServerHandle
                  ? "Interrupted by reload. Re-upload the same file to resume from uploaded chunks."
                  : "Interrupted by reload. Select the file again to restart upload."
                : undefined;

          return {
            id: String(t?.id || `rehydrated_local_${startedAt}`),
            fileName: String(t?.fileName || "Unknown file"),
            totalBytes: typeof t?.totalBytes === "number" ? t.totalBytes : 0,
            uploadedBytes: typeof t?.uploadedBytes === "number" ? t.uploadedBytes : 0,
            hashedBytes: typeof t?.hashedBytes === "number" ? t.hashedBytes : undefined,
            checksumStage: t?.checksumStage === "whole" || t?.checksumStage === "chunk" ? t.checksumStage : undefined,
            checksumChunkIndex: typeof t?.checksumChunkIndex === "number" ? t.checksumChunkIndex : undefined,
            checksumChunksTotal: typeof t?.checksumChunksTotal === "number" ? t.checksumChunksTotal : undefined,
            startedAt,
            targetPath: String(t?.targetPath || ""),
            // If we reloaded during hashing/uploading, we can only show a paused task.
            // But if we were in the finalizing phase, keep it finalizing to prevent
            // user from starting a duplicate finalize.
            status: status === "finalizing" ? "finalizing" : wasActive ? "paused" : status,
            error: typeof t?.error === "string" ? t.error : undefined,
            note,
            fileChecksum: typeof t?.fileChecksum === "string" ? t.fileChecksum : undefined,
          };
        })
        .filter(Boolean) as UploadTask[];

      if (!hydrated.length) return;
      setUploadTasks((prev) => {
        const existingChecksums = new Set(
          prev.map((t) => (t.fileChecksum ? t.fileChecksum.toLowerCase() : "")).filter(Boolean)
        );

        const next: UploadTask[] = [];
        for (const t of hydrated) {
          const checksum = (t.fileChecksum || "").toLowerCase();
          if (checksum && existingChecksums.has(checksum)) continue;
          next.push(t);
          if (checksum) existingChecksums.add(checksum);
        }
        return [...next, ...prev];
      });
    } catch {
      // ignore hydration errors
    }
  }, [setUploadTasks, uploadLocalHydratedRef]);

  useEffect(() => {
    uploadTasksRef.current = uploadTasks;
    // Persist immediately when tasks appear/disappear, so a fast refresh can't drop them.
    const immediate = uploadTasks.length <= 1;
    persistUploadTasks(uploadTasks, { immediate });
  }, [persistUploadTasks, uploadTasks, uploadTasksRef]);

  useEffect(() => {
    const handler = () => {
      persistUploadTasks(uploadTasksRef.current, { immediate: true });
    };
    try {
      window.addEventListener("beforeunload", handler);
      window.addEventListener("pagehide", handler);
    } catch {
      // ignore
    }
    return () => {
      try {
        window.removeEventListener("beforeunload", handler);
        window.removeEventListener("pagehide", handler);
      } catch {
        // ignore
      }
    };
  }, [persistUploadTasks, uploadTasksRef]);

  return { persistUploadTasks };
}
