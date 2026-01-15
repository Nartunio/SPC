import { useStoragePanel } from "../context";

export function ToastStack() {
  const { toasts, toastMs, dismissToast } = useStoragePanel();
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 left-4 pointer-events-auto flex w-full max-w-sm flex-col gap-2"
      style={{ zIndex: 1000 }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="button"
          tabIndex={0}
          onClick={() => dismissToast(t.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") dismissToast(t.id);
          }}
          className={`cursor-pointer overflow-hidden rounded-xl border bg-card px-4 py-3 text-sm shadow-xl animate-in fade-in slide-in-from-top-2 ${
            t.variant === "error"
              ? "border-destructive text-destructive"
              : "border-primary text-foreground"
          }`}
          title="Click to dismiss"
        >
          <div className="whitespace-pre-wrap wrap-break-word">{t.text}</div>
          {t.details && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background p-2 text-xs text-foreground">
              {t.details}
            </pre>
          )}
          <div className="mt-3 h-1 w-full overflow-hidden rounded bg-border/60">
            <div
              className={`toast-progress h-full ${
                t.variant === "error" ? "bg-destructive/40" : "bg-primary/40"
              }`}
              style={{ animationDuration: `${toastMs}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
