import { FolderPlus, Loader2, RefreshCcw, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";

import { StoragePanelProvider, useStoragePanel } from "./context";
import { formatBytes } from "./format";

import { ActivityLogCard } from "./components/ActivityLogCard";
import { MySharesCard } from "./components/MySharesCard";
import { ShareDialog } from "./components/ShareDialog";
import { SharedToMeCard } from "./components/SharedToMeCard";
import { StorageItemsList } from "./components/StorageItemsList";
import { ToastStack } from "./components/ToastStack";
import { UnfinishedUploadsCard } from "./components/UnfinishedUploadsCard";

export default function StoragePanel() {
  return (
    <StoragePanelProvider>
      <StoragePanelInner />
    </StoragePanelProvider>
  );
}

function StoragePanelInner() {
  const {
    panelView,
    setPanelView,
    list,
    loading,
    refresh,
    currentPath,
    creatingDir,
    onNewFolder,
    uploads,
    fileRef,
    drag,
    versions,
  } = useStoragePanel();

  return (
    <div className="w-full">
      <ToastStack />
      <ShareDialog />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant={panelView === "storage" ? "default" : "outline"} size="sm" onClick={() => setPanelView("storage")}>
          Storage
        </Button>
        <Button variant={panelView === "shared_to_me" ? "default" : "outline"} size="sm" onClick={() => setPanelView("shared_to_me")}>
          Shared to me
        </Button>
        <Button variant={panelView === "my_shares" ? "default" : "outline"} size="sm" onClick={() => setPanelView("my_shares")}>
          My shares
        </Button>
        <Button variant={panelView === "activity" ? "default" : "outline"} size="sm" onClick={() => setPanelView("activity")}>
          Activity
        </Button>
      </div>

      {panelView === "storage" ? (
        <div className="grid gap-4">
          <UnfinishedUploadsCard />

          <div
            className={`rounded-xl border-2 transition ${drag.dragActive ? "border-primary border-dashed bg-primary/5" : "border bg-card/60"}`}
            onDragOver={drag.handleDragOver}
            onDragLeave={drag.handleDragLeave}
            onDrop={drag.handleDrop}
          >
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">Items</p>
                  <p className="text-sm text-muted-foreground">
                    {drag.dragActive
                      ? "Drop files here to upload"
                      : "Click folders to open. Drag files here or to folders."}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={onNewFolder} disabled={creatingDir || loading}>
                    {creatingDir ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderPlus className="mr-2 h-4 w-4" />}
                    New folder
                  </Button>

                  <input
                    type="file"
                    ref={fileRef}
                    multiple
                    className="hidden"
                    onChange={(e) =>
                      uploads.handleFileInputChange(e.target.files, currentPath || undefined, () => {
                        if (fileRef.current) fileRef.current.value = "";
                      })
                    }
                  />

                  <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploads.uploading}>
                    {uploads.uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                    Upload
                  </Button>

                  <Button variant="secondary" size="sm" onClick={() => refresh(currentPath)} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {list ? <StorageItemsList /> : <div className="text-sm text-muted-foreground">Loading…</div>}
            </div>
          </div>

          {versions.versions && versions.selectedKey && (
            <div className="rounded-xl border bg-card/80 p-4 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Versions</p>
                  <p className="text-xs text-muted-foreground">{versions.selectedKey}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={versions.closeVersions}>
                  Close
                </Button>
              </div>
              <div className="space-y-2">
                {versions.versions.map((v: any) => (
                  <div key={v.version} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <div className="text-sm">
                      v{v.version} • {formatBytes(v.size)} • {v.created_at}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => versions.restoreVersion(v.version)}>
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : panelView === "shared_to_me" ? (
        <SharedToMeCard />
      ) : panelView === "my_shares" ? (
        <MySharesCard />
      ) : (
        <ActivityLogCard />
      )}
    </div>
  );
}
