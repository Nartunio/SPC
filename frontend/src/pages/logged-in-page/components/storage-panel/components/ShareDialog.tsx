import { Copy, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { SharePermission, ShareVisibility } from "../types";
import { useStoragePanel } from "../context";

export function ShareDialog() {
  const { share, copyText } = useStoragePanel();
  const state = share.shareState;
  if (!state) return null;

  const loading = share.shareLoading;
  const setState = (updater: (prev: any) => any) => share.setShareState((prev) => (prev ? updater(prev) : prev));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm backdrop-brightness-75">
      <div className="w-full max-w-xl space-y-4 rounded-xl border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Share</p>
            <p className="text-sm font-semibold break-all">{state.key}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={share.closeShare}>
            Close
          </Button>
        </div>

        <div className="grid gap-3">
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">Visibility</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={state.visibility}
              onChange={(e) =>
                setState((prev) => ({
                  ...prev,
                  visibility: e.target.value as ShareVisibility,
                }))
              }
            >
              <option value="private">Private (specific user)</option>
              <option value="public">Public link</option>
              <option value="protected">Protected (allowed emails)</option>
            </select>
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">Permission</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={state.visibility !== "private" || state.isDir}
              value={state.permission}
              onChange={(e) =>
                setState((prev) => ({
                  ...prev,
                  permission: e.target.value as SharePermission,
                }))
              }
            >
              <option value="read">Read only</option>
              <option value="read-write">Read &amp; write</option>
            </select>
            {state.visibility !== "private" && (
              <p className="text-xs text-muted-foreground">Public and protected links are limited to read-only.</p>
            )}
            {state.isDir && (
              <p className="text-xs text-muted-foreground">Directory shares are read-only and meant for browsing/zip downloads.</p>
            )}
          </div>

          {state.visibility === "private" && (
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">Target email</label>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="user@example.com"
                value={state.targetEmail}
                onChange={(e) =>
                  setState((prev) => ({
                    ...prev,
                    targetEmail: e.target.value,
                  }))
                }
              />
            </div>
          )}

          {state.visibility === "protected" && (
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">Allowed emails</label>
              <textarea
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                rows={3}
                placeholder="one@example.com, two@example.com"
                value={state.allowedEmails}
                onChange={(e) =>
                  setState((prev) => ({
                    ...prev,
                    allowedEmails: e.target.value,
                  }))
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
              value={state.expiresIn}
              onChange={(e) =>
                setState((prev) => ({
                  ...prev,
                  expiresIn: e.target.value,
                }))
              }
            />
          </div>
        </div>

        {state.result && (
          <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Share active</p>
              {state.result.expires_at && (
                <span className="text-xs text-muted-foreground">Expires {state.result.expires_at}</span>
              )}
            </div>

            {state.result.access_url && (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Link</span>
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 break-all rounded-md border bg-background px-3 py-2 text-xs">
                    {state.result.access_url}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyText(state.result?.access_url || "", "Link copied")}
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
                  {state.result?.token || ""}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyText(state.result?.token || "", "Token copied")}
                  disabled={!state.result?.token}
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
                onClick={share.revokeCurrentShare}
                disabled={loading}
              >
                Revoke share
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={share.closeShare}>
            Cancel
          </Button>
          <Button onClick={share.submitShare} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {state.result ? "Update share" : "Create share"}
          </Button>
        </div>
      </div>
    </div>
  );
}
