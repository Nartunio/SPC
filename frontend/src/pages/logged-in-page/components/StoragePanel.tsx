import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import {
  ArrowLeft,
  Download,
  Folder,
  History,
  Loader2,
  RefreshCcw,
  Share2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { createApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type FileItem = {
  name: string;
  size?: number;
  last_modified?: string;
  etag?: string;
};

type ListResponse = {
  prefix: string;
  path?: string;
  directories: { name: string }[];
  files: FileItem[];
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

export default function StoragePanel() {
  const { getAccessTokenSilently } = useAuth0();
  const api = useMemo(
    () =>
      createApi(() =>
        getAccessTokenSilently({
          authorizationParams: {
            audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
          },
        })
      ),
    [getAccessTokenSilently]
  );

  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

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
  const [newDir, setNewDir] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<{
    type: "file" | "folder";
    key: string;
  } | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);

  const [logs, setLogs] = useState<any[] | null>(null);

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

  const refresh = useCallback(
    async (path?: string) => {
      setLoading(true);
      const res = await api.list(path || undefined);
      setLoading(false);
      if (!res.ok) {
        pushToast("error", JSON.stringify(res.data));
        return;
      }
      setList(res.data as ListResponse);
    },
    [api, pushToast]
  );

  useEffect(() => {
    setList(null); // Clear list immediately when path changes
    refresh(currentPath);
  }, [currentPath, refresh]);

  async function onCreateDir() {
    if (!newDir.trim()) return;
    if (creatingDir) return; // Prevent duplicate submissions
    setCreatingDir(true);
    const path = fullKey(newDir.trim(), true).replace(/\/$/, "");
    const res = await api.createDir(path);
    setCreatingDir(false);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setNewDir("");
    refresh(currentPath);
  }

  async function uploadFiles(files: File[], targetPath?: string) {
    if (!files.length) return;
    setUploading(true);
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024 * 1024) {
        pushToast("error", "File too large (max 2GB).", `File: ${f.name}`);
        setUploading(false);
        return;
      }
      const res = await api.upload(f, targetPath || currentPath || undefined);
      if (!res.ok) {
        pushToast("error", JSON.stringify(res.data));
        setUploading(false);
        return;
      }
    }
    pushToast(
      "success",
      `Uploaded ${files.length} file${files.length > 1 ? "s" : ""}.`
    );
    if (fileRef.current) fileRef.current.value = "";
    setUploadPath("");
    setUploading(false);
    refresh(currentPath);
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || !files.length) return;
    const target = uploadPath.trim()
      ? joinedPath(uploadPath.trim())
      : currentPath;
    await uploadFiles(Array.from(files), target || undefined);
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

  async function onLoadLogs() {
    const res = await api.logs(50);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setLogs((res.data as any).logs || []);
  }

  async function onShare(key: string) {
    const targetSub = window.prompt("Share with target_sub (e.g. auth0|...):");
    if (!targetSub || !targetSub.trim()) return;

    const permissionRaw = window.prompt(
      'Permission? Type "read" or "read-write" (default: read):'
    );
    const permission =
      permissionRaw && permissionRaw.trim() === "read-write"
        ? "read-write"
        : "read";

    const expiresRaw = window.prompt(
      "Expires in seconds? Leave empty for no expiry:"
    );
    const expires =
      expiresRaw && expiresRaw.trim() !== "" ? Number(expiresRaw) : undefined;
    const expiresValue =
      typeof expires === "number" && Number.isFinite(expires) && expires > 0
        ? expires
        : undefined;

    const res = await api.shareWithUser(
      key,
      targetSub.trim(),
      permission,
      expiresValue
    );
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    pushToast("success", "Share created");
  }

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Storage
          </p>
          <h2 className="text-2xl font-semibold">Files &amp; Sharing</h2>
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="fixed top-4 left-4 z-50 flex w-full max-w-sm flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => dismissToast(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") dismissToast(t.id);
              }}
              className={`cursor-pointer overflow-hidden rounded-lg border px-4 py-3 text-sm shadow-lg animate-in fade-in slide-in-from-top-2 ${
                t.variant === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-primary/30 bg-primary/5 text-primary"
              }`}
              title="Click to dismiss"
            >
              <div className="whitespace-pre-wrap wrap-break-word">
                {t.text}
              </div>
              {t.details && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-card/40 p-2 text-xs text-foreground">
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

      <div className="grid gap-4 lg:grid-cols-3">
        <div
          className={`rounded-xl border-2 transition lg:col-span-2 ${
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
                <input
                  type="file"
                  ref={fileRef}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) {
                      uploadFiles(Array.from(files), currentPath || undefined);
                    }
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
                    >
                      <button
                        className="flex items-center gap-3"
                        onClick={() => {
                          const parts = currentPath.split("/").filter(Boolean);
                          setCurrentPath(parts.slice(0, -1).join("/"));
                        }}
                      >
                        <ArrowLeft className="h-4 w-4 text-muted-foreground" />
                        <div className="text-left">
                          <p className="text-sm font-medium">..</p>
                          <p className="text-xs text-muted-foreground">
                            Parent folder
                          </p>
                        </div>
                      </button>
                    </div>
                  )}
                  {(list.directories || []).map((d) => (
                    <div
                      key={d.name}
                      draggable
                      onDragStart={(e) =>
                        handleItemDragStart(e, "folder", fullKey(d.name, true))
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
                      onClick={() => setCurrentPath(joinedPath(d.name))}
                    >
                      <div className="flex items-center gap-3">
                        <Folder className="h-4 w-4 text-primary" />
                        <div className="text-left">
                          <p className="text-sm font-medium">{d.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Folder
                          </p>
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
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
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onShare(fullKey(d.name, true))}
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
                  ))}
                </div>

                <div className="grid gap-2">
                  {(list.files || []).map((f) => (
                    <div
                      key={f.name}
                      draggable
                      onDragStart={(e) =>
                        handleItemDragStart(e, "file", fullKey(f.name))
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
                          <p className="text-sm font-medium">{f.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatBytes(f.size)}
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
                          onClick={() => onShare(fullKey(f.name))}
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
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
          <p className="text-sm font-semibold">New folder</p>
          <p className="text-xs text-muted-foreground">
            Created inside {currentPath || "root"}.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <Input
              placeholder="photos/2026"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
            />
            <Button onClick={onCreateDir} disabled={creatingDir}>
              {creatingDir ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {creatingDir ? "Creating..." : "Create"}
            </Button>
          </div>
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

      <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold">Activity Log</p>
          <Button variant="ghost" size="sm" onClick={onLoadLogs}>
            Refresh
          </Button>
        </div>
        {logs ? (
          <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
            {logs.map((l: any, idx: number) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/50"
              >
                <span className="text-xs text-muted-foreground">
                  {l.created_at}
                </span>
                <span className="text-sm">
                  {l.action} {l.key || ""}
                </span>
                <span className={l.success ? "text-green-600" : "text-red-600"}>
                  {l.success ? "✓" : "✕"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No logs loaded yet.</p>
        )}
      </div>
    </div>
  );
}
