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
  etag?: string;
};

type ListResponse = {
  prefix: string;
  path?: string;
  directories: { name: string; is_empty?: boolean }[];
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
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();

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
            redirect_uri: window.location.origin,
            audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
            scope: 'openid profile email offline_access',
            prompt: 'login',
          },
        });
      }

      throw err;
    }
  }, [getAccessTokenSilently, loginWithRedirect]);

  const api = useMemo(() => createApi(getTokenWithRenew), [getTokenWithRenew]);

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

  useEffect(() => {
    if (!shareState) return;
    if (shareState.visibility !== "private" && shareState.permission !== "read") {
      setShareState({ ...shareState, permission: "read" });
    }
  }, [shareState?.visibility]);

  const [hoveredNameKey, setHoveredNameKey] = useState<string | null>(null);
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

  const commitRename = useCallback(
    async (key: string, isDir: boolean) => {
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
    setList(null); // Clear list immediately when path changes
    refresh(currentPath);
  }, [currentPath, refresh]);

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
    setUploading(false);
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

  async function onLoadLogs() {
    const res = await api.logs(50);
    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }
    setLogs((res.data as any).logs || []);
  }

  const openShare = useCallback((key: string, isDir: boolean) => {
    setShareState({
      key,
      isDir,
      visibility: "private",
      permission: "read",
      targetEmail: "",
      allowedEmails: "",
      expiresIn: "",
      result: null,
    });
  }, []);

  const closeShare = useCallback(() => {
    setShareLoading(false);
    setShareState(null);
  }, []);

  async function submitShare() {
    if (!shareState) return;
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
      target_email: shareState.targetEmail.trim() || undefined,
      allowed_emails: allowedEmails,
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
    pushToast("success", "Share created");
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
    setHoveredNameKey(newKey);
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
    (key: string, name: string, isDir: boolean, isHoveringName: boolean) => {
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
                commitRename(key, isDir);
              } else if (e.key === "Escape") {
                setEditingKey(null);
                setEditingValue("");
              }
            }}
            onBlur={() => {
              if (isEditing) commitRename(key, isDir);
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
                        onMouseEnter={() => setHoveredNameKey(dirKey)}
                        onMouseLeave={() =>
                          setHoveredNameKey((prev) =>
                            prev === dirKey ? null : prev
                          )
                        }
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
                            <div
                              className="flex flex-col"
                              onMouseEnter={() => setHoveredNameKey(dirKey)}
                              onMouseLeave={() =>
                                setHoveredNameKey((prev) =>
                                  prev === dirKey ? null : prev
                                )
                              }
                            >
                              {renderNameField(
                                dirKey,
                                d.name,
                                true,
                                hoveredNameKey === dirKey
                              )}
                              <p className="text-xs text-muted-foreground">
                                Folder
                              </p>
                            </div>
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
                        onMouseEnter={() => setHoveredNameKey(fileKey)}
                        onMouseLeave={() =>
                          setHoveredNameKey((prev) =>
                            prev === fileKey ? null : prev
                          )
                        }
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                            {f.name.split(".").pop()?.toUpperCase().slice(0, 4) ||
                              "FILE"}
                          </div>
                          <div className="text-left">
                            <div
                              className="flex flex-col"
                              onMouseEnter={() => setHoveredNameKey(fileKey)}
                              onMouseLeave={() =>
                                setHoveredNameKey((prev) =>
                                  prev === fileKey ? null : prev
                                )
                              }
                            >
                              {renderNameField(
                                fileKey,
                                f.name,
                                false,
                                hoveredNameKey === fileKey
                              )}
                              <p className="text-xs text-muted-foreground">
                                {formatBytes(f.size)}
                              </p>
                            </div>
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

      </div>

      {shareState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
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
                      prev ? { ...prev, visibility: e.target.value as ShareVisibility, result: null } : prev
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
                      prev ? { ...prev, permission: e.target.value as SharePermission, result: null } : prev
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
                  <label className="text-xs font-medium text-muted-foreground">Target email</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="user@example.com"
                    value={shareState.targetEmail}
                    onChange={(e) =>
                      setShareState((prev) => (prev ? { ...prev, targetEmail: e.target.value, result: null } : prev))
                    }
                  />
                </div>
              )}

              {shareState.visibility === "protected" && (
                <div className="grid gap-2">
                  <label className="text-xs font-medium text-muted-foreground">Allowed emails</label>
                  <textarea
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    rows={3}
                    placeholder="one@example.com, two@example.com"
                    value={shareState.allowedEmails}
                    onChange={(e) =>
                      setShareState((prev) => (prev ? { ...prev, allowedEmails: e.target.value, result: null } : prev))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma or newline separated. Viewers must be logged in with a matching email.
                  </p>
                </div>
              )}

              <div className="grid gap-2">
                <label className="text-xs font-medium text-muted-foreground">Expires in (seconds)</label>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Optional"
                  value={shareState.expiresIn}
                  onChange={(e) =>
                    setShareState((prev) => (prev ? { ...prev, expiresIn: e.target.value, result: null } : prev))
                  }
                />
              </div>
            </div>

            {shareState.result && (
              <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">Share created</p>
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
                      <div className="flex-1 truncate rounded-md border bg-background px-3 py-2 text-xs">
                        {shareState.result.access_url}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyText(shareState.result?.access_url || "", "Link copied")}
                      >
                        <Copy className="mr-1 h-4 w-4" /> Copy
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Token</span>
                  <code className="rounded-md bg-background px-2 py-1 text-xs">{shareState.result.token}</code>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={closeShare}>
                Cancel
              </Button>
              <Button onClick={submitShare} disabled={shareLoading}>
                {shareLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create share
              </Button>
            </div>
          </div>
        </div>
      )}

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
