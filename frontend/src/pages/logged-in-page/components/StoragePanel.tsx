import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { createSHA256 } from "hash-wasm";
import {
  ArrowLeft,
  Download,
  Folder,
  History,
  Loader2,
  Pencil,
  RefreshCcw,
  Share2,
  Trash2,
  UploadCloud,
  FolderPlus,
  Copy,
} from "lucide-react";
import { createApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type FileItem = {
  name: string;
  size?: number;
  last_modified?: string;
  created_at?: string | null;
  created_by_email?: string | null;
  etag?: string;
};

type DirectoryItem = {
  name: string;
  is_empty?: boolean;
  last_modified?: string | null;
  created_at?: string | null;
  created_by_email?: string | null;
};

type ListResponse = {
  prefix: string;
  path?: string;
  directories: DirectoryItem[];
  files: FileItem[];
};

type ShareVisibility = "private" | "public" | "protected";
type SharePermission = "read" | "read-write";
type ShareResult = {
  share_id: string;
  token: string;
  access_url?: string;
  visibility: ShareVisibility;
  target_sub?: string | null;
  target_email?: string | null;
  permission: SharePermission;
  expires_at?: string | null;
  allowed_emails?: string[];
  key: string;
};

type SharedWithMeShare = {
  share_id: string;
  owner_sub: string;
  owner_email?: string | null;
  key: string;
  is_directory: boolean;
  permission: SharePermission;
  expires_at?: string | null;
  target_email?: string | null;
  visibility?: ShareVisibility;
};

function formatBytes(size?: number) {
  if (!size && size !== 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[idx]}`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function StoragePanelLegacy() {
  const { getAccessTokenSilently, loginWithRedirect, getIdTokenClaims } = useAuth0();

  const getTokenWithRenew = useCallback(async () => {
    try {
      return await getAccessTokenSilently({
        authorizationParams: {
          audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
          scope: 'openid profile email offline_access',
        },
      });
    } catch (err: any) {
      const message = err?.message || '';
      const isMissingRefresh =
        message.includes('Missing Refresh Token') ||
        message.includes('login_required') ||
        message.includes('consent_required');

      if (isMissingRefresh) {
        // Force a full login to obtain a new refresh token
        await loginWithRedirect({
          authorizationParams: {
            redirect_uri: `${window.location.origin}/callback`,
            audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
            scope: 'openid profile email offline_access',
            prompt: 'login',
          },
        });
      }

      throw err;
    }
  }, [getAccessTokenSilently, loginWithRedirect]);

  const getIdTokenRaw = useCallback(async () => {
    try {
      return (await getIdTokenClaims())?.__raw;
    } catch {
      return undefined;
    }
  }, [getIdTokenClaims]);

  const api = useMemo(() => createApi(getTokenWithRenew, getIdTokenRaw), [getTokenWithRenew, getIdTokenRaw]);

  const [panelView, setPanelView] = useState<
    "storage" | "shared_to_me" | "my_shares" | "activity"
  >("storage");

  const [list, setList] = useState<ListResponse | null>(null);
  const listRef = useRef<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

  const UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1MB
  type UploadTaskStatus = "hashing" | "uploading" | "finalizing" | "paused" | "error";
  type UploadTask = {
    id: string;
    fileName: string;
    totalBytes: number;
    uploadedBytes: number;
    inflightBytes?: number;
    hashedBytes?: number;
    checksumStage?: "whole" | "chunk";
    checksumChunkIndex?: number; // 1-based
    checksumChunksTotal?: number;
    startedAt: number;
    targetPath: string;
    status: UploadTaskStatus;
    error?: string;
    note?: string;
    fileChecksum?: string;
  };

  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
  const uploadXhrRef = useRef<Map<string, Set<XMLHttpRequest>>>(new Map());
  const uploadHydratedRef = useRef(false);
  const uploadLocalHydratedRef = useRef(false);
  const uploadPersistTimerRef = useRef<number | null>(null);
  const uploadTasksRef = useRef<UploadTask[]>([]);
  const resumeUploadTaskIdRef = useRef<string | null>(null);
  const uploadFileRef = useRef<Map<string, File>>(new Map());
  const uploadChecksumCacheRef = useRef<
    Map<string, { fileChecksum?: string; chunkChecksums?: Array<string | undefined> }>
  >(new Map());
  const finalizePollRef = useRef<{ timer: number | null; tries: number }>({ timer: null, tries: 0 });
  const visibilityPollRef = useRef<{ timer: number | null; tries: number; expected: Set<string> }>(
    { timer: null, tries: 0, expected: new Set() }
  );
  const uploading = uploadTasks.some((t) => t.status === "hashing" || t.status === "uploading");

  const UPLOAD_TASKS_STORAGE_KEY = "spc_upload_tasks_v1";

  const persistUploadTasks = useCallback((tasks: UploadTask[], options?: { immediate?: boolean }) => {
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
  }, []);

  useEffect(() => {
    return () => {
      if (uploadPersistTimerRef.current) {
        window.clearTimeout(uploadPersistTimerRef.current);
        uploadPersistTimerRef.current = null;
      }
    };
  }, []);

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
            status: status === "finalizing" ? "finalizing" : (wasActive ? "paused" : status),
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
  }, []);

  useEffect(() => {
    uploadTasksRef.current = uploadTasks;
    // Persist immediately when tasks appear/disappear, so a fast refresh can't drop them.
    const immediate = uploadTasks.length <= 1;
    persistUploadTasks(uploadTasks, { immediate });
  }, [persistUploadTasks, uploadTasks]);

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
  }, [persistUploadTasks]);

  // Smooth UI counters/bars so they don't jump per chunk.
  const smoothProgressRef = useRef(
    new Map<string, { uploaded: number; hashed: number; ts: number }>()
  );
  const [, setSmoothTick] = useState(0);
  useEffect(() => {
    if (uploadTasks.length === 0) return;
    let raf = 0;

    const step = (now: number) => {
      let anyChange = false;

      const alphaFromDt = (dtMs: number) => {
        // ~150ms time constant for snappy but smooth updates.
        const a = 1 - Math.exp(-dtMs / 150);
        return Math.max(0.05, Math.min(0.35, a));
      };

      for (const task of uploadTasks) {
        const targetUploaded = (task.uploadedBytes || 0) + (task.inflightBytes || 0);
        const targetHashed = task.hashedBytes || 0;
        const existing = smoothProgressRef.current.get(task.id) || {
          uploaded: targetUploaded,
          hashed: targetHashed,
          ts: now,
        };

        const dt = Math.max(0, now - (existing.ts || now));
        const alpha = alphaFromDt(dt);
        const nextUploaded = existing.uploaded + (targetUploaded - existing.uploaded) * alpha;
        const nextHashed = existing.hashed + (targetHashed - existing.hashed) * alpha;

        if (
          Math.abs(nextUploaded - existing.uploaded) > 0.25 ||
          Math.abs(nextHashed - existing.hashed) > 0.25
        ) {
          anyChange = true;
        }

        smoothProgressRef.current.set(task.id, {
          uploaded: nextUploaded,
          hashed: nextHashed,
          ts: now,
        });
      }

      // Clean up removed tasks.
      const activeIds = new Set(uploadTasks.map((t) => t.id));
      for (const key of smoothProgressRef.current.keys()) {
        if (!activeIds.has(key)) smoothProgressRef.current.delete(key);
      }

      if (anyChange) {
        setSmoothTick((x) => (x + 1) % 1000000);
        raf = window.requestAnimationFrame(step);
      }
    };

    raf = window.requestAnimationFrame(step);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [uploadTasks]);

  const cancelUpload = useCallback(
    async (taskId: string, fileChecksum?: string) => {
      const controller = uploadAbortRef.current.get(taskId);
      if (controller) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
      uploadAbortRef.current.delete(taskId);

      const xhrs = uploadXhrRef.current.get(taskId);
      if (xhrs) {
        for (const xhr of xhrs) {
          try {
            xhr.abort();
          } catch {
            // ignore
          }
        }
      }
      uploadXhrRef.current.delete(taskId);

      uploadFileRef.current.delete(taskId);
      uploadChecksumCacheRef.current.delete(taskId);

      if (fileChecksum) {
        try {
          await api.chunked.abort(fileChecksum);
        } catch {
          // best effort
        }
      }
      setUploadTasks((prev) => prev.filter((t) => t.id !== taskId));
    },
    [api]
  );

  const pauseUpload = useCallback((taskId: string) => {
    const controller = uploadAbortRef.current.get(taskId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    uploadAbortRef.current.delete(taskId);

    const xhrs = uploadXhrRef.current.get(taskId);
    if (xhrs) {
      for (const xhr of xhrs) {
        try {
          xhr.abort();
        } catch {
          // ignore
        }
      }
    }
    uploadXhrRef.current.delete(taskId);

    setUploadTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: "paused",
              inflightBytes: 0,
              note: t.note || "Paused. Click Resume and re-select the same file to continue.",
            }
          : t
      )
    );
  }, []);

  useEffect(() => {
    if (panelView !== "storage") return;
    if (uploadHydratedRef.current) return;
    uploadHydratedRef.current = true;

    (async () => {
      try {
        const res = await api.chunked.unfinished();
        if (!res.ok) return;
        const uploads = (res.data as any)?.uploads;
        if (!Array.isArray(uploads) || uploads.length === 0) return;

        const hydrated: UploadTask[] = [];
        for (const u of uploads) {
          const fileChecksum = String(u?.file_checksum || "").toLowerCase();
          if (!fileChecksum) continue;
          const fileName = String(u?.filename || "Unknown file");
          const targetPath = String(u?.path || "");
          const chunkSize = typeof u?.chunk_size === "number" ? u.chunk_size : UPLOAD_CHUNK_SIZE;
          const chunksTotal = typeof u?.chunks_total === "number" ? u.chunks_total : 0;
          const totalBytes =
            typeof u?.total_size === "number"
              ? u.total_size
              : chunksTotal > 0
                ? chunksTotal * chunkSize
                : 0;
          const uploadedBytes = typeof u?.uploaded_bytes === "number" ? u.uploaded_bytes : 0;
          const startedAtIso = String(u?.started_at || u?.updated_at || "");
          const startedAt = Date.parse(startedAtIso);

          hydrated.push({
            id: `rehydrated_${fileChecksum}`,
            fileName,
            totalBytes,
            uploadedBytes,
            startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
            targetPath,
            status: "paused",
            fileChecksum,
          });
        }

        if (hydrated.length === 0) return;
        setUploadTasks((prev) => {
          const existing = new Set(
            prev.map((t) => (t.fileChecksum ? t.fileChecksum.toLowerCase() : "")).filter(Boolean)
          );
          const deduped = hydrated.filter((t) => !existing.has((t.fileChecksum || "").toLowerCase()));
          return [...deduped, ...prev];
        });
      } catch {
        // ignore hydration errors
      }
    })();
  }, [api, panelView]);

  const uploadOneChunked = useCallback(
    async (
      file: File,
      targetPath?: string,
      options?: {
        taskId?: string;
        reuseExisting?: boolean;
        startedAt?: number;
        expectedFileChecksum?: string;
        verifySelectedFile?: boolean;
        uploadFileName?: string;
      }
    ) => {
      const id =
        options?.taskId ||
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `u_${Date.now()}_${Math.random().toString(16).slice(2)}`);

      const startedAt = typeof options?.startedAt === "number" ? options.startedAt : Date.now();
      const target = targetPath || "";
      const controller = new AbortController();
      uploadAbortRef.current.set(id, controller);

      // Keep a reference to the file so we can resume within the same tab session
      // without forcing a re-select.
      uploadFileRef.current.set(id, file);

      if (options?.reuseExisting) {
        setUploadTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === id);
          if (idx === -1) {
            return [
              {
                id,
                fileName: file.name,
                totalBytes: file.size || 0,
                uploadedBytes: 0,
                inflightBytes: 0,
                hashedBytes: 0,
                checksumStage: "whole",
                startedAt,
                targetPath: target,
                status: "hashing",
                note: undefined,
                error: undefined,
                fileChecksum: undefined,
              },
              ...prev,
            ];
          }
          const next = [...prev];
          const existing = next[idx];
          const keepName = (existing.fileName || "").trim();
          next[idx] = {
            ...existing,
            // Keep the original name so resuming doesn't create a new destination
            // just because the local file name changed.
            fileName: keepName || file.name,
            totalBytes: file.size || 0,
            uploadedBytes: 0,
            inflightBytes: 0,
            // Preserve known checksum state; avoids unnecessary recomputation.
            hashedBytes: typeof existing.hashedBytes === "number" ? existing.hashedBytes : 0,
            checksumStage: existing.fileChecksum ? existing.checksumStage : "whole",
            checksumChunkIndex: undefined,
            checksumChunksTotal: undefined,
            startedAt,
            targetPath: target,
            status: "hashing",
            note: undefined,
            error: undefined,
            fileChecksum: existing.fileChecksum,
          };
          return next;
        });
      } else {
        setUploadTasks((prev) => [
          {
            id,
            fileName: file.name,
            totalBytes: file.size || 0,
            uploadedBytes: 0,
            inflightBytes: 0,
            hashedBytes: 0,
            checksumStage: "whole",
            startedAt,
            targetPath: target,
            status: "hashing",
          },
          ...prev,
        ]);
      }

      const signal = controller.signal;

      const uploadFileName =
        (typeof options?.uploadFileName === "string" && options.uploadFileName.trim())
          ? options.uploadFileName
          : (uploadTasksRef.current.find((t) => t.id === id)?.fileName || file.name);

      // 1) Compute whole-file SHA-256 first (single pass).
      const total = file.size || 0;
      const expected = options?.expectedFileChecksum
        ? String(options.expectedFileChecksum).toLowerCase()
        : undefined;

      const mustVerifySelectedFile = Boolean(options?.verifySelectedFile && expected);

      const existingTask = uploadTasksRef.current.find((t) => t.id === id);
      const cached = uploadChecksumCacheRef.current.get(id);
      const cachedFileChecksum =
        (existingTask?.fileChecksum && existingTask.totalBytes === total
          ? existingTask.fileChecksum
          : undefined) ||
        (cached?.fileChecksum ? cached.fileChecksum : undefined);

      let fileChecksum: string;

      const computeWholeFileChecksum = async () => {
        const fileHasher = await createSHA256();
        fileHasher.init();

        let hashedSoFar = 0;
        let lastProgressAt = 0;
        for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_SIZE) {
          if (signal.aborted) throw new Error("aborted");
          const end = Math.min(total, offset + UPLOAD_CHUNK_SIZE);
          const blob = file.slice(offset, end);
          const buf = await blob.arrayBuffer();
          fileHasher.update(new Uint8Array(buf));

          hashedSoFar = end;
          const now = Date.now();
          if (now - lastProgressAt > 120 || end === total) {
            lastProgressAt = now;
            const progressValue = hashedSoFar;
            setUploadTasks((prev) =>
              prev.map((t) => (t.id === id ? { ...t, hashedBytes: progressValue } : t))
            );
          }
        }
        return String(fileHasher.digest()).toLowerCase();
      };

      if (mustVerifySelectedFile) {
        // For resume via file-picker, we must ensure the selected file matches the original.
        fileChecksum = await computeWholeFileChecksum();
        if (fileChecksum !== expected) {
          uploadAbortRef.current.delete(id);
          uploadFileRef.current.delete(id);
          uploadChecksumCacheRef.current.delete(id);

          setUploadTasks((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status: "error",
                    error: "Selected file does not match the original upload.",
                    note: "Pick the exact same file to resume this upload.",
                    inflightBytes: 0,
                  }
                : t
            )
          );
          throw new Error("resume_checksum_mismatch");
        }
        uploadChecksumCacheRef.current.set(id, {
          fileChecksum,
          chunkChecksums: uploadChecksumCacheRef.current.get(id)?.chunkChecksums,
        });
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t
          )
        );
      } else if (cachedFileChecksum) {
        fileChecksum = String(cachedFileChecksum).toLowerCase();
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t
          )
        );
      } else {
        fileChecksum = await computeWholeFileChecksum();
        uploadChecksumCacheRef.current.set(id, {
          fileChecksum,
          chunkChecksums: uploadChecksumCacheRef.current.get(id)?.chunkChecksums,
        });
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t
          )
        );
      }

      // 2) Upload the whole-file checksum first (initiate); server returns present staged chunks.
      const initRes = await api.chunked.initiate({
        filename: uploadFileName,
        file_checksum: fileChecksum,
        chunk_size: UPLOAD_CHUNK_SIZE,
        total_size: file.size,
        path: target || undefined,
      }, { signal });
      if (!initRes.ok) {
        const details =
          typeof initRes.data === "string"
            ? initRes.data
            : JSON.stringify(initRes.data ?? null);
        throw new Error(details);
      }

      const present = new Set<string>(((initRes.data as any)?.present || []) as string[]);

      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: "uploading", uploadedBytes: 0, checksumStage: "chunk", checksumChunkIndex: 0, checksumChunksTotal: Math.ceil(total / UPLOAD_CHUNK_SIZE) }
            : t
        )
      );

      // 3) Compute chunk checksums sequentially and upload as we go.
      // Start uploading chunk 1 while hashing remaining chunks.
      const totalChunks = Math.ceil(total / UPLOAD_CHUNK_SIZE);
      const cacheEntry = uploadChecksumCacheRef.current.get(id);
      const cachedChunkChecksums =
        cacheEntry?.fileChecksum === fileChecksum &&
        Array.isArray(cacheEntry?.chunkChecksums) &&
        cacheEntry!.chunkChecksums!.length === totalChunks
          ? cacheEntry!.chunkChecksums!
          : undefined;

      const chunkChecksums: Array<string | undefined> = new Array(totalChunks);
      if (cachedChunkChecksums) {
        for (let i = 0; i < totalChunks; i += 1) {
          const v = cachedChunkChecksums[i];
          if (typeof v === "string" && v) chunkChecksums[i] = v;
        }
      }

      // Keep cache wired to the array we mutate.
      uploadChecksumCacheRef.current.set(id, {
        fileChecksum,
        chunkChecksums,
      });

      const MAX_CONCURRENT_CHUNK_UPLOADS = 2;

      const computeChunkChecksum = async (index: number) => {
        const start = index * UPLOAD_CHUNK_SIZE;
        const end = Math.min(total, start + UPLOAD_CHUNK_SIZE);
        const blob = file.slice(start, end);
        const buf = await blob.arrayBuffer();
        const chunkHasher = await createSHA256();
        chunkHasher.init();
        chunkHasher.update(new Uint8Array(buf));
        const checksum = String(chunkHasher.digest()).toLowerCase();
        return { index, checksum };
      };

      const storageBase = String((import.meta as any).env.VITE_API_BASE || "http://localhost:8000")
        .replace(/\/$/, "")
        + "/storage";

      const inflightProgress = new Map<string, number>();
      let lastInflightUpdateAt = 0;
      const updateInflightBytes = (force = false) => {
        const now = Date.now();
        if (!force && now - lastInflightUpdateAt < 60) return;
        lastInflightUpdateAt = now;
        let sum = 0;
        for (const v of inflightProgress.values()) sum += v;
        setUploadTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, inflightBytes: sum } : t))
        );
      };

      const uploadChunkWithProgress = async (chunk: { checksum: string; blob: Blob; size: number }) => {
        const token = await getTokenWithRenew();
        let idToken: string | undefined;
        try {
          idToken = await getIdTokenRaw();
        } catch {
          idToken = undefined;
        }

        const doOnce = () =>
          new Promise<{ ok: boolean; status: number; data: any }>((resolve, reject) => {
            const form = new FormData();
            form.set("file_checksum", fileChecksum);
            form.set("chunk_checksum", chunk.checksum);
            form.set("chunk", chunk.blob);

            const xhr = new XMLHttpRequest();
            const set = uploadXhrRef.current.get(id) || new Set<XMLHttpRequest>();
            set.add(xhr);
            uploadXhrRef.current.set(id, set);

            inflightProgress.set(chunk.checksum, 0);
            updateInflightBytes(true);

            xhr.upload.onprogress = (ev) => {
              if (typeof ev.loaded === "number") {
                inflightProgress.set(chunk.checksum, Math.max(0, Math.min(ev.loaded, chunk.size)));
                updateInflightBytes(false);
              }
            };

            xhr.onload = () => {
              set.delete(xhr);
              uploadXhrRef.current.set(id, set);

              inflightProgress.delete(chunk.checksum);
              updateInflightBytes(true);

              let parsed: any = null;
              try {
                parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
              } catch {
                parsed = xhr.responseText;
              }
              resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: parsed });
            };
            xhr.onerror = () => {
              set.delete(xhr);
              uploadXhrRef.current.set(id, set);
              inflightProgress.delete(chunk.checksum);
              updateInflightBytes(true);
              reject(new Error("network_error"));
            };
            xhr.onabort = () => {
              set.delete(xhr);
              uploadXhrRef.current.set(id, set);
              inflightProgress.delete(chunk.checksum);
              updateInflightBytes(true);
              reject(new Error("aborted"));
            };

            xhr.open("POST", `${storageBase}/chunked/upload-chunk`, true);
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            if (idToken) xhr.setRequestHeader("X-Auth0-Id-Token", idToken);
            xhr.send(form);
          });

        let attempt = 0;
        while (attempt < 4) {
          if (signal.aborted) throw new Error("aborted");
          attempt += 1;
          const res = await doOnce();
          if (res.ok) {
            present.add(chunk.checksum);
            setUploadTasks((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, uploadedBytes: (t.uploadedBytes || 0) + chunk.size } : t
              )
            );
            return;
          }

          const errObj = res.data as any;
          const errCode = errObj?.error || "unknown";
          const errText = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null);
          if (attempt < 4 && (errCode === "chunk_checksum_mismatch" || res.status >= 500)) {
            await new Promise((r) => setTimeout(r, 150 * attempt));
            continue;
          }
          throw new Error(errText);
        }
        throw new Error("upload_failed");
      };

      // Publish a per-index "ready" promise so uploaders can wait for checksums
      // without coupling checksum progress to upload speed.
      const checksumReadyResolvers: Array<(() => void) | null> = new Array(totalChunks).fill(null);
      const checksumReadyPromises: Array<Promise<void>> = Array.from({ length: totalChunks }, (_, i) =>
        new Promise<void>((resolve) => {
          checksumReadyResolvers[i] = resolve;
        })
      );

      // Mark already-known checksums as ready (no need to re-hash).
      let computedCount = 0;
      for (let i = 0; i < totalChunks; i += 1) {
        if (typeof chunkChecksums[i] === "string" && chunkChecksums[i]) {
          computedCount += 1;
          checksumReadyResolvers[i]?.();
          checksumReadyResolvers[i] = null;
        }
      }
      if (computedCount > 0) {
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  checksumStage: "chunk",
                  checksumChunkIndex: computedCount,
                  checksumChunksTotal: totalChunks,
                }
              : t
          )
        );
      }

      const producer = (async () => {
        for (let i = 0; i < totalChunks; i += 1) {
          if (signal.aborted) throw new Error("aborted");
          if (typeof chunkChecksums[i] === "string" && chunkChecksums[i]) continue;
          const { index, checksum } = await computeChunkChecksum(i);
          chunkChecksums[index] = checksum;
          checksumReadyResolvers[index]?.();
          checksumReadyResolvers[index] = null;

          // Indicate how many chunk checksums are computed (independent of upload).
          computedCount += 1;
          setUploadTasks((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, checksumStage: "chunk", checksumChunkIndex: computedCount, checksumChunksTotal: totalChunks }
                : t
            )
          );
        }
      })();

      let nextUploadIndex = 0;
      const takeIndex = () => {
        if (nextUploadIndex >= totalChunks) return null;
        const idx = nextUploadIndex;
        nextUploadIndex += 1;
        return idx;
      };

      const worker = async () => {
        while (true) {
          if (signal.aborted) throw new Error("aborted");
          const idx = takeIndex();
          if (idx === null) return;

          await checksumReadyPromises[idx];
          const checksum = chunkChecksums[idx];
          if (!checksum) throw new Error("missing_chunk_checksum");

          const start = idx * UPLOAD_CHUNK_SIZE;
          const end = Math.min(total, start + UPLOAD_CHUNK_SIZE);
          const size = end - start;

          if (present.has(checksum)) {
            setUploadTasks((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, uploadedBytes: (t.uploadedBytes || 0) + size } : t
              )
            );
            continue;
          }

          const blob = file.slice(start, end);
          await uploadChunkWithProgress({ checksum, blob, size });
        }
      };

      await Promise.all([
        producer,
        ...Array.from({ length: MAX_CONCURRENT_CHUNK_UPLOADS }, () => worker()),
      ]);

      // At this point, all chunks are staged. The server still needs time to
      // assemble them into the final object.
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "finalizing",
                inflightBytes: 0,
                note: "Finalizing on server. This can take a bit for large files.",
              }
            : t
        )
      );

      // 4) Complete/assemble on server.
      const completeRes = await api.chunked.complete({
        filename: uploadFileName,
        file_checksum: fileChecksum,
        chunk_checksums: chunkChecksums.filter(Boolean) as string[],
        total_size: file.size,
        path: target || undefined,
      }, { signal });
      if (!completeRes.ok) {
        const details =
          typeof completeRes.data === "string"
            ? completeRes.data
            : JSON.stringify(completeRes.data ?? null);
        throw new Error(details);
      }

      uploadAbortRef.current.delete(id);
      uploadFileRef.current.delete(id);
      uploadChecksumCacheRef.current.delete(id);
      setUploadTasks((prev) => prev.filter((t) => t.id !== id));
    },
    [api]
  );

  type Toast = {
    id: string;
    variant: "error" | "success";
    text: string;
    details?: string;
    createdAt: number;
  };
  const TOAST_MS = 7000;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (variant: Toast["variant"], text: string, details?: string) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;

      const toast: Toast = {
        id,
        variant,
        text,
        details,
        createdAt: Date.now(),
      };

      setToasts((prev) => [toast, ...prev]);

      const timer = window.setTimeout(() => {
        dismissToast(id);
      }, TOAST_MS);
      toastTimersRef.current.set(id, timer);
    },
    [dismissToast]
  );

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const [currentPath, setCurrentPath] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<{
    type: "file" | "folder";
    key: string;
  } | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);

  type LogLimitMode = "50" | "100" | "200" | "dynamic";
  const LOG_DYNAMIC_PAGE_SIZE = 50;
  const [logLimitMode, setLogLimitMode] = useState<LogLimitMode>("dynamic");
  const [logActionFilter, setLogActionFilter] = useState<string>("");
  const [logFromDate, setLogFromDate] = useState<string>("");
  const [logToDate, setLogToDate] = useState<string>("");
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const logsScrollRef = useRef<HTMLDivElement | null>(null);
  const logsSentinelRef = useRef<HTMLDivElement | null>(null);
  const logsMetaRef = useRef<{ length: number; loading: boolean; hasMore: boolean }>({
    length: 0,
    loading: false,
    hasMore: false,
  });

  useEffect(() => {
    logsMetaRef.current.length = logs.length;
    logsMetaRef.current.loading = logsLoading;
    logsMetaRef.current.hasMore = logsHasMore;
  }, [logs.length, logsHasMore, logsLoading]);

  const logActionOptions = useMemo(() => {
    const base = [
      "list",
      "upload",
      "create_dir",
      "move",
      "move_prefix",
      "move_prefix_partial",
      "delete",
      "delete_prefix",
      "download_link",
      "download_folder_zip",
      "restore_version",
      "share_create",
      "share_update",
      "share_revoke",
      "share_access_allowed",
      "share_access_denied",
      "share_download_intent",
    ];
    const seen = new Set<string>(base);
    for (const l of logs) {
      const a = String((l as any)?.action || "").trim();
      if (a) seen.add(a);
    }
    return Array.from(seen).sort();
  }, [logs]);

  const [sharedToMe, setSharedToMe] = useState<SharedWithMeShare[] | null>(null);
  const [sharedToMeLoading, setSharedToMeLoading] = useState(false);

  const [mySharesList, setMySharesList] = useState<ShareResult[] | null>(null);
  const [mySharesLoading, setMySharesLoading] = useState(false);

  const [shareState, setShareState] = useState<{
    key: string;
    isDir: boolean;
    visibility: ShareVisibility;
    permission: SharePermission;
    targetEmail: string;
    allowedEmails: string;
    expiresIn: string;
    result?: ShareResult | null;
  } | null>(null);
  const [shareLoading, setShareLoading] = useState(false);

  const [ownedShares, setOwnedShares] = useState<Record<string, ShareResult>>({});

  useEffect(() => {
    if (!shareState) return;
    if (shareState.visibility !== "private" && shareState.permission !== "read") {
      setShareState({ ...shareState, permission: "read" });
    }
  }, [shareState?.visibility]);

  
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingKey && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingKey]);

  const joinedPath = useCallback(
    (name: string) => {
      const clean = name.replace(/(^\/+|\/+?$)/g, "");
      return currentPath ? `${currentPath}/${clean}` : clean;
    },
    [currentPath]
  );

  const fullKey = useCallback(
    (name: string, isDir = false) => {
      const path = joinedPath(name);
      return isDir ? `${path}/` : path;
    },
    [joinedPath]
  );

  const baseNameFromKey = useCallback((key: string) => {
    return key.replace(/\/$/, "").split("/").pop() || "";
  }, []);

  const parentPathFromKey = useCallback((key: string) => {
    const parts = key.replace(/\/$/, "").split("/");
    parts.pop();
    return parts.join("/");
  }, []);

  const computeUniqueFolderName = useCallback(() => {
    const base = "New folder";
    if (!list) return base;
    const existing = new Set([
      ...(list.directories || []).map((d) => d.name),
      ...(list.files || []).map((f) => f.name),
    ]);
    if (!existing.has(base)) return base;
    let idx = 1;
    while (existing.has(`${base} ${idx}`)) idx += 1;
    return `${base} ${idx}`;
  }, [list]);

  const startRename = useCallback((key: string, name: string) => {
    setEditingKey(key);
    setEditingValue(name);
  }, []);

  const refresh = useCallback(
    async (path?: string) => {
      setLoading(true);
      const [res, shareRes] = await Promise.all([api.list(path || undefined), api.listOwnedShares(path || undefined)]);
      setLoading(false);
      if (!res.ok) {
        pushToast("error", JSON.stringify(res.data));
        return;
      }
      setList(res.data as ListResponse);
      listRef.current = res.data as ListResponse;
      if (shareRes.ok) {
        const map: Record<string, ShareResult> = {};
        ((shareRes.data as any).shares || []).forEach((s: ShareResult) => {
          map[s.key] = s;
        });
        setOwnedShares(map);
      }
    },
    [api, pushToast]
  );

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  // While a task is finalizing, poll the server for unfinished manifests.
  // Once the manifest disappears, the server has cleaned up staged chunks and the
  // file should be available (or about to show up). This prevents duplicate resumes.
  useEffect(() => {
    const hasFinalizing = uploadTasks.some((t) => t.status === "finalizing" && t.fileChecksum);
    if (!hasFinalizing) {
      if (finalizePollRef.current.timer) {
        window.clearInterval(finalizePollRef.current.timer);
        finalizePollRef.current.timer = null;
      }
      finalizePollRef.current.tries = 0;
      return;
    }

    if (finalizePollRef.current.timer) return;
    finalizePollRef.current.tries = 0;

    finalizePollRef.current.timer = window.setInterval(async () => {
      try {
        finalizePollRef.current.tries += 1;
        const res = await api.chunked.unfinished();
        if (!res.ok) return;
        const uploads = (res.data as any)?.uploads;
        const active = new Set(
          (Array.isArray(uploads) ? uploads : [])
            .map((u: any) => String(u?.file_checksum || "").toLowerCase())
            .filter(Boolean)
        );

        const completedChecksums: string[] = [];
        for (const t of uploadTasksRef.current) {
          if (t.status === "finalizing" && t.fileChecksum) {
            const chk = String(t.fileChecksum).toLowerCase();
            if (chk && !active.has(chk)) completedChecksums.push(chk);
          }
        }

        if (completedChecksums.length) {
          const expectedNames = new Set<string>();
          // For eventual-consistency S3 list behavior (e.g. Hetzner), keep refreshing
          // the current folder briefly until the new object shows up.
          for (const t of uploadTasksRef.current) {
            if (t.status === "finalizing" && t.fileChecksum) {
              const chk = String(t.fileChecksum).toLowerCase();
              if (chk && completedChecksums.includes(chk)) {
                if ((t.targetPath || "") === (currentPath || "")) {
                  const name = (t.fileName || "").trim();
                  if (name) expectedNames.add(name);
                }
              }
            }
          }

          setUploadTasks((prev) =>
            prev.filter(
              (t) =>
                !(
                  t.status === "finalizing" &&
                  t.fileChecksum &&
                  completedChecksums.includes(String(t.fileChecksum).toLowerCase())
                )
            )
          );
          // Nudge the UI to refresh the current folder so the file appears.
          if (panelView === "storage") {
            refresh(currentPath);
          }

          if (expectedNames.size > 0) {
            // Start (or extend) a short-lived visibility poll.
            for (const n of expectedNames) visibilityPollRef.current.expected.add(n);
            if (!visibilityPollRef.current.timer) {
              visibilityPollRef.current.tries = 0;
              visibilityPollRef.current.timer = window.setInterval(() => {
                try {
                  visibilityPollRef.current.tries += 1;
                  const snapshot = listRef.current;
                  const visible = new Set(
                    (snapshot?.files || []).map((f) => String(f?.name || "")).filter(Boolean)
                  );

                  for (const name of Array.from(visibilityPollRef.current.expected)) {
                    if (visible.has(name)) visibilityPollRef.current.expected.delete(name);
                  }

                  if (visibilityPollRef.current.expected.size === 0 || visibilityPollRef.current.tries >= 10) {
                    if (visibilityPollRef.current.timer) {
                      window.clearInterval(visibilityPollRef.current.timer);
                      visibilityPollRef.current.timer = null;
                    }
                    visibilityPollRef.current.expected.clear();
                    return;
                  }

                  // Refresh the current folder again.
                  if (panelView === "storage") {
                    refresh(currentPath);
                  }
                } catch {
                  // ignore
                }
              }, 2000);
            }
          }
        }

        // Stop polling after ~1 minute to avoid background churn.
        if (finalizePollRef.current.tries >= 30) {
          if (finalizePollRef.current.timer) {
            window.clearInterval(finalizePollRef.current.timer);
            finalizePollRef.current.timer = null;
          }
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => {
      if (finalizePollRef.current.timer) {
        window.clearInterval(finalizePollRef.current.timer);
        finalizePollRef.current.timer = null;
      }

      if (visibilityPollRef.current.timer) {
        window.clearInterval(visibilityPollRef.current.timer);
        visibilityPollRef.current.timer = null;
      }
      visibilityPollRef.current.expected.clear();
    };
  }, [api, currentPath, panelView, refresh, uploadTasks]);

  const commitRename = useCallback(
    async (key: string) => {
      const newName = editingValue.trim();
      const currentName = baseNameFromKey(key);

      if (!newName) {
        pushToast("error", "Name cannot be empty");
        return;
      }

      if (newName === currentName) {
        setEditingKey(null);
        setEditingValue("");
        return;
      }

      const parent = parentPathFromKey(key);
      const res = await api.rename(key, parent, newName);
      if (!res.ok) {
        pushToast("error", JSON.stringify(res.data));
        return;
      }

      pushToast("success", `Renamed to ${newName}`);
      setEditingKey(null);
      setEditingValue("");
      refresh(currentPath);
    },
    [api, baseNameFromKey, currentPath, editingValue, parentPathFromKey, pushToast, refresh]
  );

  useEffect(() => {
    if (panelView !== "storage") return;
    setList(null); // Clear list immediately when path changes
    refresh(currentPath);
  }, [currentPath, refresh, panelView]);

  const refreshSharedToMe = useCallback(async () => {
    setSharedToMeLoading(true);
    const res = await api.listShared();
    setSharedToMeLoading(false);
    if (!res.ok) {
      pushToast("error", "Failed to load shared items", JSON.stringify(res.data));
      return;
    }
    setSharedToMe(((res.data as any)?.shares || []) as SharedWithMeShare[]);
  }, [api, pushToast]);

  const refreshMyShares = useCallback(async () => {
    setMySharesLoading(true);
    const res = await api.listOwnedShares();
    setMySharesLoading(false);
    if (!res.ok) {
      pushToast("error", "Failed to load your shares", JSON.stringify(res.data));
      return;
    }
    setMySharesList(((res.data as any)?.shares || []) as ShareResult[]);
  }, [api, pushToast]);

  useEffect(() => {
    if (panelView === "shared_to_me") {
      setSharedToMe(null);
      refreshSharedToMe();
    }
    if (panelView === "my_shares") {
      setMySharesList(null);
      refreshMyShares();
    }
  }, [panelView, refreshMyShares, refreshSharedToMe]);

  async function uploadFiles(files: File[], targetPath?: string) {
    if (!files.length) return;
    let successCount = 0;
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024 * 1024) {
        pushToast("error", "File too large (max 2GB).", `File: ${f.name}`);
        return;
      }

      try {
        await uploadOneChunked(f, targetPath || currentPath || undefined);
        successCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Intentional aborts (pause/cancel) shouldn't be treated as failures.
        if (msg === "aborted") {
          continue;
        }

        // Keep the failed task visible under "Unfinished uploads".
        pushToast("error", "Upload failed", msg);
        // Mark newest matching task as error if it still exists.
        setUploadTasks((prev) => {
          const idx = prev.findIndex((t) => t.fileName === f.name && t.status !== "error");
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], status: "error", error: msg };
          return next;
        });
      }
    }

    if (successCount > 0) {
      pushToast(
        "success",
        `Uploaded ${successCount} file${successCount > 1 ? "s" : ""}.`
      );
    }
    if (fileRef.current) fileRef.current.value = "";
    refresh(currentPath);
  }

  async function onDelete(key: string) {
    if (!confirm(`Delete ${key}?`)) return;
    const res = await api.del(key);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    refresh(currentPath);
  }

  async function onDownload(key: string) {
    const res = await api.downloadLink(key);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    const url = (res.data as any).url;
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }

  async function onDownloadFolderZip(path: string) {
    const res = await api.downloadFolderZip(path);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    const blob = new Blob([res.data], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${path.split("/").pop() || "folder"}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function onShowVersions(key: string) {
    setSelectedKey(key);
    const res = await api.versions(key);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setVersions((res.data as any).versions || []);
  }

  async function onRestoreVersion(version: number) {
    if (!selectedKey) return;
    const res = await api.restoreVersion(selectedKey, version);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setVersions(null);
    setSelectedKey(null);
    refresh(currentPath);
  }

  const loadLogs = useCallback(
    async (options?: { reset?: boolean }) => {
      const reset = options?.reset ?? true;
      if (logsMetaRef.current.loading) return;

      // Guard immediately to avoid double-load from rapid events.
      logsMetaRef.current.loading = true;

      setLogsLoading(true);
      setLogsError(null);

      const mode = logLimitMode;
      const isDynamic = mode === "dynamic";
      const fixedLimit = mode === "50" ? 50 : mode === "100" ? 100 : 200;
      const offset = isDynamic && !reset ? logsMetaRef.current.length : 0;
      const requestLimit = isDynamic ? LOG_DYNAMIC_PAGE_SIZE + 1 : fixedLimit;

      const res = await api.logs(
        requestLimit,
        offset,
        logActionFilter || undefined,
        logFromDate || undefined,
        logToDate || undefined
      );
      setLogsLoading(false);
      logsMetaRef.current.loading = false;

      if (!res.ok) {
        const msg = "Failed to load activity log";
        setLogsError(msg);
        pushToast("error", msg, JSON.stringify(res.data));
        return;
      }

      const raw = ((res.data as any).logs || []) as any[];

      if (isDynamic) {
        const hasMore = raw.length > LOG_DYNAMIC_PAGE_SIZE;
        const page = hasMore ? raw.slice(0, LOG_DYNAMIC_PAGE_SIZE) : raw;
        setLogs((prev) => (reset ? page : [...prev, ...page]));
        setLogsHasMore(hasMore);
      } else {
        setLogs(raw);
        setLogsHasMore(false);
      }
    },
    [LOG_DYNAMIC_PAGE_SIZE, api, logActionFilter, logFromDate, logLimitMode, logToDate, pushToast]
  );

  // Load activity log when Activity tab is active.
  useEffect(() => {
    if (panelView !== "activity") return;
    loadLogs({ reset: true });
  }, [loadLogs, panelView]);

  // Dynamic mode: load more as the user scrolls to the bottom.
  useEffect(() => {
    if (panelView !== "activity") return;
    if (logLimitMode !== "dynamic") return;
    if (!logsSentinelRef.current) return;

    const root = logsScrollRef.current;
    const sentinel = logsSentinelRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (logsMetaRef.current.loading) return;
        if (!logsMetaRef.current.hasMore) return;
        loadLogs({ reset: false });
      },
      { root, threshold: 0.5 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadLogs, logLimitMode, panelView]);

  const openShare = useCallback((key: string, isDir: boolean) => {
    const existing = ownedShares[key];
    setShareState({
      key,
      isDir,
      visibility: existing?.visibility || "private",
      permission: existing?.permission || "read",
      targetEmail: existing?.target_email || "",
      allowedEmails: (existing?.allowed_emails || []).join(", "),
      expiresIn: "",
      result: existing || null,
    });
  }, [ownedShares]);

  const openShareFromResult = useCallback((share: ShareResult) => {
    setOwnedShares((prev) => ({ ...prev, [share.key]: share }));
    setShareState({
      key: share.key,
      isDir: Boolean((share as any).is_directory),
      visibility: share.visibility || "private",
      permission: share.permission || "read",
      targetEmail: share.target_email || "",
      allowedEmails: (share.allowed_emails || []).join(", "),
      expiresIn: "",
      result: share,
    });
  }, []);

  const closeShare = useCallback(() => {
    setShareLoading(false);
    setShareState(null);
  }, []);

  async function submitShare() {
    if (!shareState) return;
    const wasExisting = Boolean(shareState.result);
    if (shareState.visibility === "private" && !shareState.targetEmail.trim()) {
      pushToast("error", "Target email is required for private shares");
      return;
    }
    if (shareState.visibility === "protected" && !shareState.allowedEmails.trim()) {
      pushToast("error", "Provide at least one allowed email for protected shares");
      return;
    }

    const expiresTrimmed = shareState.expiresIn.trim();
    let expiresNumber: number | undefined;
    if (expiresTrimmed) {
      const parsed = Number(expiresTrimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        pushToast("error", "Expiry must be a positive number of seconds");
        return;
      }
      expiresNumber = parsed;
    }

    const allowedEmails = shareState.allowedEmails
      .split(/[,\n]+/)
      .map((e) => e.trim())
      .filter(Boolean);

    const payload = {
      key: shareState.key,
      visibility: shareState.visibility,
      permission: shareState.permission,
      target_email:
        shareState.visibility === "private"
          ? shareState.targetEmail.trim() || undefined
          : undefined,
      allowed_emails:
        shareState.visibility === "protected" ? allowedEmails : undefined,
      expires_in: expiresNumber,
    } as any;

    setShareLoading(true);
    const res = await api.createShare(payload);
    setShareLoading(false);

    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }

    const result = res.data as ShareResult;
    setShareState((prev) => (prev ? { ...prev, result } : prev));
    setOwnedShares((prev) => ({ ...prev, [result.key]: result }));
    pushToast("success", wasExisting ? "Share updated" : "Share created");
  }

  async function revokeCurrentShare() {
    if (!shareState?.result?.share_id) {
      pushToast("error", "No share to revoke");
      return;
    }
    setShareLoading(true);
    const res = await api.revokeShare(shareState.result.share_id);
    setShareLoading(false);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setOwnedShares((prev) => {
      const next = { ...prev };
      delete next[shareState.key];
      return next;
    });
    setShareState((prev) => (prev ? { ...prev, result: null } : prev));
    pushToast("success", "Share revoked");
  }

  async function copyText(text: string, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", label);
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      pushToast("error", "Could not copy", details);
    }
  }

  const onNewFolder = useCallback(async () => {
    if (creatingDir) return;
    const name = computeUniqueFolderName();
    const targetPath = fullKey(name, true).replace(/\/$/, "");

    setCreatingDir(true);
    const res = await api.createDir(targetPath);
    setCreatingDir(false);

    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }

    await refresh(currentPath);
    const newKey = fullKey(name, true);
    setEditingKey(newKey);
    setEditingValue(name);
  }, [api, computeUniqueFolderName, creatingDir, fullKey, pushToast, refresh, currentPath]);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    setDragOverFolder(null);
    const files = Array.from(e.dataTransfer.files || []);
    uploadFiles(files, currentPath || undefined);
  }

  function handleFolderDragOver(e: React.DragEvent, folderName: string) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(folderName);
  }

  function handleFolderDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
  }

  function handleFolderDrop(e: React.DragEvent, folderPath: string) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);

    // Check if dragging internal item or external files
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      uploadFiles(files, folderPath);
    } else if (draggedItem) {
      // Move internal item
      moveItem(draggedItem.key, folderPath);
    }
  }

  function handleItemDragStart(
    e: React.DragEvent,
    itemType: "file" | "folder",
    key: string
  ) {
    e.stopPropagation();
    setDraggedItem({ type: itemType, key });
    e.dataTransfer.effectAllowed = "move";
  }

  function handleItemDragEnd() {
    setDraggedItem(null);
  }

  async function moveItem(sourceKey: string, destFolder: string) {
    try {
      const res = await api.move(sourceKey, destFolder);
      if (!res.ok) {
        const errorMsg =
          res.data?.details || res.data?.error || "Unknown error";
        console.error("Move error response:", res);

        let details: string | undefined;
        try {
          details =
            typeof res.data === "string"
              ? res.data
              : JSON.stringify(res.data ?? null, null, 2);
        } catch {
          details = String(res.data);
        }

        pushToast("error", `Error moving item: ${errorMsg}`, details);
        return;
      }
      pushToast("success", "Item moved successfully");
      refresh(currentPath);
    } catch (err) {
      console.error("Move error:", err);

      const details =
        err instanceof Error ? err.stack ?? err.message : String(err);
      pushToast(
        "error",
        `Move failed: ${err instanceof Error ? err.message : String(err)}`,
        details
      );
    }
  }

  const breadcrumbParts = currentPath
    ? currentPath.split("/").filter(Boolean)
    : [];

  const renderNameField = useCallback(
    (key: string, name: string) => {
      const isEditing = editingKey === key;
      const showInput = isEditing;

      if (showInput) {
        return (
          <input
            ref={isEditing ? editInputRef : null}
            value={isEditing ? editingValue : name}
            readOnly={!isEditing}
            onChange={
              isEditing ? (e) => setEditingValue(e.target.value) : undefined
            }
            onClick={(e) => {
              e.stopPropagation();
              if (!isEditing) startRename(key, name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename(key);
              } else if (e.key === "Escape") {
                setEditingKey(null);
                setEditingValue("");
              }
            }}
            onBlur={() => {
              if (isEditing) commitRename(key);
            }}
            className={`w-full min-w-0 bg-transparent text-sm font-medium leading-none h-6 flex items-center rounded border px-0 py-0 transition ${
              isEditing
                ? "border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                : "border-transparent"
            }`}
          />
        );
      }

      return (
        <p
          className="text-sm font-medium cursor-text h-6 flex items-center"
          onClick={(e) => {
            e.stopPropagation();
            startRename(key, name);
          }}
        >
          {name}
        </p>
      );
    },
    [commitRename, editingKey, editingValue, startRename]
  );

  const renderActivityLog = () => (
    <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Activity Log</p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Show</label>
          <select
            value={logLimitMode}
            onChange={(e) => setLogLimitMode(e.target.value as LogLimitMode)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Activity log limit"
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="dynamic">Dynamic</option>
          </select>
          <label className="ml-2 text-xs text-muted-foreground">Type</label>
          <select
            value={logActionFilter}
            onChange={(e) => setLogActionFilter(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Activity log type"
          >
            <option value="">All</option>
            {logActionOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <label className="ml-2 text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={logFromDate}
            onChange={(e) => setLogFromDate(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Activity log start date"
          />
          <label className="ml-2 text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={logToDate}
            onChange={(e) => setLogToDate(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Activity log end date"
          />
          <Button variant="ghost" size="sm" onClick={() => loadLogs({ reset: true })}>
            Refresh
          </Button>
        </div>
      </div>
      <div ref={logsScrollRef} className="max-h-64 overflow-y-auto space-y-1 text-sm">
        {logsLoading && logs.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!logsLoading && logsError && (
          <p className="text-sm text-muted-foreground">{logsError}</p>
        )}

        {!logsLoading && !logsError && logs.length === 0 && (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        )}

        {logs.map((l: any, idx: number) => {
          const extra = (l as any)?.extra || {};
          const isRename =
            !!extra?.rename &&
            typeof extra?.old_name === "string" &&
            typeof extra?.new_name === "string" &&
            extra.old_name !== extra.new_name;
          const fromPath = typeof extra?.from === "string" ? extra.from : "";
          const toPath = typeof extra?.to === "string" ? extra.to : "";
          const renameText = isRename
            ? `rename ${extra.old_name} -> ${extra.new_name}`
            : "";
          const moveText =
            !isRename && fromPath && toPath && fromPath !== toPath
              ? `move ${fromPath} -> ${toPath}`
              : "";

          return (
          <div
            key={`${l.created_at || ""}-${l.action || ""}-${l.key || ""}-${idx}`}
            className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/50"
          >
            <span className="text-xs text-muted-foreground">{l.created_at}</span>
            <span className="min-w-0 flex-1 px-3 text-sm">
              <span className="truncate">
                {l.action} {l.key || ""}
                {(renameText || moveText) ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({renameText || moveText})
                  </span>
                ) : null}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {l.email || "anonymous"}
              </span>
            </span>
            <span className={l.success ? "text-green-600" : "text-red-600"}>
              {l.success ? "✓" : "✕"}
            </span>
          </div>
        );
        })}

        {logLimitMode === "dynamic" && (
          <>
            <div ref={logsSentinelRef} className="h-1" />
            {logsLoading && logs.length > 0 && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading more…
              </div>
            )}
            {!logsLoading && !logsHasMore && logs.length > 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">End of log.</div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Storage
          </p>
          <h2 className="text-2xl font-semibold">Files &amp; Sharing</h2>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={panelView === "storage" ? "default" : "outline"}
            onClick={() => setPanelView("storage")}
          >
            Storage
          </Button>
          <Button
            size="sm"
            variant={panelView === "shared_to_me" ? "default" : "outline"}
            onClick={() => setPanelView("shared_to_me")}
          >
            Shared to me
          </Button>
          <Button
            size="sm"
            variant={panelView === "my_shares" ? "default" : "outline"}
            onClick={() => setPanelView("my_shares")}
          >
            My shares
          </Button>
          <Button
            size="sm"
            variant={panelView === "activity" ? "default" : "outline"}
            onClick={() => setPanelView("activity")}
          >
            Activity
          </Button>
        </div>
      </div>

      {toasts.length > 0 && (
        <div
          className="fixed top-4 left-4 pointer-events-auto flex w-full max-w-sm flex-col gap-2"
          style={{ zIndex: 1000 }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => dismissToast(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") dismissToast(t.id);
              }}
              className={`cursor-pointer overflow-hidden rounded-xl border bg-card px-4 py-3 text-sm shadow-xl animate-in fade-in slide-in-from-top-2 ${
                t.variant === "error"
                  ? "border-destructive text-destructive"
                  : "border-primary text-foreground"
              }`}
              title="Click to dismiss"
            >
              <div className="whitespace-pre-wrap wrap-break-word">
                {t.text}
              </div>
              {t.details && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background p-2 text-xs text-foreground">
                  {t.details}
                </pre>
              )}
              <div className="mt-3 h-1 w-full overflow-hidden rounded bg-border/60">
                <div
                  className={`toast-progress h-full ${
                    t.variant === "error"
                      ? "bg-destructive/40"
                      : "bg-primary/40"
                  }`}
                  style={{ animationDuration: `${TOAST_MS}ms` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {panelView === "storage" ? (
        <>
      <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => setCurrentPath("")}
            >
              <ArrowLeft className="h-4 w-4" />
              Home
            </button>
            {breadcrumbParts.map((part, idx) => {
              const path = breadcrumbParts.slice(0, idx + 1).join("/");
              return (
                <span key={path} className="flex items-center gap-2">
                  <span className="text-muted-foreground">/</span>
                  <button
                    className="hover:text-foreground"
                    onClick={() => setCurrentPath(path)}
                  >
                    {part}
                  </button>
                </span>
              );
            })}
          </div>
          {currentPath && <Badge variant="secondary">{currentPath}</Badge>}
        </div>
      </div>

      <div className="grid gap-4">
        <div
          className={`rounded-xl border-2 transition ${
            dragActive
              ? "border-primary border-dashed bg-primary/5"
              : "border bg-card/60"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Items</p>
                <p className="text-sm text-muted-foreground">
                  {dragActive
                    ? "Drop files here to upload"
                    : "Click folders to open. Drag files here or to folders."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onNewFolder}
                  disabled={creatingDir || loading}
                >
                  {creatingDir ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FolderPlus className="mr-2 h-4 w-4" />
                  )}
                  New folder
                </Button>
                <input
                  type="file"
                  ref={fileRef}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (!files || files.length === 0) return;

                    const resumeTaskId = resumeUploadTaskIdRef.current;
                    if (resumeTaskId) {
                      resumeUploadTaskIdRef.current = null;

                      const selected = files[0];
                      const task = uploadTasksRef.current.find((t) => t.id === resumeTaskId);
                      if (!task) {
                        pushToast("error", "Resume failed", "Upload task no longer exists.");
                      } else {
                        if (typeof task.totalBytes === "number" && task.totalBytes > 0 && selected.size !== task.totalBytes) {
                          pushToast(
                            "error",
                            "Cannot resume",
                            "Selected file size does not match the original upload."
                          );
                          if (fileRef.current) fileRef.current.value = "";
                          return;
                        }

                        void uploadOneChunked(selected, task.targetPath || undefined, {
                          taskId: task.id,
                          reuseExisting: true,
                          startedAt: task.startedAt,
                          expectedFileChecksum: task.fileChecksum,
                          verifySelectedFile: Boolean(task.fileChecksum),
                          uploadFileName: task.fileName,
                        }).catch((err) => {
                          const msg = err instanceof Error ? err.message : String(err);
                          if (msg === "aborted") return;
                          if (msg === "resume_checksum_mismatch") {
                            pushToast("error", "Cannot resume", "Selected file checksum does not match the original upload.");
                            return;
                          }
                          pushToast("error", "Upload failed", msg);
                          setUploadTasks((prev) =>
                            prev.map((t) =>
                              t.id === task.id ? { ...t, status: "error", error: msg } : t
                            )
                          );
                        });
                      }
                      if (fileRef.current) fileRef.current.value = "";
                      return;
                    }

                    uploadFiles(Array.from(files), currentPath || undefined);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="mr-2 h-4 w-4" />
                  )}
                  Upload
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => refresh(currentPath)}
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            {!list ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : (
              <div className="grid gap-2">
                <div className="grid gap-2">
                  {currentPath && (
                    <div
                      className={`group flex items-center justify-between rounded-lg border px-3 py-2 transition select-none ${
                        dragOverFolder === ".."
                          ? "border-primary bg-primary/5"
                          : "hover:border-primary"
                      }`}
                      role="button"
                      tabIndex={0}
                      onDragOver={(e) => handleFolderDragOver(e, "..")}
                      onDragLeave={handleFolderDragLeave}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverFolder(null);
                        const parts = currentPath.split("/").filter(Boolean);
                        const parentPath = parts.slice(0, -1).join("/");
                        const files = Array.from(e.dataTransfer.files || []);
                        if (files.length > 0) {
                          uploadFiles(files, parentPath || undefined);
                        } else if (draggedItem) {
                          moveItem(draggedItem.key, parentPath);
                        }
                      }}
                      onClick={() => {
                        const parts = currentPath.split("/").filter(Boolean);
                        setCurrentPath(parts.slice(0, -1).join("/"));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          const parts = currentPath.split("/").filter(Boolean);
                          setCurrentPath(parts.slice(0, -1).join("/"));
                        }
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <ArrowLeft className="h-4 w-4 text-muted-foreground" />
                        <div className="text-left">
                          <p className="text-sm font-medium">..</p>
                          <p className="text-xs text-muted-foreground">
                            Parent folder
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  {(list.directories || []).map((d) => {
                    const dirKey = fullKey(d.name, true);
                    return (
                      <div
                        key={dirKey}
                        draggable={editingKey !== dirKey}
                        onDragStart={(e) =>
                          handleItemDragStart(e, "folder", dirKey)
                        }
                        onDragEnd={handleItemDragEnd}
                        className={`group flex items-center justify-between rounded-lg border px-3 py-2 transition select-none cursor-pointer ${
                          dragOverFolder === d.name
                            ? "border-primary bg-primary/5"
                            : "hover:border-primary"
                        }`}
                        onDragOver={(e) => handleFolderDragOver(e, d.name)}
                        onDragLeave={handleFolderDragLeave}
                        onDrop={(e) => handleFolderDrop(e, joinedPath(d.name))}
                        onClick={() => {
                          if (editingKey === dirKey) return;
                          setCurrentPath(joinedPath(d.name));
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <Folder className="h-4 w-4 text-primary" />
                          <div className="text-left">
                            <div className="flex items-center gap-2">
                              {renderNameField(dirKey, d.name)}
                              {ownedShares[dirKey] && (
                                <Badge
                                  variant="secondary"
                                  className="cursor-pointer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openShare(fullKey(d.name, true), true);
                                  }}
                                >
                                  shared
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Folder
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Created: {formatDateTime(d.created_at)} • Modified:{" "}
                              {formatDateTime(d.last_modified)} • By:{" "}
                              {d.created_by_email || "—"}
                            </p>
                          </div>
                        </div>
                        <div
                          className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!d.is_empty && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                onDownloadFolderZip(joinedPath(d.name))
                              }
                              title="Download as ZIP"
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openShare(fullKey(d.name, true), true)}
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onDelete(fullKey(d.name, true))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="grid gap-2">
                  {(list.files || []).map((f) => {
                    const fileKey = fullKey(f.name);
                    return (
                      <div
                        key={fileKey}
                        draggable={editingKey !== fileKey}
                        onDragStart={(e) =>
                          handleItemDragStart(e, "file", fileKey)
                        }
                        onDragEnd={handleItemDragEnd}
                        className="group flex items-center justify-between rounded-lg border px-3 py-2 hover:border-primary select-none"
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                            {f.name.split(".").pop()?.toUpperCase().slice(0, 4) ||
                              "FILE"}
                          </div>
                          <div className="text-left">
                            <div className="flex items-center gap-2">
                              {renderNameField(fileKey, f.name)}
                              {ownedShares[fileKey] && (
                                <Badge
                                  variant="secondary"
                                  className="cursor-pointer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openShare(fullKey(f.name), false);
                                  }}
                                >
                                  shared
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {formatBytes(f.size)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Created: {formatDateTime(f.created_at)} • Modified:{" "}
                              {formatDateTime(f.last_modified)} • By:{" "}
                              {f.created_by_email || "—"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onDownload(fullKey(f.name))}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onShowVersions(fullKey(f.name))}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openShare(fullKey(f.name), false)}
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onDelete(fullKey(f.name))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(!list.directories?.length && !list.files?.length) && (
                  <div className="rounded-lg px-4 py-6 text-center text-sm text-muted-foreground">
                    No files found
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">Unfinished uploads</p>
            <p className="text-xs text-muted-foreground">
              {uploadTasks.length} item{uploadTasks.length === 1 ? "" : "s"}
            </p>
          </div>

          {uploadTasks.length === 0 ? (
            <div className="text-sm text-muted-foreground">No unfinished uploads.</div>
          ) : (
            <div className="grid gap-2">
              {uploadTasks.map((t) => {
                const isActive = t.status === "hashing" || t.status === "uploading" || t.status === "finalizing";
                const canAbortServer = Boolean(t.fileChecksum);
                const total = t.totalBytes || 0;

                const smooth = smoothProgressRef.current.get(t.id);
                const uploadedRaw = typeof smooth?.uploaded === "number" ? smooth.uploaded : (t.uploadedBytes || 0);
                const hashedRaw = typeof smooth?.hashed === "number" ? smooth.hashed : (t.hashedBytes || 0);

                const uploaded = Math.max(0, Math.min(uploadedRaw, total || uploadedRaw));
                const left = Math.max(0, total - uploaded);
                const uploadedMb = uploaded / 1024 / 1024;
                const leftMb = left / 1024 / 1024;
                const pct =
                  total > 0
                    ? Math.max(0, Math.min(100, (uploaded / total) * 100))
                    : 0;

                const hashed = Math.max(0, Math.min(hashedRaw, total || hashedRaw));
                const hashPct =
                  total > 0
                    ? Math.max(0, Math.min(100, (hashed / total) * 100))
                    : 0;

                return (
                  <div
                    key={t.id}
                    className="rounded-md border bg-background/40 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {t.fileName}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Started: {new Date(t.startedAt).toLocaleString()} • Uploaded: {uploadedMb.toFixed(1)} MB • Left: {leftMb.toFixed(1)} MB
                          {(total > 0 && (t.status === "hashing" || t.checksumStage)) ? (
                            <span className="ml-2 inline-flex items-center gap-1 align-middle">
                              <span className="text-[10px] text-muted-foreground">
                                {t.checksumStage === "chunk"
                                  ? `Chunk checksums ${t.checksumChunkIndex || 0}/${t.checksumChunksTotal || 0}`
                                  : "File checksum"}
                              </span>

                              {t.status === "hashing" ? (
                                <>
                                  <span className="h-1.5 w-20 overflow-hidden rounded bg-muted align-middle">
                                    <span
                                      className="block h-full bg-primary transition-[width] duration-200 ease-out"
                                      style={{ width: `${hashPct}%` }}
                                    />
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">{Math.round(hashPct)}%</span>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                        {t.targetPath ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            Destination: {t.targetPath}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {t.status === "finalizing" ? (
                          <Button variant="outline" size="sm" disabled>
                            Finalizing…
                          </Button>
                        ) : isActive ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => pauseUpload(t.id)}
                          >
                            Pause
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const file = uploadFileRef.current.get(t.id);
                              if (file) {
                                void uploadOneChunked(file, t.targetPath || undefined, {
                                  taskId: t.id,
                                  reuseExisting: true,
                                  startedAt: t.startedAt,
                                  uploadFileName: t.fileName,
                                }).catch((err) => {
                                  const msg = err instanceof Error ? err.message : String(err);
                                  if (msg === "aborted") return;
                                  pushToast("error", "Upload failed", msg);
                                  setUploadTasks((prev) =>
                                    prev.map((x) => (x.id === t.id ? { ...x, status: "error", error: msg } : x))
                                  );
                                });
                                return;
                              }

                              resumeUploadTaskIdRef.current = t.id;
                              pushToast(
                                "success",
                                "Select file to resume",
                                "Choose the same file to continue from uploaded chunks."
                              );
                              fileRef.current?.click();
                            }}
                          >
                            Resume
                          </Button>
                        )}

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void cancelUpload(t.id, t.fileChecksum);
                          }}
                        >
                          {isActive ? "Cancel" : canAbortServer ? "Abort" : "Dismiss"}
                        </Button>
                      </div>
                    </div>

                    <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary transition-[width] duration-200 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    {t.status === "error" && (
                      <div className="mt-2 text-xs text-destructive">
                        Upload failed: {t.error || "Unknown error"}
                      </div>
                    )}

                    {t.status !== "error" && t.note && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {t.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {versions && selectedKey && (
        <div className="rounded-xl border bg-card/80 p-4 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Versions</p>
              <p className="text-xs text-muted-foreground">{selectedKey}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setVersions(null);
                setSelectedKey(null);
              }}
            >
              Close
            </Button>
          </div>
          <div className="space-y-2">
            {versions.map((v: any) => (
              <div
                key={v.version}
                className="flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="text-sm">
                  v{v.version} • {formatBytes(v.size)} • {v.created_at}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRestoreVersion(v.version)}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

        </>
      ) : panelView === "shared_to_me" ? (
        <>
          <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">Shared to me</p>
                <p className="text-sm text-muted-foreground">
                  Files other users shared with your account.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={refreshSharedToMe}
                disabled={sharedToMeLoading}
              >
                {sharedToMeLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Refresh
              </Button>
            </div>

            {!sharedToMeLoading && (!sharedToMe || sharedToMe.length === 0) ? (
              <p className="text-sm text-muted-foreground">No shares found.</p>
            ) : (
              <div className="space-y-2">
                {(sharedToMe || []).map((s) => (
                  <div
                    key={s.share_id}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {s.key}
                        </span>
                        <Badge variant="secondary">{s.permission}</Badge>
                        {s.is_directory ? (
                          <Badge variant="outline">folder</Badge>
                        ) : (
                          <Badge variant="outline">file</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        Owner: {s.owner_email || "unknown"}
                        {s.expires_at ? ` • Expires: ${s.expires_at}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={s.is_directory}
                        onClick={async () => {
                          const res = await api.sharedDownload(s.share_id);
                          if (!res.ok) {
                            pushToast(
                              "error",
                              "Download failed",
                              JSON.stringify(res.data)
                            );
                            return;
                          }
                          const url = (res.data as any)?.url;
                          if (url) {
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = "";
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                          }
                        }}
                      >
                        <Download className="mr-2 h-4 w-4" /> Download
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </>
      ) : panelView === "activity" ? (
        <>
          <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
            <div className="mb-3">
              <p className="text-sm font-semibold">Activity</p>
              <p className="text-sm text-muted-foreground">
                Recent actions performed in your storage.
              </p>
            </div>
            {renderActivityLog()}
          </div>
        </>
      ) : (
        <>
          <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">My shares</p>
                <p className="text-sm text-muted-foreground">
                  Links you created to share files/folders.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={refreshMyShares}
                disabled={mySharesLoading}
              >
                {mySharesLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Refresh
              </Button>
            </div>

            {!mySharesLoading && (!mySharesList || mySharesList.length === 0) ? (
              <p className="text-sm text-muted-foreground">
                You haven’t created any shares yet.
              </p>
            ) : (
              <div className="space-y-2">
                {(mySharesList || []).map((s) => {
                  const sharePageUrl = `${window.location.origin}/share?token=${encodeURIComponent(
                    s.token
                  )}`;
                  return (
                    <div
                      key={s.share_id}
                      className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {s.key}
                          </span>
                          <Badge variant="secondary">{s.visibility}</Badge>
                          <Badge variant="outline">{s.permission}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {s.expires_at
                            ? `Expires: ${s.expires_at}`
                            : "No expiry"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openShareFromResult(s)}
                        >
                          <Pencil className="mr-2 h-4 w-4" /> Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            copyText(sharePageUrl, "Share link copied")
                          }
                        >
                          <Copy className="mr-2 h-4 w-4" /> Copy
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            window.open(
                              sharePageUrl,
                              "_blank",
                              "noopener,noreferrer"
                            )
                          }
                        >
                          <Share2 className="mr-2 h-4 w-4" /> Open
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={async () => {
                            if (!confirm("Revoke this share?")) return;
                            const res = await api.revokeShare(s.share_id);
                            if (!res.ok) {
                              pushToast(
                                "error",
                                "Failed to revoke share",
                                JSON.stringify(res.data)
                              );
                              return;
                            }
                            pushToast("success", "Share revoked");
                            refreshMyShares();
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Revoke
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </>
      )}

      {shareState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm backdrop-brightness-75">
          <div className="w-full max-w-xl space-y-4 rounded-xl border bg-card p-5 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Share
                </p>
                <p className="text-sm font-semibold break-all">{shareState.key}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={closeShare}>
                Close
              </Button>
            </div>

            <div className="grid gap-3">
              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Visibility
                </label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={shareState.visibility}
                  onChange={(e) =>
                    setShareState((prev) =>
                      prev
                        ? {
                            ...prev,
                            visibility: e.target.value as ShareVisibility,
                          }
                        : prev
                    )
                  }
                >
                  <option value="private">Private (specific user)</option>
                  <option value="public">Public link</option>
                  <option value="protected">Protected (allowed emails)</option>
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Permission
                </label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  disabled={shareState.visibility !== "private" || shareState.isDir}
                  value={shareState.permission}
                  onChange={(e) =>
                    setShareState((prev) =>
                      prev
                        ? {
                            ...prev,
                            permission: e.target.value as SharePermission,
                          }
                        : prev
                    )
                  }
                >
                  <option value="read">Read only</option>
                  <option value="read-write">Read &amp; write</option>
                </select>
                {shareState.visibility !== "private" && (
                  <p className="text-xs text-muted-foreground">
                    Public and protected links are limited to read-only.
                  </p>
                )}
                {shareState.isDir && (
                  <p className="text-xs text-muted-foreground">
                    Directory shares are read-only and meant for browsing/zip downloads.
                  </p>
                )}
              </div>

              {shareState.visibility === "private" && (
                <div className="grid gap-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Target email
                  </label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="user@example.com"
                    value={shareState.targetEmail}
                    onChange={(e) =>
                      setShareState((prev) =>
                        prev
                          ? {
                              ...prev,
                              targetEmail: e.target.value,
                            }
                          : prev
                      )
                    }
                  />
                </div>
              )}

              {shareState.visibility === "protected" && (
                <div className="grid gap-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Allowed emails
                  </label>
                  <textarea
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    rows={3}
                    placeholder="one@example.com, two@example.com"
                    value={shareState.allowedEmails}
                    onChange={(e) =>
                      setShareState((prev) =>
                        prev
                          ? {
                              ...prev,
                              allowedEmails: e.target.value,
                            }
                          : prev
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma or newline separated. Viewers must be logged in with a
                    matching email.
                  </p>
                </div>
              )}

              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Expires in (seconds)
                </label>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Optional"
                  value={shareState.expiresIn}
                  onChange={(e) =>
                    setShareState((prev) =>
                      prev
                        ? {
                            ...prev,
                            expiresIn: e.target.value,
                          }
                        : prev
                    )
                  }
                />
              </div>
            </div>

            {shareState.result && (
              <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm overflow-hidden">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">Share active</p>
                  {shareState.result.expires_at && (
                    <span className="text-xs text-muted-foreground">
                      Expires {shareState.result.expires_at}
                    </span>
                  )}
                </div>
                {shareState.result.access_url && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-muted-foreground">Link</span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 break-all rounded-md border bg-background px-3 py-2 text-xs">
                        {shareState.result.access_url}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          copyText(shareState.result?.access_url || "", "Link copied")
                        }
                      >
                        <Copy className="mr-1 h-4 w-4" /> Copy
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">Token</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 break-all rounded-md border bg-background px-3 py-2 text-xs">
                      {shareState.result?.token || ""}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        copyText(shareState.result?.token || "", "Token copied")
                      }
                      disabled={!shareState.result?.token}
                    >
                      <Copy className="mr-1 h-4 w-4" /> Copy
                    </Button>
                  </div>
                </div>
                <div className="flex justify-end pt-2 pr-2 pb-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="text-white border-2 border-red-800 px-6 py-3 shadow-sm"
                    onClick={revokeCurrentShare}
                    disabled={shareLoading}
                  >
                    Revoke share
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={closeShare}>
                Cancel
              </Button>
              <Button onClick={submitShare} disabled={shareLoading}>
                {shareLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {shareState?.result ? "Update share" : "Create share"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { default } from "./storage-panel/StoragePanel";
