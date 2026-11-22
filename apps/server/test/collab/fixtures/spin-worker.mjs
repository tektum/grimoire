// A conversion that never finishes in time: the thread spins until it is terminated.
export default function spin() {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { /* spin */ }
  return { ok: true, markdown: '', text: '' };
}
