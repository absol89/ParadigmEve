export type PluginSurface = 'core' | 'desktop' | 'plugins';
export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Opaque provider metadata such as ChatGPT native file-parameter injection. */
  _meta?: Record<string, unknown>;
}
export interface PluginPublication {
  surface: PluginSurface;
  schemaId: string;
  connectorName: string;
  tools: PluginToolSchema[];
}
export interface PluginRefreshRequest extends PluginPublication {
  id: string;
  appId: string | null;
  /** Recovery work that must run even when optional automatic maintenance is disabled. */
  required: boolean;
  /** The one Refresh click was already claimed; this request may only verify its result. */
  verifyOnly: boolean;
}
