import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LogLimitMode, Toast } from "../types";

type Api = {
  logs: (
    limit: number,
    offset: number,
    action?: string,
    fromDate?: string,
    toDate?: string
  ) => Promise<{ ok: boolean; data: any }>;
};

type PushToast = (variant: Toast["variant"], text: string, details?: string) => void;

type Options = {
  api: Api;
  pushToast: PushToast;
  isActive: boolean;
  dynamicPageSize: number;
};

export function useActivityLogs({ api, pushToast, isActive, dynamicPageSize }: Options) {
  const [logLimitMode, setLogLimitMode] = useState<LogLimitMode>("dynamic");
  const [logActionFilter, setLogActionFilter] = useState<string>("");
  const [logFromDate, setLogFromDate] = useState<string>("");
  const [logToDate, setLogToDate] = useState<string>("");

  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsHasMore, setLogsHasMore] = useState(false);

  const logsScrollRef = useRef<HTMLDivElement | null>(null);
  const logsSentinelRef = useRef<HTMLDivElement | null>(null);

  const logsMetaRef = useRef<{ length: number; loading: boolean; hasMore: boolean }>({
    length: 0,
    loading: false,
    hasMore: false,
  });

  useEffect(() => {
    logsMetaRef.current.length = logs.length;
    logsMetaRef.current.loading = logsLoading;
    logsMetaRef.current.hasMore = logsHasMore;
  }, [logs.length, logsHasMore, logsLoading]);

  const logActionOptions = useMemo(() => {
    const base = [
      "list",
      "upload",
      "create_dir",
      "move",
      "move_prefix",
      "move_prefix_partial",
      "delete",
      "delete_prefix",
      "download_link",
      "download_folder_zip",
      "restore_version",
      "share_create",
      "share_update",
      "share_revoke",
      "share_access_allowed",
      "share_access_denied",
      "share_download_intent",
    ];
    const seen = new Set<string>(base);
    for (const l of logs) {
      const a = String((l as any)?.action || "").trim();
      if (a) seen.add(a);
    }
    return Array.from(seen).sort();
  }, [logs]);

  const loadLogs = useCallback(
    async (options?: { reset?: boolean }) => {
      const reset = options?.reset ?? true;
      if (logsMetaRef.current.loading) return;

      // Guard immediately to avoid double-load from rapid events.
      logsMetaRef.current.loading = true;

      setLogsLoading(true);
      setLogsError(null);

      const mode = logLimitMode;
      const isDynamic = mode === "dynamic";
      const fixedLimit = mode === "50" ? 50 : mode === "100" ? 100 : 200;
      const offset = isDynamic && !reset ? logsMetaRef.current.length : 0;
      const requestLimit = isDynamic ? dynamicPageSize + 1 : fixedLimit;

      const res = await api.logs(
        requestLimit,
        offset,
        logActionFilter || undefined,
        logFromDate || undefined,
        logToDate || undefined
      );
      setLogsLoading(false);
      logsMetaRef.current.loading = false;

      if (!res.ok) {
        const msg = "Failed to load activity log";
        setLogsError(msg);
        pushToast("error", msg, JSON.stringify(res.data));
        return;
      }

      const raw = ((res.data as any).logs || []) as any[];

      if (isDynamic) {
        const hasMore = raw.length > dynamicPageSize;
        const page = hasMore ? raw.slice(0, dynamicPageSize) : raw;
        setLogs((prev) => (reset ? page : [...prev, ...page]));
        setLogsHasMore(hasMore);
      } else {
        setLogs(raw);
        setLogsHasMore(false);
      }
    },
    [api, dynamicPageSize, logActionFilter, logFromDate, logLimitMode, logToDate, pushToast]
  );

  // Load activity log when Activity tab is active.
  useEffect(() => {
    if (!isActive) return;
    loadLogs({ reset: true });
  }, [isActive, loadLogs]);

  // Dynamic mode: load more as the user scrolls to the bottom.
  useEffect(() => {
    if (!isActive) return;
    if (logLimitMode !== "dynamic") return;
    if (!logsSentinelRef.current) return;

    const root = logsScrollRef.current;
    const sentinel = logsSentinelRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (logsMetaRef.current.loading) return;
        if (!logsMetaRef.current.hasMore) return;
        loadLogs({ reset: false });
      },
      { root, threshold: 0.5 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isActive, loadLogs, logLimitMode]);

  return {
    logs,
    logsLoading,
    logsError,
    logsHasMore,
    logsScrollRef,
    logsSentinelRef,

    logActionOptions,

    logLimitMode,
    setLogLimitMode,
    logActionFilter,
    setLogActionFilter,
    logFromDate,
    setLogFromDate,
    logToDate,
    setLogToDate,

    loadLogs,
  };
}
