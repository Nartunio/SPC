import { useCallback, useState } from "react";

import type { SharedWithMeShare, ShareResult, Toast } from "../types";

type Api = {
  listShared: () => Promise<{ ok: boolean; data: any }>;
  sharedDownload: (shareId: string) => Promise<{ ok: boolean; data: any }>;
  listOwnedShares: (path?: string) => Promise<{ ok: boolean; data: any }>;
  revokeShare: (shareId: string) => Promise<{ ok: boolean; data: any }>;
};

type PushToast = (variant: Toast["variant"], text: string, details?: string) => void;

export function useSharePanels({ api, pushToast }: { api: Api; pushToast: PushToast }) {
  const [sharedToMe, setSharedToMe] = useState<SharedWithMeShare[] | null>(null);
  const [sharedToMeLoading, setSharedToMeLoading] = useState(false);

  const [mySharesList, setMySharesList] = useState<ShareResult[] | null>(null);
  const [mySharesLoading, setMySharesLoading] = useState(false);

  const refreshSharedToMe = useCallback(async () => {
    setSharedToMeLoading(true);
    const res = await api.listShared();
    setSharedToMeLoading(false);
    if (!res.ok) {
      pushToast("error", "Failed to load shared items", JSON.stringify(res.data));
      return;
    }
    setSharedToMe(((res.data as any)?.shares || []) as SharedWithMeShare[]);
  }, [api, pushToast]);

  const refreshMyShares = useCallback(async () => {
    setMySharesLoading(true);
    const res = await api.listOwnedShares();
    setMySharesLoading(false);
    if (!res.ok) {
      pushToast("error", "Failed to load your shares", JSON.stringify(res.data));
      return;
    }
    setMySharesList(((res.data as any)?.shares || []) as ShareResult[]);
  }, [api, pushToast]);

  const downloadSharedFile = useCallback(
    async (share: SharedWithMeShare) => {
      if (share.is_directory) return;
      const res = await api.sharedDownload(share.share_id);
      if (!res.ok) {
        pushToast("error", "Download failed", JSON.stringify(res.data));
        return;
      }
      const url = (res.data as any)?.url;
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.download = "";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    },
    [api, pushToast]
  );

  const revokeMyShare = useCallback(
    async (share: ShareResult) => {
      const res = await api.revokeShare(share.share_id);
      if (!res.ok) {
        pushToast("error", "Failed to revoke share", JSON.stringify(res.data));
        return false;
      }
      pushToast("success", "Share revoked");
      return true;
    },
    [api, pushToast]
  );

  return {
    sharedToMe,
    setSharedToMe,
    sharedToMeLoading,
    refreshSharedToMe,
    downloadSharedFile,

    mySharesList,
    setMySharesList,
    mySharesLoading,
    refreshMyShares,
    revokeMyShare,
  };
}
