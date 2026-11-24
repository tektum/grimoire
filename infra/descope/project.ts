import { projectConfig } from './config.ts';
import type { StageConfig } from '../stages.ts';

/**
 * The Descope project of a stage, created and configured entirely here, and the id the rest of the stack takes from it. The project is protected from deletion (the provider's
 * default, stated): destroying one needs `deletionProtection: false` applied first.
 */
export function descopeProject(stage: StageConfig, domain: string) {
  const config = projectConfig(stage, { domain });
  const project = new descope.Project('Project', { name: config.name, tags: [...config.tags], deletionProtection: true, ...(config.environment === undefined ? {} : { environment: config.environment }) });
  const projectId = project.id;
  const settings = new descope.ProjectSettings('Settings', { projectId, appUrl: config.appUrl, approvedDomains: [...config.approvedDomains] });
  new descope.OtpSettings('Otp', { projectId, disabled: false, expirationTime: config.otp.expirationTime });
  const userToken = new descope.JwtTemplate('UserToken', { projectId, name: config.userToken.name, description: config.userToken.description, type: 'user', autoTenantClaim: true, template: JSON.stringify(config.userToken.claims) });
  new descope.SessionSettings('Session', { projectId, ...config.session, userJwtTemplate: userToken.id });
  const off = new Set(config.disabledMethods);
  if (off.has('password')) new descope.PasswordSettings('Password', { projectId, disabled: true });
  if (off.has('magiclink')) new descope.MagiclinkSettings('Magiclink', { projectId, disabled: true });
  if (off.has('enchantedlink')) new descope.EnchantedlinkSettings('Enchantedlink', { projectId, disabled: true });
  if (off.has('embeddedlink')) new descope.EmbeddedlinkSettings('Embeddedlink', { projectId, disabled: true });
  if (off.has('totp')) new descope.TotpSettings('Totp', { projectId, disabled: true });
  if (off.has('passkey')) new descope.PasskeySettings('Passkey', { projectId, disabled: true });
  if (off.has('oauth')) new descope.OauthSettings('Oauth', { projectId, disabled: true });
  const styles = new descope.Styles('Styles', { projectId, data: config.styles });
  const flows = Object.entries(config.flows).map(([flowId, data]) => new descope.Flow(`Flow-${flowId}`, { projectId, flowId, data }, { dependsOn: [styles, settings] }));
  void flows;
  return { projectId, appUrl: config.appUrl };
}
