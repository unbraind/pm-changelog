export type PmItemStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "closed"
  | "canceled"
  | "draft"
  | string;

export interface PmItem {
  id?: string;
  title: string;
  body?: string;
  status?: PmItemStatus;
  priority?: number;
  type?: string;
  tags?: string[];
  milestone?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  due_date?: string;
}

export interface GenerateChangelogOptions {
  items: PmItem[];
  title?: string;
  version?: string;
  date?: string;
  since?: string;
  until?: string;
  includeStatuses?: string[];
  groupBy?: "version" | "milestone";
  includeEmpty?: boolean;
}

export interface ReadPmItemsOptions {
  pmRoot?: string;
  pmBin?: string;
}

export interface ChangelogSection {
  heading: string;
  items: PmItem[];
}
