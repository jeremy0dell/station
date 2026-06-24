interface ImportMeta {
  hot?: {
    accept(): void;
    dispose(callback: () => void): void;
  };
}
