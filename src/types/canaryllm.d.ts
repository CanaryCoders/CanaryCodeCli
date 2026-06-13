declare module "@canarycoders/canaryllm" {
  export interface ModelInfo {
    id: string;
    /** Present on `discovery.models()` entries; absent on `public.models()`. */
    provider?: string;
    /** Omitted on some catalogue entries — always parse defensively. */
    capabilities?: readonly string[];
  }

  export interface CompatTarget {
    baseURL: string;
    apiKey: string;
    defaultHeaders?: Record<string, string>;
  }

  export function openaiTarget(baseURL: string, apiKey: string): CompatTarget;

  export interface CanaryLLMOptions {
    apiKey?: string;
    baseURL?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }

  export default class CanaryLLM {
    constructor(options?: CanaryLLMOptions);
    readonly discovery: {
      providers(signal?: AbortSignal): Promise<string[]>;
      models(provider: string, signal?: AbortSignal): Promise<ModelInfo[]>;
    };
    readonly public: {
      models(
        signal?: AbortSignal,
      ): Promise<Record<string, { models?: readonly ModelInfo[] }>>;
    };
  }
}
