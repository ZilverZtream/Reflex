declare global {
  const DOMPurify:
    | {
        sanitize: (html: string, options?: Record<string, unknown>) => string;
      }
    | undefined;

  interface Window {
    __REFLEX_DEVTOOLS_HOOK__?: {
      registerApp?: (payload: unknown) => void;
      emit?: (event: string, payload: unknown) => void;
      apps?: unknown[];
    };
  }
}

export {};
