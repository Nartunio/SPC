import { useCallback, useEffect, useRef, useState } from "react";
import { createSHA256 } from "hash-wasm";

import { UPLOAD_CHUNK_SIZE } from "../constants";
import { useUploadTaskPersistence } from "./useUploadTaskPersistence";
import type {
  FinalizePollState,
  ListResponse,
  PanelView,
  Toast,
  UploadChecksumCacheEntry,
  UploadTask,
  VisibilityPollState,
} from "../types";

type Api = {
  chunked: {
    abort: (fileChecksum: string) => Promise<any>;
    unfinished: () => Promise<{ ok: boolean; data: any }>;
    initiate: (body: any, options?: { signal?: AbortSignal }) => Promise<{ ok: boolean; data: any }>;
    complete: (body: any, options?: { signal?: AbortSignal }) => Promise<{ ok: boolean; data: any }>;
  };
};

type PushToast = (variant: Toast["variant"], text: string, details?: string) => void;

type GetToken = () => Promise<string>;

type GetIdTokenRaw = () => Promise<string | undefined>;

type Refresh = (path?: string) => void | Promise<void>;

export function useChunkedUploads({
  api,
  pushToast,
  getTokenWithRenew,
  getIdTokenRaw,
  panelView,
  currentPath,
  refresh,
  listRef,
}: {
  api: Api;
  pushToast: PushToast;
  getTokenWithRenew: GetToken;
  getIdTokenRaw: GetIdTokenRaw;
  panelView: PanelView;
  currentPath: string;
  refresh: Refresh;
  listRef: React.MutableRefObject<ListResponse | null>;
}) {
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);

  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
  const uploadXhrRef = useRef<Map<string, Set<XMLHttpRequest>>>(new Map());
  const uploadHydratedRef = useRef(false);
  const uploadLocalHydratedRef = useRef(false);
  const uploadPersistTimerRef = useRef<number | null>(null);
  const uploadTasksRef = useRef<UploadTask[]>([]);
  const resumeUploadTaskIdRef = useRef<string | null>(null);
  const uploadFileRef = useRef<Map<string, File>>(new Map());
  const uploadChecksumCacheRef = useRef<Map<string, UploadChecksumCacheEntry>>(new Map());
  const finalizePollRef = useRef<FinalizePollState>({ timer: null, tries: 0 });
  const visibilityPollRef = useRef<VisibilityPollState>({ timer: null, tries: 0, expected: new Set() });

  const uploading = uploadTasks.some((t) => t.status === "hashing" || t.status === "uploading");

  useUploadTaskPersistence({
    uploadTasks,
    setUploadTasks,
    uploadTasksRef,
    uploadPersistTimerRef,
    uploadLocalHydratedRef,
  });

  // Smooth UI counters/bars so they don't jump per chunk.
  const smoothProgressRef = useRef(new Map<string, { uploaded: number; hashed: number; ts: number }>());
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

        if (Math.abs(nextUploaded - existing.uploaded) > 0.25 || Math.abs(nextHashed - existing.hashed) > 0.25) {
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

  // Hydrate unfinished uploads from server.
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
          const existing = new Set(prev.map((t) => (t.fileChecksum ? t.fileChecksum.toLowerCase() : "")).filter(Boolean));
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
        typeof options?.uploadFileName === "string" && options.uploadFileName.trim()
          ? options.uploadFileName
          : uploadTasksRef.current.find((t) => t.id === id)?.fileName || file.name;

      // 1) Compute whole-file SHA-256 first (single pass).
      const total = file.size || 0;
      const expected = options?.expectedFileChecksum ? String(options.expectedFileChecksum).toLowerCase() : undefined;

      const mustVerifySelectedFile = Boolean(options?.verifySelectedFile && expected);

      const existingTask = uploadTasksRef.current.find((t) => t.id === id);
      const cached = uploadChecksumCacheRef.current.get(id);
      const cachedFileChecksum =
        (existingTask?.fileChecksum && existingTask.totalBytes === total ? existingTask.fileChecksum : undefined) ||
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
            setUploadTasks((prev) => prev.map((t) => (t.id === id ? { ...t, hashedBytes: progressValue } : t)));
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
          prev.map((t) => (t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t))
        );
      } else if (cachedFileChecksum) {
        fileChecksum = String(cachedFileChecksum).toLowerCase();
        setUploadTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t))
        );
      } else {
        fileChecksum = await computeWholeFileChecksum();
        uploadChecksumCacheRef.current.set(id, {
          fileChecksum,
          chunkChecksums: uploadChecksumCacheRef.current.get(id)?.chunkChecksums,
        });
        setUploadTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, fileChecksum, hashedBytes: total, checksumStage: "whole" } : t))
        );
      }

      // 2) Upload the whole-file checksum first (initiate); server returns present staged chunks.
      const initRes = await api.chunked.initiate(
        {
          filename: uploadFileName,
          file_checksum: fileChecksum,
          chunk_size: UPLOAD_CHUNK_SIZE,
          total_size: file.size,
          path: target || undefined,
        },
        { signal }
      );
      if (!initRes.ok) {
        const details = typeof initRes.data === "string" ? initRes.data : JSON.stringify(initRes.data ?? null);
        throw new Error(details);
      }

      const present = new Set<string>(((initRes.data as any)?.present || []) as string[]);

      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "uploading",
                uploadedBytes: 0,
                checksumStage: "chunk",
                checksumChunkIndex: 0,
                checksumChunksTotal: Math.ceil(total / UPLOAD_CHUNK_SIZE),
              }
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

      // Allow multiple chunks to upload in parallel. Tune this value if backends
      // throttle aggressively; 4 keeps good throughput without overwhelming.
      const MAX_CONCURRENT_CHUNK_UPLOADS = 128;

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

      const storageBase =
        String((import.meta as any).env.VITE_API_BASE || "http://localhost:8000").replace(/\/$/, "") +
        "/storage";

      const inflightProgress = new Map<string, number>();
      let lastInflightUpdateAt = 0;
      const updateInflightBytes = (force = false) => {
        const now = Date.now();
        if (!force && now - lastInflightUpdateAt < 60) return;
        lastInflightUpdateAt = now;
        let sum = 0;
        for (const v of inflightProgress.values()) sum += v;
        setUploadTasks((prev) => prev.map((t) => (t.id === id ? { ...t, inflightBytes: sum } : t)));
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
              prev.map((t) => (t.id === id ? { ...t, uploadedBytes: (t.uploadedBytes || 0) + chunk.size } : t))
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
              prev.map((t) => (t.id === id ? { ...t, uploadedBytes: (t.uploadedBytes || 0) + size } : t))
            );
            continue;
          }

          const blob = file.slice(start, end);
          await uploadChunkWithProgress({ checksum, blob, size });
        }
      };

      await Promise.all([producer, ...Array.from({ length: MAX_CONCURRENT_CHUNK_UPLOADS }, () => worker())]);

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
      const completeRes = await api.chunked.complete(
        {
          filename: uploadFileName,
          file_checksum: fileChecksum,
          chunk_checksums: chunkChecksums.filter(Boolean) as string[],
          total_size: file.size,
          path: target || undefined,
        },
        { signal }
      );
      if (!completeRes.ok) {
        const details = typeof completeRes.data === "string" ? completeRes.data : JSON.stringify(completeRes.data ?? null);
        throw new Error(details);
      }

      uploadAbortRef.current.delete(id);
      uploadFileRef.current.delete(id);
      uploadChecksumCacheRef.current.delete(id);
      // Keep the task visible until the server surfaces the file in the explorer.
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "finalized_waiting",
                inflightBytes: 0,
                note: "Waiting for the file to appear in storage…",
              }
            : t
        )
      );
    },
    [api, getIdTokenRaw, getTokenWithRenew]
  );

  const resumeUpload = useCallback(
    (t: UploadTask, openFilePicker: () => void) => {
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
          setUploadTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: "error", error: msg } : x)));
        });
        return;
      }

      resumeUploadTaskIdRef.current = t.id;
      pushToast("success", "Select file to resume", "Choose the same file to continue from uploaded chunks.");
      openFilePicker();
    },
    [pushToast, uploadOneChunked]
  );

  const uploadFiles = useCallback(
    async (files: File[], targetPath?: string, clearInput?: () => void) => {
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
        pushToast("success", `Uploaded ${successCount} file${successCount > 1 ? "s" : ""}.`);
      }
      clearInput?.();
      await refresh(currentPath);
    },
    [currentPath, pushToast, refresh, uploadOneChunked]
  );

  const handleFileInputChange = useCallback(
    (
      files: FileList | null,
      targetPath: string | undefined,
      clearInput: () => void
    ) => {
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
            pushToast("error", "Cannot resume", "Selected file size does not match the original upload.");
            clearInput();
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
            setUploadTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "error", error: msg } : t)));
          });
        }
        clearInput();
        return;
      }

      void uploadFiles(Array.from(files), targetPath || undefined, clearInput);
    },
    [pushToast, uploadFiles, uploadOneChunked]
  );

  // While a task is finalizing, poll the server for unfinished manifests.
  // Once the manifest disappears, keep the task until the file is visible in the explorer.
  useEffect(() => {
    const hasFinalizing = uploadTasks.some((t) => t.status === "finalizing" && t.fileChecksum);
    const hasWaiting = uploadTasks.some((t) => t.status === "finalized_waiting");

    if (!hasFinalizing && !hasWaiting && finalizePollRef.current.timer) {
      window.clearInterval(finalizePollRef.current.timer);
      finalizePollRef.current.timer = null;
      finalizePollRef.current.tries = 0;
    }
    if (!hasFinalizing && !hasWaiting && visibilityPollRef.current.timer) {
      window.clearInterval(visibilityPollRef.current.timer);
      visibilityPollRef.current.timer = null;
      visibilityPollRef.current.expected.clear();
      visibilityPollRef.current.tries = 0;
      return;
    }

    if (hasFinalizing && !finalizePollRef.current.timer) {
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
              prev.map((t) => {
                if (
                  t.status === "finalizing" &&
                  t.fileChecksum &&
                  completedChecksums.includes(String(t.fileChecksum).toLowerCase())
                ) {
                  return {
                    ...t,
                    status: "finalized_waiting",
                    note: "Waiting for the file to appear in storage…",
                  };
                }
                return t;
              })
            );

            if (panelView === "storage") {
              void refresh(currentPath);
            }

            if (expectedNames.size > 0) {
              for (const n of expectedNames) visibilityPollRef.current.expected.add(n);
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
    }

    // Visibility poll runs while we expect files to surface or while tasks are waiting.
    const startVisibilityPoll = () => {
      if (visibilityPollRef.current.timer) return;
      visibilityPollRef.current.tries = 0;
      visibilityPollRef.current.timer = window.setInterval(() => {
        try {
          visibilityPollRef.current.tries += 1;
          const snapshot = listRef.current;
          const visible = new Set((snapshot?.files || []).map((f) => String(f?.name || "")).filter(Boolean));

          const pendingNames = new Set(visibilityPollRef.current.expected);
          for (const name of pendingNames) {
            if (visible.has(name)) {
              visibilityPollRef.current.expected.delete(name);
              // Remove the task once the file is visible.
              setUploadTasks((prev) => prev.filter((t) => !(t.fileName === name && t.status === "finalized_waiting")));
            }
          }

          if (visibilityPollRef.current.expected.size === 0 && !uploadTasksRef.current.some((t) => t.status === "finalized_waiting")) {
            if (visibilityPollRef.current.timer) {
              window.clearInterval(visibilityPollRef.current.timer);
              visibilityPollRef.current.timer = null;
            }
            visibilityPollRef.current.tries = 0;
            return;
          }

          // Refresh the current folder to surface newly finalized files.
          if (panelView === "storage") {
            void refresh(currentPath);
          }

          // After several tries, stop hammering but keep tasks visible for manual retry.
          if (visibilityPollRef.current.tries >= 10) {
            if (visibilityPollRef.current.timer) {
              window.clearInterval(visibilityPollRef.current.timer);
              visibilityPollRef.current.timer = null;
            }
          }
        } catch {
          // ignore
        }
      }, 2000);
    };

    if (visibilityPollRef.current.expected.size > 0 || hasWaiting) {
      // Seed expected names from any waiting tasks in the current folder.
      for (const t of uploadTasksRef.current) {
        if (t.status === "finalized_waiting" && (t.targetPath || "") === (currentPath || "")) {
          const name = (t.fileName || "").trim();
          if (name) visibilityPollRef.current.expected.add(name);
        }
      }
      startVisibilityPoll();
    }

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
  }, [api, currentPath, listRef, panelView, refresh, uploadTasks]);

  return {
    uploadTasks,
    uploading,
    smoothProgress: smoothProgressRef.current,

    cancelUpload,
    pauseUpload,
    resumeUpload,

    uploadFiles,
    handleFileInputChange,
  };
}
