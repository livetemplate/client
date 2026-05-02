export interface TreeNode {
  [key: string]: any;
  s?: string[];
}

export interface UpdateResult {
  html: string;
  changed: boolean;
  dom?: Element;
  targetedOps?: TargetedRangeOp[];
}

/**
 * Describes a single keyed-range diff op that can be applied directly to
 * the live DOM, bypassing full HTML reconstruction. Produced by
 * `TreeRenderer.applyUpdate` when the range is targeted-eligible (data-key
 * present, no nested ranges, container resolvable).
 */
export interface TargetedRangeOp {
  rangePath: string;
  ops: any[];
  statics: string[];
  staticsMap?: Record<string, string[]>;
  idKey?: string;
}

export interface ResponseMetadata {
  success: boolean;
  errors: { [key: string]: string };
  action?: string;
  capabilities?: string[];
}

export interface UpdateResponse {
  tree: TreeNode;
  meta?: ResponseMetadata;
}

import type { Logger, LogLevel } from "./utils/logger";

export interface LiveTemplateClientOptions {
  wsUrl?: string;
  liveUrl?: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  logLevel?: LogLevel;
  debug?: boolean;
  logger?: Logger;
}
