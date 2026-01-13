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
    move: (source: string, destination: string) => {
      const form = new FormData();
      form.set('source', source);
      form.set('destination', destination);
      return request('/move', 'POST', form);
    },
    rename: (source: string, destinationFolder: string, newName: string) => {
      const form = new FormData();
      form.set('source', source);
      form.set('destination', destinationFolder);
      form.set('new_name', newName);
      return request('/move', 'POST', form);
    },
    downloadLink: (key: string, expires = 300) => request(`/download?key=${encodeURIComponent(key)}&expires=${expires}`, 'GET'),
    downloadFolderZip: (path: string, expires = 300) => request(`/download-zip?path=${encodeURIComponent(path)}&expires=${expires}`, 'GET'),
    versions: (key: string) => request(`/versions?key=${encodeURIComponent(key)}`, 'GET'),
    restoreVersion: (key: string, version: number) => {
      const form = new FormData();
      form.set('key', key);
      form.set('version', String(version));
      return request('/versions/restore', 'POST', form);
    },
    logs: (limit = 50) => request(`/logs?limit=${limit}`, 'GET'),
    createShare: (options: {
      key: string;
      visibility: 'private' | 'public' | 'protected';
      permission?: 'read' | 'read-write';
      target_email?: string;
      target_sub?: string; // legacy fallback
      allowed_emails?: string[];
      expires_in?: number;
    }) => {
      const form = new FormData();
      form.set('key', options.key);
      form.set('visibility', options.visibility);
      form.set('permission', options.permission || 'read');
      if (options.target_email) form.set('target_email', options.target_email);
      else if (options.target_sub) form.set('target_sub', options.target_sub);
      if (options.allowed_emails && options.allowed_emails.length) {
        form.set('allowed_emails', JSON.stringify(options.allowed_emails));
      }
      if (typeof options.expires_in === 'number') {
        form.set('expires_in', String(options.expires_in));
      }
      return request('/share', 'POST', form);
    },
    shareWithUser: (key: string, target_email: string, permission: 'read' | 'read-write' = 'read', expires_in?: number) => {
      const form = new FormData();
      form.set('key', key);
      form.set('target_email', target_email);
      form.set('permission', permission);
      if (typeof expires_in === 'number') form.set('expires_in', String(expires_in));
      return request('/share/user', 'POST', form);
    },
    listShared: () => request('/shared', 'GET'),
    sharedDownload: (share_id: string, expires = 300) => request(`/shared/download?share_id=${encodeURIComponent(share_id)}&expires=${expires}`, 'GET'),
    revokeShare: (share_id: string) => request(`/share/revoke?share_id=${encodeURIComponent(share_id)}`, 'DELETE'),
    accessShare: (token: string, options?: { expires?: number; presign?: boolean; path?: string }) => {
      const expires = options?.expires ?? 300;
      const presign = options?.presign ?? true;
      const pathParam = options?.path ? `&path=${encodeURIComponent(options.path)}` : '';
      return request(`/share/access?token=${encodeURIComponent(token)}&expires=${expires}&presign=${presign ? 1 : 0}&format=json${pathParam}`, 'GET');
    },
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
