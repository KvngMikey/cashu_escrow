const refuse = (api: string): never => {
  throw new Error(
    `unit tests must not touch the network (blocked: ${api}). ` +
      'Move this case to tests/integration/.'
  );
};

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: () => refuse('fetch'),
});

Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  writable: true,
  value: class BlockedWebSocket {
    constructor() {
      refuse('WebSocket');
    }
  },
});
