import { createSdk } from '@descope/web-js-sdk';
import type { DescopeModule, DescopeSdk } from './index';

// The identity provider's web SDK, behind the narrow interface of `createAuth`. This file is imported with `import()` only (by `loadDescope` of the main
// app, when a session exists and a token must be read or refreshed, and by the sign-in screen), so the SDK and the fingerprinting script it brings are not
// in the entry chunks (`check:build` enforces it). Tokens are kept in local storage (`DS`, `DSR`) by the SDK: the one documented use of storage outside
// `ClientStorage`.
const module: DescopeModule = {
  create({ projectId, baseUrl }): DescopeSdk {
    const sdk = createSdk({ projectId, ...(baseUrl === undefined ? {} : { baseUrl }), persistTokens: true, storeLastAuthenticatedUser: false });
    return {
      getSessionToken: () => sdk.getSessionToken(),
      isJwtExpired: (token) => sdk.isJwtExpired(token),
      refresh: async () => ({ ok: (await sdk.refresh()).ok }),
      logout: () => sdk.logout(),
    };
  },
};
export default module;
