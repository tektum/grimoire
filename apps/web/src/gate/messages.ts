/** What the configuration gate shows before the app starts (contracts section 5). Wording lives here so it is reviewed in one place. */
export const GATE_MESSAGES = {
  unreachable: "The server can't be reached. Trying again.",
  notReady: 'The server is not ready. Trying again.',
  outdated: 'A new version is available. Reload.',
} as const;

/** How often the gate asks again while the server cannot be reached or is not ready. */
export const GATE_RETRY_MS = 5000;
