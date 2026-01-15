export type FileItem = {
  name: string;
  size?: number;
  last_modified?: string;
  created_at?: string | null;
  created_by_email?: string | null;
  etag?: string;
};

export type DirectoryItem = {
  name: string;
  is_empty?: boolean;
  last_modified?: string | null;
  created_at?: string | null;
  created_by_email?: string | null;
};

export type ListResponse = {
  prefix: string;
  path?: string;
  directories: DirectoryItem[];
  files: FileItem[];
};

export type ShareVisibility = "private" | "public" | "protected";
export type SharePermission = "read" | "read-write";

export type ShareResult = {
  share_id: string;
  token: string;
  access_url?: string;
  visibility: ShareVisibility;
  target_sub?: string | null;
  target_email?: string | null;
  permission: SharePermission;
  expires_at?: string | null;
  allowed_emails?: string[];
  key: string;
};

export type SharedWithMeShare = {
  share_id: string;
  owner_sub: string;
  owner_email?: string | null;
  key: string;
  is_directory: boolean;
  permission: SharePermission;
  expires_at?: string | null;
  target_email?: string | null;
  visibility?: ShareVisibility;
};

export type PanelView = "storage" | "shared_to_me" | "my_shares" | "activity";

export type UploadTaskStatus = "hashing" | "uploading" | "finalizing" | "paused" | "error";

export type UploadTask = {
  id: string;
  fileName: string;
  totalBytes: number;
  uploadedBytes: number;
  inflightBytes?: number;
  hashedBytes?: number;
  checksumStage?: "whole" | "chunk";
  checksumChunkIndex?: number; // 1-based
  checksumChunksTotal?: number;
  startedAt: number;
  targetPath: string;
  status: UploadTaskStatus;
  error?: string;
  note?: string;
  fileChecksum?: string;
};

export type UploadChecksumCacheEntry = {
  fileChecksum?: string;
  chunkChecksums?: Array<string | undefined>;
};

export type FinalizePollState = { timer: number | null; tries: number };
export type VisibilityPollState = { timer: number | null; tries: number; expected: Set<string> };

export type Toast = {
  id: string;
  variant: "error" | "success";
  text: string;
  details?: string;
  createdAt: number;
};

export type LogLimitMode = "50" | "100" | "200" | "dynamic";
