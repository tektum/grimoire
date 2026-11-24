/** What the exit test says, as one plain line, when the server it runs against is not one that requires the handshake: `make test-m6` starts it so and sets both variables. */
export function handshakeProblem(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env['M6_EXIT'] !== '1') return null; // not the exit test: the other runs of the browser specifications start no such server
  return env['M6_REQUIRE_HANDSHAKE'] === '1' ? null : 'M6_REQUIRE_HANDSHAKE=1 is not set: the exit test runs against a server that requires the handshake (make test-m6 sets it)';
}
