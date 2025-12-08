import { useEffect, useState } from "react";

type User = {
  id: number;
  name: string;
  // add fields matching your API
};

function LoggedInPage(){
  const [data, setData] = useState<User[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const resp = await fetch("http://127.0.0.1:8000/", {
          method: "GET",
          headers: {
            "Accept": "application/json",
          },
          signal: controller.signal,
          credentials: "include",
        });

        console.log(resp);

        if (!resp.ok) {
          throw new Error(`Request failed: ${resp.status} ${resp.statusText}`);
        }

        const json = await resp.json() as User[];
        setData(json);
      } catch (e: any) {
        if (e.name !== "AbortError") setError(e.message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, []);

  return (
    <>
      <section className="bg-muted h-screen">
        <div className="flex h-full items-center justify-center flex-col gap-4">
          {loading && <div>Loading…</div>}
          {error && <div className="text-red-600">Error: {error}</div>}
          {!loading && !error && (
            <pre className="text-left bg-white p-4 rounded shadow max-w-lg overflow-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      </section>
    </>
  );
}

export default LoggedInPage;