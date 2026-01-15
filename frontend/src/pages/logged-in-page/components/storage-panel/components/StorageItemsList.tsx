import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Folder, History, Share2, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { formatBytes, formatDateTime } from "../format";
import { useStoragePanel } from "../context";

export function StorageItemsList() {
  const {
    api,
    pushToast,
    refresh,
    list,
    currentPath,
    setCurrentPath,
    joinedPath,
    fullKey,
    drag,
    uploads,
    share,
    versions,
    onDownload,
    onDelete,
    onDownloadFolderZip,
  } = useStoragePanel();

  const dragOverFolder = drag.dragOverFolder;
  const onFolderDragOver = drag.handleFolderDragOver;
  const onFolderDragLeave = drag.handleFolderDragLeave;
  const onFolderDrop = drag.handleFolderDrop;
  const draggedItem = drag.draggedItem;
  const onItemDragStart = drag.handleItemDragStart;
  const onItemDragEnd = drag.handleItemDragEnd;
  const onUploadFiles = uploads.uploadFiles;
  const onMoveItem = drag.moveItem;
  const ownedShares = share.ownedShares;
  const onOpenShare = share.openShare;
  const onShowVersions = versions.showVersions;

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingKey && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingKey]);

  const startRename = useCallback((key: string, name: string) => {
    setEditingKey(key);
    setEditingValue(name);
  }, []);

  const commitRename = useCallback(
    async (key: string) => {
      const newName = editingValue.trim();
      const currentName = key.replace(/\/$/, "").split("/").pop() || "";

      if (!newName) return void pushToast("error", "Name cannot be empty");
      if (newName === currentName) {
        setEditingKey(null);
        setEditingValue("");
        return;
      }

      const parts = key.replace(/\/$/, "").split("/");
      parts.pop();
      const parent = parts.join("/");

      const res = await api.rename(key, parent, newName);
      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));

      pushToast("success", `Renamed to ${newName}`);
      setEditingKey(null);
      setEditingValue("");
      void refresh(currentPath);
    },
    [api, currentPath, editingValue, pushToast, refresh]
  );

  const renderNameField = useCallback(
    (key: string, name: string) => {
      const isEditing = editingKey === key;
      if (isEditing) {
        return (
          <input
            ref={editInputRef}
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename(key);
              } else if (e.key === "Escape") {
                setEditingKey(null);
                setEditingValue("");
              }
            }}
            onBlur={() => {
              void commitRename(key);
            }}
            className="w-full min-w-0 bg-transparent text-sm font-medium leading-none h-6 flex items-center rounded border border-primary px-2 py-0 focus:outline-none focus:ring-1 focus:ring-primary"
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

  if (!list) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
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
            onDragOver={(e) => onFolderDragOver(e, "..")} 
            onDragLeave={onFolderDragLeave}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();

              const parts = currentPath.split("/").filter(Boolean);
              const parentPath = parts.slice(0, -1).join("/");

              const files = Array.from(e.dataTransfer.files || []);
              if (files.length > 0) {
                onUploadFiles(files, parentPath || undefined);
              } else if (draggedItem) {
                onMoveItem(draggedItem.key, parentPath);
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
                <p className="text-xs text-muted-foreground">Parent folder</p>
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
              onDragStart={(e) => onItemDragStart(e, "folder", dirKey)}
              onDragEnd={onItemDragEnd}
              className={`group flex items-center justify-between rounded-lg border px-3 py-2 transition select-none cursor-pointer ${
                dragOverFolder === d.name
                  ? "border-primary bg-primary/5"
                  : "hover:border-primary"
              }`}
              onDragOver={(e) => onFolderDragOver(e, d.name)}
              onDragLeave={onFolderDragLeave}
              onDrop={(e) => onFolderDrop(e, joinedPath(d.name))}
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
                          onOpenShare(fullKey(d.name, true), true);
                        }}
                      >
                        shared
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Folder</p>
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
                    onClick={() => onDownloadFolderZip(joinedPath(d.name))}
                    title="Download as ZIP"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onOpenShare(fullKey(d.name, true), true)}
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
              onDragStart={(e) => onItemDragStart(e, "file", fileKey)}
              onDragEnd={onItemDragEnd}
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
                          onOpenShare(fullKey(f.name), false);
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
                  onClick={() => onOpenShare(fullKey(f.name), false)}
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

      {!list.directories?.length && !list.files?.length && (
        <div className="rounded-lg px-4 py-6 text-center text-sm text-muted-foreground">
          No files found
        </div>
      )}
    </div>
  );
}
