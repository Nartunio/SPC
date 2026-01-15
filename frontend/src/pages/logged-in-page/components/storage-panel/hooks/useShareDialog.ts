import { useCallback, useEffect, useState } from "react";

import type { SharePermission, ShareResult, ShareVisibility, Toast } from "../types";

type PushToast = (variant: Toast["variant"], text: string, details?: string) => void;

type ShareApi = {
  createShare: (payload: any) => Promise<{ ok: boolean; data: any }>;
  revokeShare: (shareId: string) => Promise<{ ok: boolean; data: any }>;
};

export type ShareDialogState = {
  key: string;
  isDir: boolean;
  visibility: ShareVisibility;
  permission: SharePermission;
  targetEmail: string;
  allowedEmails: string;
  expiresIn: string;
  result?: ShareResult | null;
};

export function useShareDialog({ api, pushToast }: { api: ShareApi; pushToast: PushToast }) {
  const [shareState, setShareState] = useState<ShareDialogState | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [ownedShares, setOwnedShares] = useState<Record<string, ShareResult>>({});

  useEffect(() => {
    if (!shareState) return;
    if (shareState.visibility !== "private" && shareState.permission !== "read") {
      setShareState({ ...shareState, permission: "read" });
    }
  }, [shareState?.visibility]);

  const openShare = useCallback(
    (key: string, isDir: boolean) => {
      const existing = ownedShares[key];
      setShareState({
        key,
        isDir,
        visibility: existing?.visibility || "private",
        permission: existing?.permission || "read",
        targetEmail: existing?.target_email || "",
        allowedEmails: (existing?.allowed_emails || []).join(", "),
        expiresIn: "",
        result: existing || null,
      });
    },
    [ownedShares]
  );

  const openShareFromResult = useCallback((share: ShareResult) => {
    setOwnedShares((prev) => ({ ...prev, [share.key]: share }));
    setShareState({
      key: share.key,
      isDir: Boolean((share as any).is_directory),
      visibility: share.visibility || "private",
      permission: share.permission || "read",
      targetEmail: share.target_email || "",
      allowedEmails: (share.allowed_emails || []).join(", "),
      expiresIn: "",
      result: share,
    });
  }, []);

  const closeShare = useCallback(() => {
    setShareLoading(false);
    setShareState(null);
  }, []);

  const submitShare = useCallback(async () => {
    if (!shareState) return;

    const wasExisting = Boolean(shareState.result);
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
      target_email:
        shareState.visibility === "private" ? shareState.targetEmail.trim() || undefined : undefined,
      allowed_emails: shareState.visibility === "protected" ? allowedEmails : undefined,
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
    setOwnedShares((prev) => ({ ...prev, [result.key]: result }));
    pushToast("success", wasExisting ? "Share updated" : "Share created");
  }, [api, pushToast, shareState]);

  const revokeCurrentShare = useCallback(async () => {
    if (!shareState?.result?.share_id) {
      pushToast("error", "No share to revoke");
      return;
    }

    setShareLoading(true);
    const res = await api.revokeShare(shareState.result.share_id);
    setShareLoading(false);

    if (!res.ok) {
      pushToast("error", JSON.stringify(res.data));
      return;
    }

    setOwnedShares((prev) => {
      const next = { ...prev };
      delete next[shareState.key];
      return next;
    });
    setShareState((prev) => (prev ? { ...prev, result: null } : prev));
    pushToast("success", "Share revoked");
  }, [api, pushToast, shareState]);

  return {
    shareState,
    setShareState,
    shareLoading,
    ownedShares,
    setOwnedShares,
    openShare,
    openShareFromResult,
    closeShare,
    submitShare,
    revokeCurrentShare,
  };
}
