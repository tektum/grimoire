import { descopeProject } from './descope/project.ts';

/** The development stage: one Descope project for local runs, made and configured by code. The project id is the stack's output. */
export default function descopeDev() {
  const project = descopeProject('descope-dev');
  new sst.Linkable('Descope', { properties: { projectId: project.projectId } });
  return { projectId: project.projectId, appUrl: project.appUrl };
}
