export type Asset = {
  id: string;
  displayCode?: string;
  name: string;
  category: string;
  summary?: string;
  useCase?: string;
  material?: string | null;
  sourceType?: string;
  sourceUrl?: string;
  license?: string;
  format?: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  localPath?: string;
  instances?: number;
  partCount?: number;
  source?: string;
  author?: string;
  manifestUrl?: string;
  stepUrl?: string;
  sourceModelUrl?: string;
  tags?: string[];
  [key: string]: unknown;
};
export type DemoVideoSource = { hd: string; sd?: string; poster?: string };

export type Health = {
  hasApiKey?: boolean;
  usageEnabled?: boolean;
  taskCancellation?: boolean;
  taskRevisions?: boolean;
  preview?: boolean;
  publicTrial?: boolean;
  hostedDemo?: boolean;
  demoVideo?: DemoVideoSource;
  metered?: boolean;
  localMode?: boolean;
  runnerOnline?: boolean;
  providerId?: string;
  billingMode?: "external" | "managed";
  visionEnabled?: boolean;
  cad: boolean;
  modelConfigured: boolean;
  agh: boolean;
  model: string;
  version: string;
};
export type DocumentRecord = {
  pageCount?: number;
  id: string;
  name: string;
  mime: string;
  url: string;
  pages?: { page: number; text: string }[];
  error?: string;
};
export type Task = {
  id: string;
  status: string;
  createdAt: string;
  title: string;
  events: { time: string; type: string; message: string; toolUseId?: string; toolName?: string; phase?: string; input?: string; output?: string }[];
  result?: Record<string, unknown>;
  error?: string;
};
export type CADManifest = {
  instances?: {
    id: string;
    part_id?: string;
    translation?: number[];
    explode?: number[];
    sequence?: number;
  }[];
  [key: string]: unknown;
};
