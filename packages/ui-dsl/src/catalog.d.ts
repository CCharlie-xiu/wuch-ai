// @openui-lab/catalog 是 JS 包（无类型声明）。这里只声明 ui-dsl 用到的形状。
declare module '@openui-lab/catalog' {
  export type CatalogParamType = 'nodes' | 'node' | 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'space';

  export interface CatalogParam {
    name: string;
    type: CatalogParamType;
    required: boolean;
    default?: unknown;
    enum?: string[];
  }

  export interface CatalogComponent {
    name: string;
    group: string;
    description: string;
    params: CatalogParam[];
    data?: boolean;
    serverResolved?: boolean;
    internal?: boolean;
    skill?: string;
    render?: unknown;
    css?: string;
  }

  export const COMPONENTS: CatalogComponent[];
  export const CATALOG: Map<string, CatalogComponent>;

  export const TOKENS: {
    space: number[];
    radius: Record<string, number>;
    text: Record<string, { size: number; weight: number; mono?: boolean }>;
    gap: Record<string, number>;
    maxWidth: Record<string, string>;
  };

  export const TEXT_STYLES: string[];
  export const SPACE_TOKENS: string[];
  export const MAX_WIDTHS: string[];
  export const SERVER_RESOLVED: Set<string>;

  export function signature(def: CatalogComponent): string;
  export function generatePrompt(options?: Record<string, unknown>): string;
}
