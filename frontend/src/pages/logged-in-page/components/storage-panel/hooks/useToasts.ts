import { useCallback, useEffect, useRef, useState } from "react";

import { TOAST_MS } from "../constants";
import type { Toast } from "../types";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (variant: Toast["variant"], text: string, details?: string) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;

      const toast: Toast = {
        id,
        variant,
        text,
        details,
        createdAt: Date.now(),
      };

      setToasts((prev) => [toast, ...prev]);

      const timer = window.setTimeout(() => {
        dismissToast(id);
      }, TOAST_MS);
      toastTimersRef.current.set(id, timer);
    },
    [dismissToast]
  );

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  return { toasts, pushToast, dismissToast, toastMs: TOAST_MS };
}
