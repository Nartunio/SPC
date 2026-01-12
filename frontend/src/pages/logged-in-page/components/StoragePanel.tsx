import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import {
  ArrowLeft,
  Download,
  Folder,
  History,
  Loader2,
  RefreshCcw,
  Share2,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { createApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type FileItem = { name: string; size?: number; last_modified?: string; etag?: string };

type ListResponse = {
  prefix: string;
  path?: string;
  directories: { name: string }[];
  files: FileItem[];
};

function formatBytes(size?: number) {
  if (!size && size !== 0) return '—';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[idx]}`;
}

export default function StoragePanel() {
  const { getAccessTokenSilently } = useAuth0();
  const api = useMemo(
    () =>
      createApi(() =>
        getAccessTokenSilently({
          authorizationParams: { audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE },
        }),
      ),
    [getAccessTokenSilently],
  );

  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [currentPath, setCurrentPath] = useState('');
  const [newDir, setNewDir] = useState('');
  const [uploadPath, setUploadPath] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);

  const [shareTarget, setShareTarget] = useState('');
  const [sharePermission, setSharePermission] = useState<'read' | 'read-write'>('read');
  const [shareExpires, setShareExpires] = useState<number | ''>('');
  const [sharedWithMe, setSharedWithMe] = useState<any[] | null>(null);

  const [logs, setLogs] = useState<any[] | null>(null);

  const joinedPath = useCallback(
    (name: string) => {
      const clean = name.replace(/(^\/+|\/+?$)/g, '');
      return currentPath ? `${currentPath}/${clean}` : clean;
    },
    [currentPath],
  );

  const fullKey = useCallback(
    (name: string, isDir = false) => {
      const path = joinedPath(name);
      return isDir ? `${path}/` : path;
    },
    [joinedPath],
  );

  const refresh = useCallback(
    async (path = currentPath) => {
      setLoading(true);
      setError(null);
      const res = await api.list(path || undefined);
      setLoading(false);
      if (!res.ok) {
        setError(JSON.stringify(res.data));
        return;
      }
      setList(res.data as ListResponse);
    },
    [api, currentPath],
  );

  useEffect(() => {
    refresh(currentPath);
  }, [currentPath, refresh]);

  async function onCreateDir() {
    if (!newDir.trim()) return;
    const path = fullKey(newDir.trim(), true).replace(/\/$/, '');
    const res = await api.createDir(path);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setNewDir('');
    refresh(currentPath);
  }

  async function uploadFiles(files: File[], targetPath?: string) {
    if (!files.length) return;
    setUploading(true);
    setMessage(null);
    setError(null);
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024 * 1024) {
        setError('File too large (max 2GB).');
        setUploading(false);
        return;
      }
      const res = await api.upload(f, targetPath || currentPath || undefined);
      if (!res.ok) {
        setError(JSON.stringify(res.data));
        setUploading(false);
        return;
      }
    }
    setMessage(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}.`);
    if (fileRef.current) fileRef.current.value = '';
    setUploadPath('');
    setUploading(false);
    refresh(currentPath);
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || !files.length) return;
    const target = uploadPath.trim() ? joinedPath(uploadPath.trim()) : currentPath;
    await uploadFiles(Array.from(files), target || undefined);
  }

  async function onDelete(key: string) {
    if (!confirm(`Delete ${key}?`)) return;
    const res = await api.del(key);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    refresh(currentPath);
  }

  async function onDownload(key: string) {
    const res = await api.downloadLink(key);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    const url = (res.data as any).url;
    if (url) window.open(url, '_blank');
  }

  async function onShowVersions(key: string) {
    setSelectedKey(key);
    const res = await api.versions(key);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setVersions((res.data as any).versions || []);
  }

  async function onRestoreVersion(version: number) {
    if (!selectedKey) return;
    const res = await api.restoreVersion(selectedKey, version);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setVersions(null);
    setSelectedKey(null);
    refresh(currentPath);
  }

  async function onLoadLogs() {
    const res = await api.logs(50);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setLogs((res.data as any).logs || []);
  }

  async function onShare(key: string) {
    if (!shareTarget.trim()) {
      setError('Provide target_sub');
      return;
    }
    const res = await api.shareWithUser(
      key,
      shareTarget.trim(),
      sharePermission,
      shareExpires === '' ? undefined : Number(shareExpires),
    );
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setMessage('Share created');
  }

  async function onListShared() {
    const res = await api.listShared();
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setSharedWithMe((res.data as any).shares || []);
  }

  async function onSharedDownload(share_id: string) {
    const res = await api.sharedDownload(share_id);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    const url = (res.data as any).url;
    if (url) window.open(url, '_blank');
  }

  async function onRevokeShare(share_id: string) {
    if (!confirm('Revoke this share?')) return;
    const res = await api.revokeShare(share_id);
    if (!res.ok) {
      setError(JSON.stringify(res.data));
      return;
    }
    setMessage('Share revoked');
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files || []);
    uploadFiles(files, currentPath || undefined);
  }

  const breadcrumbParts = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Storage</p>
          <h2 className="text-2xl font-semibold">Files &amp; Sharing</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => refresh(currentPath)} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {(error || message) && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm shadow-sm ${
            error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/5 text-primary'
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setCurrentPath('')}>
              <ArrowLeft className="h-4 w-4" />
              Home
            </button>
            {breadcrumbParts.map((part, idx) => {
              const path = breadcrumbParts.slice(0, idx + 1).join('/');
              return (
                <span key={path} className="flex items-center gap-2">
                  <span className="text-muted-foreground">/</span>
                  <button
                    className="hover:text-foreground"
                    onClick={() => setCurrentPath(path)}
                  >
                    {part}
                  </button>
                </span>
              );
            })}
          </div>
          {currentPath && (
            <Badge variant="secondary">{currentPath}</Badge>
          )}
        </div>
      </div>

      <div
        className={`rounded-xl border-2 border-dashed p-6 shadow-sm transition ${
          dragActive ? 'border-primary bg-primary/5' : 'border-border bg-card/60'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Upload files here</p>
            <p className="text-sm text-muted-foreground">
              Drag &amp; drop or choose files. Target directory: {currentPath || 'root'}
            </p>
          </div>
          <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={onUpload}>
            <Input type="file" ref={fileRef} multiple className="sm:w-56" />
            <Input
              placeholder="Optional subpath"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              className="sm:w-48"
            />
            <Button type="submit" disabled={uploading}>
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
              Upload
            </Button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border bg-card/60 p-4 shadow-sm lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Items</p>
              <p className="text-sm text-muted-foreground">Click folders to open. Actions sit on hover.</p>
            </div>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {!list ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-2">
              <div className="grid gap-2">
                {(list.directories || []).map((d) => (
                  <div
                    key={d.name}
                    className="group flex items-center justify-between rounded-lg border px-3 py-2 hover:border-primary"
                  >
                    <button className="flex items-center gap-3" onClick={() => setCurrentPath(joinedPath(d.name))}>
                      <Folder className="h-4 w-4 text-primary" />
                      <div className="text-left">
                        <p className="text-sm font-medium">{d.name}</p>
                        <p className="text-xs text-muted-foreground">Folder</p>
                      </div>
                    </button>
                    <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                      <Button variant="ghost" size="icon" onClick={() => onShare(fullKey(d.name, true))}>
                        <Share2 className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onDelete(fullKey(d.name, true))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-2">
                {(list.files || []).map((f) => (
                  <div
                    key={f.name}
                    className="group flex items-center justify-between rounded-lg border px-3 py-2 hover:border-primary"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                        {f.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-medium">{f.name}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                      <Button variant="ghost" size="icon" onClick={() => onDownload(fullKey(f.name))}>
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onShowVersions(fullKey(f.name))}>
                        <History className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onShare(fullKey(f.name))}>
                        <Share2 className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onDelete(fullKey(f.name))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
          <p className="text-sm font-semibold">New folder</p>
          <p className="text-xs text-muted-foreground">Created inside {currentPath || 'root'}.</p>
          <div className="mt-3 flex flex-col gap-2">
            <Input
              placeholder="photos/2026"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
            />
            <Button onClick={onCreateDir}>Create</Button>
          </div>

          <div className="mt-6 space-y-2">
            <p className="text-sm font-semibold">Share</p>
            <Input
              placeholder="target_sub (auth0|...)"
              value={shareTarget}
              onChange={(e) => setShareTarget(e.target.value)}
            />
            <div className="flex gap-2">
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={sharePermission}
                onChange={(e) => setSharePermission(e.target.value as 'read' | 'read-write')}
              >
                <option value="read">read</option>
                <option value="read-write">read-write</option>
              </select>
              <Input
                type="number"
                placeholder="expires (s)"
                value={shareExpires as any}
                onChange={(e) => setShareExpires(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
            <p className="text-xs text-muted-foreground">Select a file/folder action to share.</p>
            <Button variant="secondary" onClick={onListShared} className="w-full">
              Shared with me
            </Button>
          </div>
        </div>
      </div>

      {sharedWithMe && (
        <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">Shared with me</p>
          </div>
          <div className="space-y-2">
            {sharedWithMe.map((s: any) => (
              <div key={s.share_id} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    {s.is_directory ? <Folder className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                    {s.key}
                  </p>
                  <p className="text-xs text-muted-foreground">from {s.owner_sub} • {s.permission}</p>
                </div>
                {!s.is_directory && (
                  <Button variant="ghost" size="sm" onClick={() => onSharedDownload(s.share_id)}>
                    Download
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {versions && selectedKey && (
        <div className="rounded-xl border bg-card/80 p-4 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Versions</p>
              <p className="text-xs text-muted-foreground">{selectedKey}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setVersions(null); setSelectedKey(null); }}>
              Close
            </Button>
          </div>
          <div className="space-y-2">
            {versions.map((v: any) => (
              <div key={v.version} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="text-sm">
                  v{v.version} • {formatBytes(v.size)} • {v.created_at}
                </div>
                <Button variant="ghost" size="sm" onClick={() => onRestoreVersion(v.version)}>
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card/60 p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold">Activity Log</p>
          <Button variant="ghost" size="sm" onClick={onLoadLogs}>
            Refresh
          </Button>
        </div>
        {logs ? (
          <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
            {logs.map((l: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/50">
                <span className="text-xs text-muted-foreground">{l.created_at}</span>
                <span className="text-sm">{l.action} {l.key || ''}</span>
                <span className={l.success ? 'text-green-600' : 'text-red-600'}>{l.success ? '✓' : '✕'}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No logs loaded yet.</p>
        )}
      </div>
    </div>
  );
}
