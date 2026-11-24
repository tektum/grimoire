/**
 * The sign-in settings of the existing development project "Grimoire dev" (its id is public). The project itself is not managed, so nothing in it is created
 * or deleted: only the two settings below are set. Authentication comes from a workload identity token (see docs/web-security.md and the workflow), never a stored key.
 */
const PROJECT_ID = 'P3MKkY4NTeugh4LndRLzgCZJtoPS';

export default function descopeDev() {
  // Hosts only: the provider takes no port, so the web page (port 4173) and the stack (port 8080) are both covered by 127.0.0.1.
  const settings = new descope.ProjectSettings('DevSettings', {
    projectId: PROJECT_ID,
    appUrl: 'http://127.0.0.1:4173',
    approvedDomains: ['127.0.0.1', 'localhost'],
  });
  // One-time code by email through the built-in delivery service.
  const otp = new descope.OtpSettings('DevOtp', { projectId: PROJECT_ID, disabled: false });
  return { projectId: PROJECT_ID, settings: settings.id, otp: otp.id };
}
