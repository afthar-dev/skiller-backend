export default async function globalTeardown() {
  const containers = (globalThis as { __containers?: { stop(): Promise<void> } }).__containers;
  await containers?.stop();
}
