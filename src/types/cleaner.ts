export type CleanRecommendation = 'SafeToQuarantine' | 'Caution';

export interface CleanItem {
  path: string;
  name: string;
  size: number;
  last_modified: number;
  product_name?: string | null;
  author?: string | null;
  package_code?: string | null;
  comments?: string | null;
  recommendation: CleanRecommendation;
}

export interface CleanerScanResult {
  plugin_id: string;
  items: CleanItem[];
  total_bytes: number;
  active_count: number;
  active_bytes: number;
  scanned_count: number;
}

export interface CleanerPluginInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  requires_admin: boolean;
}

export type CleanAction =
  | { type: 'Quarantine'; target_dir: string }
  | { type: 'Rename'; prefix: string }
  | { type: 'Delete'; permanent: boolean };

export interface CleanItemResult {
  path: string;
  success: boolean;
  message: string;
}

export interface CleanExecutionResult {
  processed: number;
  succeeded: number;
  failed: number;
  freed_bytes: number;
  details: CleanItemResult[];
}

