import { useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { createApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldAlert, CheckCircle2, Link as LinkIcon, Download, LogIn, FolderDown, ArrowLeft, Folder, File } from "lucide-react";

function useShareToken(): string | null {
  const [params] = useSearchParams();
  const token = params.get("token");
  return token;
}

export default function ShareAccessPage() {
  const token = useShareToken();
  const navigate = useNavigate();
  const { isAuthenticated, loginWithRedirect, getAccessTokenSilently } = useAuth0();
  const api = useMemo(() => createApi(getAccessTokenSilently), [getAccessTokenSilently]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    | { state: "ready"; key: string; visibility: string; is_directory: boolean; url?: string | null; zip_url?: string | null; expires_at?: string | null; path?: string; directories?: { name: string; is_empty?: boolean }[]; files?: { name: string; size?: number; last_modified?: string; url?: string }[] }
    | { state: "unauthorized"; reason: string }
    | { state: "forbidden"; reason: string }
    | { state: "notfound" }
  >({ state: "notfound" });
  const [currentPath, setCurrentPath] = useState<string>("");
  const { navigateInto, navigateUp } = useDirectoryNav(setCurrentPath, currentPath);

  useEffect(() => {
    if (!token) {
      setError("Missing token");
      return;
    }
    let cancelled = false;
    async function load(nextPath?: string) {
      setLoading(true);
      setError(null);
      const res = await api.accessShare(token, { presign: true, path: nextPath ?? currentPath });
      setLoading(false);
      if (cancelled) return;

      if (!res.ok) {
        const reason = (res.data as any)?.error || "Access denied";
        if (res.status === 401) {
          setStatus({ state: "unauthorized", reason });
        } else if (res.status === 403) {
          setStatus({ state: "forbidden", reason });
        } else if (res.status === 404) {
          setStatus({ state: "notfound" });
        } else {
          setError(JSON.stringify(res.data));
        }
        return;
      }

      const data = res.data as any;
      setStatus({
        state: "ready",
        key: data.key,
        visibility: data.visibility,
        is_directory: data.is_directory,
        url: data.url,
        zip_url: data.zip_url,
        expires_at: data.expires_at,
        path: data.path || "",
        directories: data.directories || [],
        files: data.files || [],
      });
      setCurrentPath(data.path || "");
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [api, token, currentPath]);

  const needsLogin = status.state === "unauthorized";

  const content = (() => {
    if (!token) {
      return <ErrorBox title="Missing token" />;
    }
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking link…
        </div>
      );
    }
    if (error) return <ErrorBox title="Error" message={error} />;

    if (status.state === "notfound") return <ErrorBox title="Link not found" message="This share link is invalid or was revoked." />;
    if (status.state === "unauthorized")
      return (
        <ErrorBox
          title="Sign in required"
          message="This protected link requires you to sign in with an allowed account."
          actionLabel="Sign in"
          onAction={() => loginWithRedirect({ appState: { returnTo: window.location.pathname + window.location.search } })}
          icon={<LogIn className="h-5 w-5" />}
        />
      );
    if (status.state === "forbidden") return <ErrorBox title="Access denied" message="You do not have access to this link." />;
    if (status.state === "ready") {
      const hasEntries = (status.directories?.length || 0) > 0 || (status.files?.length || 0) > 0;
      return (
        <div className="space-y-4 rounded-xl border bg-card/70 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Shared {status.is_directory ? "folder" : "file"}</p>
              <p className="text-lg font-semibold break-all">{status.key}</p>
              <p className="text-xs text-muted-foreground">Visibility: {status.visibility}</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          </div>

          {status.is_directory ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4" />
                  <span className="text-xs">{currentPath || "/"}</span>
                </div>
                {currentPath && (
                  <Button variant="outline" size="sm" onClick={() => navigateUp()}>
                    <ArrowLeft className="mr-1 h-3 w-3" /> Up
                  </Button>
                )}
              </div>
              <div className="space-y-2 rounded-lg border bg-background/60 p-3">
                {(status.directories?.length ? status.directories : []).map((d) => (
                  <button
                    key={d.name}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-muted"
                    onClick={() => navigateInto(d.name)}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <Folder className="h-4 w-4 text-primary" />
                      <span>{d.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">Open</span>
                  </button>
                ))}
                {(status.files?.length ? status.files : []).map((f) => (
                  <div key={f.name} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
                    <div className="flex items-center gap-2 text-sm">
                      <File className="h-4 w-4" />
                      <span>{f.name}</span>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => f.url && triggerDownload(f.url, f.name)}>
                      <Download className="mr-1 h-3 w-3" /> Download
                    </Button>
                  </div>
                ))}
                {!hasEntries && (
                  <p className="text-sm text-muted-foreground">Empty folder</p>
                )}
              </div>
              {status.zip_url && hasEntries && (
                <Button className="w-full" onClick={() => triggerDownload(status.zip_url, `${status.key.replace(/\/$/, "") || "folder"}.zip`)}>
                  <FolderDown className="mr-2 h-4 w-4" /> Download folder (.zip)
                </Button>
              )}
            </div>
          ) : status.url ? (
            <Button className="w-full" onClick={() => triggerDownload(status.url, status.key)}>
              <Download className="mr-2 h-4 w-4" /> Download
            </Button>
          ) : (
            <ErrorBox title="Link unavailable" message="Could not generate download link." />
          )}

          {status.expires_at && (
            <p className="text-xs text-muted-foreground">Expires at {status.expires_at}</p>
          )}
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-10 sm:py-14">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LinkIcon className="h-4 w-4" />
            <span>Shared link</span>
          </div>
          <Button variant="ghost" onClick={() => navigate("/")}>Home</Button>
        </header>

        <main className="flex-1">
          <div className="mb-6 space-y-1">
            <h1 className="text-2xl font-semibold text-white">Access shared content</h1>
            <p className="text-sm text-muted-foreground">
              {isAuthenticated ? "You are signed in." : "You may need to sign in if this link is protected."}
            </p>
          </div>

          {content}
        </main>
      </div>
    </div>
  );
}

function triggerDownload(url: string, filename?: string) {
  const link = document.createElement("a");
  link.href = url;
  if (filename) link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function useDirectoryNav(navigateFn: (path: string) => void, currentPath: string) {
  const navigateInto = (name: string) => {
    const next = currentPath ? `${currentPath}/${name}` : name;
    navigateFn(next);
  };
  const navigateUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigateFn(parts.join("/"));
  };
  return { navigateInto, navigateUp };
}

function ErrorBox({ title, message, actionLabel, onAction, icon }: { title: string; message?: string; actionLabel?: string; onAction?: () => void; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
      <div className="flex items-center gap-2 font-semibold">
        {icon ?? <ShieldAlert className="h-5 w-5" />} {title}
      </div>
      {message && <p className="text-sm text-destructive/80">{message}</p>}
      {actionLabel && onAction && (
        <Button variant="outline" onClick={onAction} className="w-fit border-destructive/50 text-destructive">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
