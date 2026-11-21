/** DEV ONLY: the server passes a DevRoleSource only when config.local is true. */
export type DevRole = 'admin' | 'member' | 'viewer';

export interface DevRoleSource {
  readonly devOnly: true;
  roleOf(token: string): DevRole | undefined;
}
