import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth0 } from "@auth0/auth0-react";

import { createApi } from "@/lib/api";

import { LOG_DYNAMIC_PAGE_SIZE } from "./constants";

import { useActivityLogs } from "./hooks/useActivityLogs";
import { useChunkedUploads } from "./hooks/useChunkedUploads";
import { useDragAndMove } from "./hooks/useDragAndMove";
import { useShareDialog } from "./hooks/useShareDialog";
import { useSharePanels } from "./hooks/useSharePanels";
import { useToasts } from "./hooks/useToasts";

import type { ListResponse, PanelView, ShareResult, Toast } from "./types";

type Ctx = ReturnType<typeof useStoragePanelState>;

const StoragePanelContext = createContext<Ctx | null>(null);

export function useStoragePanel() {
  const ctx = useContext(StoragePanelContext);
  if (!ctx)
    throw new Error("useStoragePanel must be used within StoragePanelProvider");
  return ctx;
}

export function StoragePanelProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useStoragePanelState();
  return (
    <StoragePanelContext.Provider value={value}>
      {children}
    </StoragePanelContext.Provider>
  );
}

function useStoragePanelState() {
  const { getAccessTokenSilently, loginWithRedirect, getIdTokenClaims } =
    useAuth0();

  const getTokenWithRenew = useCallback(async () => {
    try {
      return await getAccessTokenSilently({
        authorizationParams: {
          audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
          scope: "openid profile email offline_access",
        },
      });
    } catch (err: any) {
      const msg = err?.message || "";
      if (
        msg.includes("Missing Refresh Token") ||
        msg.includes("login_required") ||
        msg.includes("consent_required")
      ) {
        await loginWithRedirect({
          authorizationParams: {
            redirect_uri: `${window.location.origin}/callback`,
            audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
            scope: "openid profile email offline_access",
            prompt: "login",
          },
        });
      }
      throw err;
    }
  }, [getAccessTokenSilently, loginWithRedirect]);

  const getIdTokenRaw = useCallback(async () => {
    try {
      return (await getIdTokenClaims())?.__raw;
    } catch {
      return undefined;
    }
  }, [getIdTokenClaims]);

  const api = useMemo(
    () => createApi(getTokenWithRenew, getIdTokenRaw),
    [getTokenWithRenew, getIdTokenRaw]
  );

  const [panelView, setPanelView] = useState<PanelView>("storage");
  const [currentPath, setCurrentPath] = useState("");

  const { toasts, pushToast, dismissToast, toastMs } = useToasts();

  const [list, setList] = useState<ListResponse | null>(null);
  const listRef = useRef<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const share = useShareDialog({ api, pushToast });
  const shares = useSharePanels({ api, pushToast });
  const setOwnedShares = share.setOwnedShares;

  const refresh = useCallback(
    async (path?: string) => {
      setLoading(true);
      const [res, shareRes] = await Promise.all([
        api.list(path || undefined),
        api.listOwnedShares(path || undefined),
      ]);
      setLoading(false);

      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));

      setList(res.data as ListResponse);
      listRef.current = res.data as ListResponse;

      if (shareRes.ok) {
        const map: Record<string, ShareResult> = {};
        ((shareRes.data as any).shares || []).forEach(
          (s: ShareResult) => (map[s.key] = s)
        );
        setOwnedShares(map);
      }
    },
    [api, pushToast, setOwnedShares]
  );

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  useEffect(() => {
    if (panelView !== "storage") return;
    setList(null);
    void refresh(currentPath);
  }, [currentPath, panelView, refresh]);

  useEffect(() => {
    if (panelView === "shared_to_me") {
      shares.setSharedToMe(null);
      void shares.refreshSharedToMe();
    }
    if (panelView === "my_shares") {
      shares.setMySharesList(null);
      void shares.refreshMyShares();
    }
  }, [panelView, shares]);

  const uploads = useChunkedUploads({
    api,
    pushToast,
    getTokenWithRenew,
    getIdTokenRaw,
    panelView,
    currentPath,
    refresh,
    listRef,
  });

  const uploadFiles = useCallback(
    (files: File[], targetPath?: string) =>
      uploads.uploadFiles(files, targetPath),
    [uploads]
  );
  const drag = useDragAndMove({
    api,
    pushToast,
    uploadFiles,
    refresh,
    currentPath,
  });

  const activity = useActivityLogs({
    api,
    pushToast,
    isActive: panelView === "activity",
    dynamicPageSize: LOG_DYNAMIC_PAGE_SIZE,
  });

  const versions = useVersions({
    api,
    pushToast,
    refresh: () => refresh(currentPath),
  });

  const copyText = useCallback(
    async (text: string, label = "Copied") => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast("success", label);
      } catch (err) {
        pushToast(
          "error",
          "Could not copy",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [pushToast]
  );

  const onDownload = useCallback(
    async (key: string) => {
      const res = await api.downloadLink(key);
      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));
      const url = (res.data as any).url;
      if (!url) return;
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [api, pushToast]
  );

  const onDelete = useCallback(
    async (key: string) => {
      if (!confirm(`Delete ${key}?`)) return;
      const res = await api.del(key);
      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));
      void refresh(currentPath);
    },
    [api, currentPath, pushToast, refresh]
  );

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

  const onNewFolder = useCallback(async () => {
    if (creatingDir) return;
    const base = "New folder";
    const existing = new Set([
      ...(list?.directories || []).map((d) => d.name),
      ...(list?.files || []).map((f) => f.name),
    ]);
    let name = base;
    if (existing.has(base)) {
      let i = 1;
      while (existing.has(`${base} ${i}`)) i += 1;
      name = `${base} ${i}`;
    }

    setCreatingDir(true);
    const res = await api.createDir(fullKey(name, true).replace(/\/$/, ""));
    setCreatingDir(false);
    if (!res.ok) return void pushToast("error", JSON.stringify(res.data));
    await refresh(currentPath);
  }, [api, creatingDir, currentPath, fullKey, list, pushToast, refresh]);

  const onDownloadFolderZip = useCallback(
    async (path: string) => {
      try {
        const token = await getTokenWithRenew();
        const idToken = await getIdTokenRaw();
        const base = String(
          (import.meta as any).env.VITE_API_BASE || "http://localhost:8000"
        ).replace(/\/$/, "");
        const url = `${base}/storage/download-zip?path=${encodeURIComponent(
          path
        )}`;

        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(idToken ? { "X-Auth0-Id-Token": idToken } : {}),
          },
        });

        if (!res.ok)
          return void pushToast(
            "error",
            "Download failed",
            (await res.text()) || `HTTP ${res.status}`
          );

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `${path.split("/").pop() || "folder"}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        pushToast(
          "error",
          "Download failed",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [getIdTokenRaw, getTokenWithRenew, pushToast]
  );

  return {
    api,
    panelView,
    setPanelView,
    currentPath,
    setCurrentPath,

    toasts,
    pushToast,
    dismissToast,
    toastMs,

    list,
    listRef,
    loading,
    refresh,

    creatingDir,
    onNewFolder,

    uploads,
    fileRef,

    drag,

    share,
    shares,

    activity,

    versions,

    copyText,

    onDownload,
    onDelete,
    onDownloadFolderZip,
    fullKey,
    joinedPath,
  };
}

function useVersions({
  api,
  pushToast,
  refresh,
}: {
  api: any;
  pushToast: (
    variant: Toast["variant"],
    text: string,
    details?: string
  ) => void;
  refresh: () => void | Promise<void>;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);

  const showVersions = useCallback(
    async (key: string) => {
      setSelectedKey(key);
      const res = await api.versions(key);
      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));
      setVersions((res.data as any).versions || []);
    },
    [api, pushToast]
  );

  const closeVersions = useCallback(() => {
    setVersions(null);
    setSelectedKey(null);
  }, []);

  const restoreVersion = useCallback(
    async (version: number) => {
      if (!selectedKey) return;
      const res = await api.restoreVersion(selectedKey, version);
      if (!res.ok) return void pushToast("error", JSON.stringify(res.data));
      closeVersions();
      void refresh();
    },
    [api, closeVersions, pushToast, refresh, selectedKey]
  );

  return { selectedKey, versions, showVersions, closeVersions, restoreVersion };
}
