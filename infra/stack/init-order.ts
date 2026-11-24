/** The part of an ECS container definition the order of start-up changes (the rest of a definition passes through untouched). */
interface ContainerDefinition {
  readonly name: string;
  [key: string]: unknown;
}

/**
 * The start-up order of the service's task: `db-setup`, then `migrate`, then `app`. A container that must finish first is not essential (its exit with 0 is the
 * point, and does not stop the task) and the next one waits for it with the ECS condition `SUCCESS`: when a step fails, the task stops and the new version never
 * takes traffic, the old one keeps serving. SST has no setting for this, so the container definitions it makes are rewritten here.
 */
export const START_ORDER = ['db-setup', 'migrate', 'app'] as const;

/**
 * Seconds ECS waits between SIGTERM and SIGKILL for the app: the server's own shutdown (it drains, then saves the open pages inside its save deadline) needs
 * `requiredGracePeriodMs(45 s default save deadline)` = 64 s, and ECS's default of 30 s would kill a page that is still being saved at every deploy. Fargate allows up to 120.
 * A test keeps this at or above what the server requires.
 */
export const APP_STOP_TIMEOUT_SECONDS = 64;

export function inStartOrder(definitions: readonly ContainerDefinition[]): ContainerDefinition[] {
  const names = definitions.map((d) => d.name);
  for (const name of START_ORDER) if (!names.includes(name)) throw new Error(`The task has no container "${name}" (it has ${names.join(', ')}).`);
  return definitions.map((definition) => {
    const at = START_ORDER.indexOf(definition.name as (typeof START_ORDER)[number]);
    if (at < 0) return definition;
    const previous = START_ORDER[at - 1];
    return {
      ...definition,
      essential: at === START_ORDER.length - 1,
      ...(definition.name === 'app' ? { stopTimeout: APP_STOP_TIMEOUT_SECONDS } : {}),
      ...(previous === undefined ? {} : { dependsOn: [{ containerName: previous, condition: 'SUCCESS' }] }),
    };
  });
}
