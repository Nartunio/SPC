import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStoragePanel } from "../context";

import type { LogLimitMode } from "../types";

export function ActivityLogCard() {
  const {
    activity: {
      logLimitMode,
      setLogLimitMode,
      logActionFilter,
      setLogActionFilter,
      logActionOptions,
      logFromDate,
      setLogFromDate,
      logToDate,
      setLogToDate,
      loadLogs,
      logs,
      logsLoading,
      logsError,
      logsHasMore,
      logsScrollRef,
      logsSentinelRef,
    },
  } = useStoragePanel();

  return (
    <div className="max-w-full overflow-x-hidden rounded-xl border bg-card/60 p-4 shadow-sm">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold">Activity Log</p>
        <div className="w-full max-w-full overflow-x-auto sm:w-auto">
          <div className="flex flex-nowrap items-center justify-end gap-2 whitespace-nowrap">
            <label className="shrink-0 text-xs text-muted-foreground">Show</label>
            <select
              value={logLimitMode}
              onChange={(e) => setLogLimitMode(e.target.value as LogLimitMode)}
              className="h-8 w-28 shrink-0 rounded-md border bg-background px-2 text-sm"
              aria-label="Activity log limit"
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="dynamic">Dynamic</option>
            </select>
            <label className="shrink-0 text-xs text-muted-foreground">Type</label>
            <select
              value={logActionFilter}
              onChange={(e) => setLogActionFilter(e.target.value)}
              className="h-8 w-44 shrink-0 rounded-md border bg-background px-2 text-sm"
              aria-label="Activity log type"
            >
              <option value="">All</option>
              {logActionOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <label className="shrink-0 text-xs text-muted-foreground">From</label>
            <input
              type="date"
              value={logFromDate}
              onChange={(e) => setLogFromDate(e.target.value)}
              className="h-8 w-38 shrink-0 rounded-md border bg-background px-2 text-sm"
              aria-label="Activity log start date"
            />
            <label className="shrink-0 text-xs text-muted-foreground">To</label>
            <input
              type="date"
              value={logToDate}
              onChange={(e) => setLogToDate(e.target.value)}
              className="h-8 w-38 shrink-0 rounded-md border bg-background px-2 text-sm"
              aria-label="Activity log end date"
            />
            <Button className="shrink-0" variant="ghost" size="sm" onClick={() => loadLogs({ reset: true })}>
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div ref={logsScrollRef} className="max-h-64 overflow-y-auto overflow-x-hidden space-y-1 text-sm">
        {logsLoading && logs.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!logsLoading && logsError && <p className="text-sm text-muted-foreground">{logsError}</p>}

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
          const renameText = isRename ? `rename ${extra.old_name} -> ${extra.new_name}` : "";
          const moveText =
            !isRename && fromPath && toPath && fromPath !== toPath ? `move ${fromPath} -> ${toPath}` : "";

          return (
            <div
              key={`${l.created_at || ""}-${l.action || ""}-${l.key || ""}-${idx}`}
              className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50"
            >
              <span className="shrink-0 text-xs text-muted-foreground">{l.created_at}</span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="block truncate">
                  {l.action} {l.key || ""}
                  {renameText || moveText ? (
                    <span className="ml-2 text-xs text-muted-foreground">({renameText || moveText})</span>
                  ) : null}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">{l.email || "anonymous"}</span>
              </span>
              <span className={(l.success ? "text-green-600" : "text-red-600") + " shrink-0"}>
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
}
