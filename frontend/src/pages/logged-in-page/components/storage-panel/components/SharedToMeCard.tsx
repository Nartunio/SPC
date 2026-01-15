import { Download, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useStoragePanel } from "../context";

export function SharedToMeCard() {
  const { shares, pushToast } = useStoragePanel();
  const { sharedToMe: sharesList, sharedToMeLoading: loading } = shares;

  return (
    <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Shared to me</p>
          <p className="text-sm text-muted-foreground">Files other users shared with your account.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={shares.refreshSharedToMe} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Refresh
        </Button>
      </div>

      {!loading && (!sharesList || sharesList.length === 0) ? (
        <p className="text-sm text-muted-foreground">No shares found.</p>
      ) : (
        <div className="space-y-2">
          {(sharesList || []).map((s) => (
            <div
              key={s.share_id}
              className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.key}</span>
                  <Badge variant="secondary">{s.permission}</Badge>
                  {s.is_directory ? <Badge variant="outline">folder</Badge> : <Badge variant="outline">file</Badge>}
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
                  onClick={() => {
                    if (s.is_directory) return;
                    void shares.downloadSharedFile(s).catch((err) => {
                      pushToast("error", "Download failed", err instanceof Error ? err.message : String(err));
                    });
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
  );
}
