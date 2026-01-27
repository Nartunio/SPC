import { Button } from "@/components/ui/button";
import { useStoragePanel } from "../context";

export function UnfinishedUploadsCard() {
  const { uploads, fileRef } = useStoragePanel();
  const { uploadTasks, smoothProgress } = uploads;

  return (
    <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Unfinished uploads</p>
        <p className="text-xs text-muted-foreground">
          {uploadTasks.length} item{uploadTasks.length === 1 ? "" : "s"}
        </p>
      </div>

      {uploadTasks.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No unfinished uploads.
        </div>
      ) : (
        <div className="grid gap-2">
          {uploadTasks.map((t) => {
            const isActive =
              t.status === "hashing" ||
              t.status === "uploading" ||
              t.status === "finalizing";
            const isWaiting = t.status === "finalized_waiting";
            const canAbortServer = Boolean(t.fileChecksum);
            const total = t.totalBytes || 0;

            const smooth = smoothProgress.get(t.id);
            const uploadedRaw =
              typeof smooth?.uploaded === "number"
                ? smooth.uploaded
                : t.uploadedBytes || 0;
            const hashedRaw =
              typeof smooth?.hashed === "number"
                ? smooth.hashed
                : t.hashedBytes || 0;

            const uploaded = Math.max(
              0,
              Math.min(uploadedRaw, total || uploadedRaw),
            );
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
                      Started: {new Date(t.startedAt).toLocaleString()} •
                      Uploaded: {uploadedMb.toFixed(1)} MB • Left:{" "}
                      {leftMb.toFixed(1)} MB
                      {total > 0 &&
                      (t.status === "hashing" || t.checksumStage) ? (
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
                              <span className="text-[10px] text-muted-foreground">
                                {Math.round(hashPct)}%
                              </span>
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
                    ) : isWaiting ? (
                      <Button variant="outline" size="sm" disabled>
                        Processing…
                      </Button>
                    ) : isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => uploads.pauseUpload(t.id)}
                      >
                        Pause
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          uploads.resumeUpload(t, () =>
                            fileRef.current?.click(),
                          )
                        }
                      >
                        Resume
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void uploads.cancelUpload(
                          t.id,
                          t.fileChecksum || undefined,
                        );
                      }}
                    >
                      {isActive || isWaiting
                        ? "Cancel"
                        : canAbortServer
                          ? "Abort"
                          : "Dismiss"}
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
  );
}
