declare global {
  namespace App {
    interface Platform {
      env: {
        /** Where the pages are shown: a browser of `mdw serve` or the desktop window. */
        MDW_SHELL: "browser" | "desktop";
      };
      context: {
        waitUntil(promise: Promise<unknown>): void;
      };
    }
  }
}

export {};
