export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export function createApi(getToken: () => Promise<string>) {
  const base = (import.meta as any).env.VITE_API_BASE || 'http://localhost:8000';
  const baseUrl = base.replace(/\/$/, '') + '/storage';

  async function request(path: string, method: HttpMethod, body?: any, headers?: Record<string, string>) {
    const token = await getToken();
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...(headers || {}),
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    let data: any = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch { data = await res.text(); }
    } else {
      data = await res.text();
    }
    return { ok: res.ok, status: res.status, data };
  }

  return {
    list: (path?: string) => {
      const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
      return request(suffix, 'GET');
    },
    createDir: (name: string) => {
      const form = new FormData();
      form.set('name', name);
      return request('/dirs', 'POST', form);
    },
    upload: (file: File, path?: string) => {
      const form = new FormData();
      form.set('file', file);
      if (path) form.set('path', path);
      return request('/upload', 'POST', form);
    },
    del: (key: string) => request(`/item?key=${encodeURIComponent(key)}`, 'DELETE'),
    downloadLink: (key: string, expires = 300) => request(`/download?key=${encodeURIComponent(key)}&expires=${expires}`, 'GET'),
    versions: (key: string) => request(`/versions?key=${encodeURIComponent(key)}`, 'GET'),
    restoreVersion: (key: string, version: number) => {
      const form = new FormData();
      form.set('key', key);
      form.set('version', String(version));
      return request('/versions/restore', 'POST', form);
    },
    logs: (limit = 50) => request(`/logs?limit=${limit}`, 'GET'),
    shareWithUser: (key: string, target_sub: string, permission: 'read' | 'read-write' = 'read', expires_in?: number) => {
      const form = new FormData();
      form.set('key', key);
      form.set('target_sub', target_sub);
      form.set('permission', permission);
      if (typeof expires_in === 'number') form.set('expires_in', String(expires_in));
      return request('/share/user', 'POST', form);
    },
    listShared: () => request('/shared', 'GET'),
    sharedDownload: (share_id: string, expires = 300) => request(`/shared/download?share_id=${encodeURIComponent(share_id)}&expires=${expires}`, 'GET'),
    revokeShare: (share_id: string) => request(`/share?share_id=${encodeURIComponent(share_id)}`, 'DELETE'),
    multipart: {
      initiate: (filename: string, totalSize?: number, path?: string) => {
        const form = new FormData();
        form.set('filename', filename);
        if (typeof totalSize === 'number') form.set('total_size', String(totalSize));
        if (path) form.set('path', path);
        return request('/multipart/initiate', 'POST', form);
      },
      uploadPart: (key: string, uploadId: string, partNumber: number, chunk: Blob) => {
        const form = new FormData();
        form.set('key', key);
        form.set('uploadId', uploadId);
        form.set('partNumber', String(partNumber));
        form.set('chunk', chunk);
        return request('/multipart/upload-part', 'POST', form);
      },
      complete: (key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) => {
        const form = new FormData();
        form.set('key', key);
        form.set('uploadId', uploadId);
        form.set('parts', JSON.stringify(parts));
        return request('/multipart/complete', 'POST', form);
      },
      abort: (key: string, uploadId: string) => {
        const form = new FormData();
        form.set('key', key);
        form.set('uploadId', uploadId);
        return request('/multipart/abort', 'POST', form);
      },
    },
  };
}
