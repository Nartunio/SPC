import { useAuth0 } from "@auth0/auth0-react";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";

export default function CallbackPage() {
  const { isLoading, error, isAuthenticated } = useAuth0();

  // Normally Auth0Provider + onRedirectCallback will move the user away from
  // this route after processing the callback. This page is just a safe UI.

  return (
    <div style={{ padding: "1rem", maxWidth: 1000, margin: "0 auto", display: "grid", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Signing you in…</h1>
        <Button asChild variant="outline">
          <Link to="/">Home</Link>
        </Button>
      </header>

      <div className="rounded-lg border bg-card p-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Processing Auth0 callback…
          </div>
        )}

        {!isLoading && error && (
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            <div>
              <div className="font-semibold">Authentication failed</div>
              <div className="text-sm text-destructive/80 break-all">{String((error as any)?.message || error)}</div>
              <div className="mt-3 flex gap-2">
                <Button asChild>
                  <Link to="/">Back to home</Link>
                </Button>
                <Button variant="outline" onClick={() => window.location.reload()}>Try again</Button>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && isAuthenticated && (
          <div className="text-muted-foreground">Signed in. Redirecting…</div>
        )}

        {!isLoading && !error && !isAuthenticated && (
          <div className="text-muted-foreground">Waiting for authentication…</div>
        )}
      </div>
    </div>
  );
}
