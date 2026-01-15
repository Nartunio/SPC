import { Copy, Loader2, Pencil, Share2, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useStoragePanel } from "../context";

export function MySharesCard() {
  const { shares, share, copyText } = useStoragePanel();
  const { mySharesList: sharesList, mySharesLoading: loading } = shares;

  return (
    <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">My shares</p>
          <p className="text-sm text-muted-foreground">Links you created to share files/folders.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={shares.refreshMyShares} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Refresh
        </Button>
      </div>

      {!loading && (!sharesList || sharesList.length === 0) ? (
        <p className="text-sm text-muted-foreground">You haven’t created any shares yet.</p>
      ) : (
        <div className="space-y-2">
          {(sharesList || []).map((s) => {
            const sharePageUrl = `${window.location.origin}/share?token=${encodeURIComponent(s.token)}`;

            return (
              <div
                key={s.share_id}
                className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.key}</span>
                    <Badge variant="secondary">{s.visibility}</Badge>
                    <Badge variant="outline">{s.permission}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {s.expires_at ? `Expires: ${s.expires_at}` : "No expiry"}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => share.openShareFromResult(s)}>
                    <Pencil className="mr-2 h-4 w-4" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyText(sharePageUrl, "Share link copied")}
                  >
                    <Copy className="mr-2 h-4 w-4" /> Copy
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => window.open(sharePageUrl, "_blank")}>
                    <Share2 className="mr-2 h-4 w-4" /> Open
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      const ok = await shares.revokeMyShare(s);
                      if (ok) await shares.refreshMyShares();
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
  );
}
