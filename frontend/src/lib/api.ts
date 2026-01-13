export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export function createApi(getToken: () => Promise<string>, getIdTokenRaw?: () => Promise<string | undefined>) {
  const base = (import.meta as any).env.VITE_API_BASE || 'http://localhost:8000';
  const baseUrl = base.replace(/\/$/, '') + '/storage';

  async function request(
    path: string,
    method: HttpMethod,
    body?: any,
    headers?: Record<string, string>,
    options?: { signal?: AbortSignal }
  ) {
    const token = await getToken();
    let idToken: string | undefined;
    if (getIdTokenRaw) {
      try { idToken = await getIdTokenRaw(); } catch { idToken = undefined; }
    }
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      signal: options?.signal,
      headers: {
        ...(headers || {}),
        Authorization: `Bearer ${token}`,
        ...(idToken ? { 'X-Auth0-Id-Token': idToken } : {}),
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
    logs: (limit = 50, offset = 0, action?: string, from?: string, to?: string) => {
      const off = Number.isFinite(offset) && offset > 0 ? `&offset=${offset}` : '';
      const act = action ? `&action=${encodeURIComponent(action)}` : '';
      const fromQ = from ? `&from=${encodeURIComponent(from)}` : '';
      const toQ = to ? `&to=${encodeURIComponent(to)}` : '';
      return request(`/logs?limit=${limit}${off}${act}${fromQ}${toQ}`, 'GET');
    },
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
    listOwnedShares: (prefix?: string) => {
      const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      return request(`/share/list${query}`, 'GET');
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
    logShareDownload: (token: string, options?: { zip?: boolean }, extraHeaders?: Record<string, string>) => {
      const zipParam = options?.zip ? '&zip=1' : '';
      return request(`/share/download-log?token=${encodeURIComponent(token)}${zipParam}`, 'POST', undefined, extraHeaders);
    },
    accessShare: (token: string, options?: { expires?: number; presign?: boolean; path?: string }, extraHeaders?: Record<string, string>) => {
      const expires = options?.expires ?? 300;
      const presign = options?.presign ?? true;
      const pathParam = options?.path ? `&path=${encodeURIComponent(options.path)}` : '';
      return request(`/share/access?token=${encodeURIComponent(token)}&expires=${expires}&presign=${presign ? 1 : 0}&format=json${pathParam}`, 'GET', undefined, extraHeaders);
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

    chunked: {
      initiate: (options: {
        filename: string;
        file_checksum: string;
        chunk_size: number;
        chunk_checksums?: string[];
        total_size?: number;
        path?: string;
      }, requestOptions?: { signal?: AbortSignal }) => {
        const form = new FormData();
        form.set('filename', options.filename);
        form.set('file_checksum', options.file_checksum);
        form.set('chunk_size', String(options.chunk_size));
        if (options.chunk_checksums && options.chunk_checksums.length) {
          form.set('chunk_checksums', JSON.stringify(options.chunk_checksums));
        }
        if (typeof options.total_size === 'number') form.set('total_size', String(options.total_size));
        if (options.path) form.set('path', options.path);
        return request('/chunked/initiate', 'POST', form, undefined, requestOptions);
      },
      uploadChunk: (options: {
        file_checksum: string;
        chunk_checksum: string;
        chunk: Blob;
      }, requestOptions?: { signal?: AbortSignal }) => {
        const form = new FormData();
        form.set('file_checksum', options.file_checksum);
        form.set('chunk_checksum', options.chunk_checksum);
        form.set('chunk', options.chunk);
        return request('/chunked/upload-chunk', 'POST', form, undefined, requestOptions);
      },
      complete: (options: {
        filename: string;
        file_checksum: string;
        chunk_checksums: string[];
        total_size?: number;
        path?: string;
      }, requestOptions?: { signal?: AbortSignal }) => {
        const form = new FormData();
        form.set('filename', options.filename);
        form.set('file_checksum', options.file_checksum);
        form.set('chunk_checksums', JSON.stringify(options.chunk_checksums));
        if (typeof options.total_size === 'number') form.set('total_size', String(options.total_size));
        if (options.path) form.set('path', options.path);
        return request('/chunked/complete', 'POST', form, undefined, requestOptions);
      },

      unfinished: () => {
        return request('/chunked/unfinished', 'GET');
      },

      abort: (file_checksum: string) => {
        return request(`/chunked/abort?file_checksum=${encodeURIComponent(file_checksum)}`, 'DELETE');
      },
    },
  };
}
