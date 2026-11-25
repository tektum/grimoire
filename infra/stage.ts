import { descopeProject } from './descope/project.ts';
import { POSTGRES_VERSION, type StageConfig, type StageSettings } from './stages.ts';
import { databaseUrl, RDS_CA_BUNDLE } from './stack/database-url.ts';
import { loadBalancerLogs, TLS_POLICY } from './stack/edge.ts';
import { inStartOrder } from './stack/init-order.ts';
import { openServiceToLoadBalancer, stageSecurityGroups, stripDefaultGroup, vpcFlowLogs } from './stack/network.ts';

/** The Route 53 zone of the sites' domain (every stage's address is in it): it exists already (the parent delegates to it), so it is looked up and never made here. */
const ZONE_ID = 'Z09474701DSI18DNI458V';
const PORT = 8080;
/** The VPC's address range (SST's default): the load balancer's addresses are inside it, and they are the proxy the server trusts for client addresses. */
const VPC_CIDR = '10.0.0.0/16';
const IMAGE = { context: '.', dockerfile: 'Dockerfile' };

/**
 * The product on one Fargate task behind a load balancer, with its own database, file bucket and Descope project: the same for every stage, from the row of `stages.ts` and the settings of
 * the stage's environment. A deploy replaces the task, the old one serving until the new one is ready.
 */
export default function grimoireStage(config: StageConfig, settings: StageSettings) {
  const { domain, auroraSnapshot } = settings;
  const url = `https://${domain}`;
  const region = aws.getRegionOutput().region;
  const identity = descopeProject(config, domain);
  // One VPC for every stage (they share its subnets, routes and NAT instances: a stage of its own would need two more Elastic IPs, which the account does not have). The stage that owns it makes it;
  // the others read it by the owner's tags. What keeps the stages apart is not the network but the security groups below: the database of a stage takes connections from its service alone.
  const vpc = config.vpcFrom === undefined
    ? new sst.aws.Vpc('Vpc', {
      nat: config.nat,
      // SST lets the NAT instance take inbound traffic from anywhere. It only forwards what the VPC's own subnets send, so only the VPC's range may reach it.
      transform: { natSecurityGroup: { ingress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [VPC_CIDR] }] } },
    })
    : sst.aws.Vpc.get('Vpc', aws.ec2.getVpcOutput({ tags: { 'sst:app': $app.name, 'sst:stage': config.vpcFrom } }).id);
  const { serviceGroup, dbGroup } = stageSecurityGroups(vpc, VPC_CIDR);
  if (config.vpcFrom === undefined) vpcFlowLogs(vpc);
  const db = new sst.aws.Postgres('Db', { vpc, version: POSTGRES_VERSION, transform: { instance: { vpcSecurityGroupIds: [dbGroup.id], ...(auroraSnapshot === undefined ? {} : { deletionProtection: true }) } } });
  // The move to Aurora Serverless v2 (docs/operations/database-setup.md): a stage given a snapshot of its instance gets a cluster restored from it in the same database group, and every
  // connection goes to the cluster. The instance stays, protected, as the way back until a later change removes it.
  const aurora = auroraSnapshot === undefined ? undefined : new sst.aws.Aurora('DbCluster', {
    engine: 'postgres',
    version: POSTGRES_VERSION,
    vpc,
    scaling: { min: '0.5 ACU', max: '2 ACU' }, // always on: the service, its job queue and the health checks never leave it idle, so a minimum of 0 would never pause it (docs/decisions.md, 166)
    transform: {
      cluster: (args, opts) => {
        args.vpcSecurityGroupIds = [dbGroup.id];
        args.snapshotIdentifier = auroraSnapshot;
        args.deletionProtection = true;
        args.backupRetentionPeriod = 7; // as long as the instance keeps its backups
        opts.ignoreChanges = ['snapshotIdentifier']; // the snapshot only seeds the cluster: a later value must never replace it
      },
    },
  });
  const database = aurora ?? db;
  const password = (id: string) => new random.RandomPassword(id, { length: 40, special: false }).result;
  const appPassword = password('DbAppPassword');
  const migratorPassword = password('DbMigratorPassword');
  const opsPassword = password('DbOpsPassword'); // the operator role of docs/tenancy.md section 3.2
  // The managed database requires TLS: the connections verify it against Amazon's bundle, which the image holds (NODE_EXTRA_CA_CERTS names it).
  // Passwords and the connection strings that hold them go to the container as ECS secrets (Parameter Store SecureString, read by the execution role at start), never as
  // plain environment values: the task definition then holds only their ARNs.
  const secret = (id: string, value: $util.Input<string>) => new aws.ssm.Parameter(id, { type: 'SecureString', value }).arn;
  const urlOf = (user: $util.Input<string>, password: $util.Input<string>) =>
    $resolve({ user, secret: password, host: database.host, port: database.port, name: database.database }).apply((v) => databaseUrl(v.user, v.secret, v.host, v.port, v.name));
  const trust = { NODE_EXTRA_CA_CERTS: RDS_CA_BUNDLE };

  // The CORS rule is the one `grimoire files-setup` writes for a store the application sets up itself (external mode: the infrastructure owns it, nothing in the task writes or checks it).
  const files = new sst.aws.Bucket('Files', {
    cors: { allowOrigins: [url], allowMethods: ['GET', 'PUT', 'HEAD'], allowHeaders: ['content-type', 'content-disposition', 'if-none-match', 'x-amz-*'], exposeHeaders: ['ETag'], maxAge: '10 minutes' },
  });

  const albLogs = loadBalancerLogs();
  const cluster = new sst.aws.Cluster('Cluster', { vpc });
  const service = new sst.aws.Service('Server', { // not 'App': SST reserves that name for a linkable component
    cluster,
    cpu: config.service.cpu,
    memory: config.service.memory, // above the collaboration memory guard (see stages.ts)
    scaling: { min: 1, max: 1 },
    containers: [
      {
        name: 'db-setup',
        image: IMAGE,
        command: ['apps/server/dist/cli.js', 'db-setup'],
        environment: trust,
        ssm: {
          GRIMOIRE_DATABASE_ADMIN_URL: secret('AdminUrl', urlOf(database.username, database.password)),
          GRIMOIRE_DB_APP_PASSWORD: secret('AppPassword', appPassword),
          GRIMOIRE_DB_MIGRATOR_PASSWORD: secret('MigratorPassword', migratorPassword),
          GRIMOIRE_DB_OPS_PASSWORD: secret('OpsPassword', opsPassword),
        },
      },
      { name: 'migrate', image: IMAGE, command: ['apps/server/dist/cli.js', 'migrate'], environment: trust, ssm: { GRIMOIRE_DATABASE_MIGRATION_URL: secret('MigratorUrl', urlOf('grimoire_migrator', migratorPassword)) } },
      {
        name: 'app',
        image: IMAGE,
        environment: {
          ...trust,
          GRIMOIRE_HOST: '0.0.0.0',
          GRIMOIRE_PORT: String(PORT),
          GRIMOIRE_ALLOWED_ORIGINS: url,
          GRIMOIRE_TRUSTED_PROXY: VPC_CIDR,
          GRIMOIRE_DESCOPE_PROJECT_ID: identity.projectId,
          GRIMOIRE_ALLOWED_EMAIL_DOMAINS: settings.allowedEmailDomains.join(','),
          ...(settings.refusedEmailDomains.length === 0 ? {} : { GRIMOIRE_REFUSED_EMAIL_DOMAINS: settings.refusedEmailDomains.join(',') }),
          GRIMOIRE_FIRST_ADMIN_EMAILS: settings.firstAdminEmails.join(','),
          GRIMOIRE_PUBLIC_API_URL: url,
          GRIMOIRE_PUBLIC_COLLAB_URL: `wss://${domain}/collab`,
          GRIMOIRE_WEB_ROOT: '/app/web',
          GRIMOIRE_S3_ENDPOINT: $interpolate`https://s3.${region}.amazonaws.com`,
          GRIMOIRE_S3_REGION: region,
          GRIMOIRE_S3_BUCKET: files.name,
          GRIMOIRE_S3_ADDRESSING_STYLE: 'virtual',
          GRIMOIRE_S3_CORS_MODE: 'external',
          GRIMOIRE_SEMANTIC_SEARCH: 'off', // the model needs about 3 GiB: on goes with a larger task, for every stage alike
        },
        // The runtime role, and the operator role for the call sites that cross tenants: the schema owner's credentials stay with the `migrate` step.
        ssm: {
          GRIMOIRE_DATABASE_URL: secret('AppUrl', urlOf('grimoire_app', appPassword)),
          GRIMOIRE_DATABASE_OPS_URL: secret('OpsUrl', urlOf('grimoire_ops', opsPassword)),
        },
      },
    ],
    // No access keys: the task role is the identity of the file store client, with the least a bucket client needs (`ListBucket` so that a missing object is a 404 and not a 403).
    permissions: [
      { actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [$interpolate`${files.arn}/*`] },
      { actions: ['s3:ListBucket'], resources: [files.arn] },
    ],
    loadBalancer: {
      domain: { name: domain, dns: sst.aws.dns({ zone: ZONE_ID }) },
      rules: [
        { listen: '80/http', redirect: '443/https', container: 'app' },
        { listen: '443/https', forward: `${PORT}/http`, container: 'app' },
      ],
      health: { [`${PORT}/http`]: { path: '/readyz', interval: '15 seconds', timeout: '5 seconds', healthyThreshold: 2, unhealthyThreshold: 3, successCodes: '200' } },
    },
    transform: {
      // The component puts a service in the VPC's default group, which trusts the whole VPC: this stage's own group instead, with the subnets and the public address the component chose.
      service: (args) => {
        args.networkConfiguration = $output(args.networkConfiguration).apply((network) => ({ ...network, securityGroups: [serviceGroup.id] }) as aws.types.input.ecs.ServiceNetworkConfiguration);
      },
      // The edge: invalid header fields are dropped (request smuggling), every request is logged to a bucket of the stage, and the HTTPS listener takes TLS 1.2 and newer with forward secrecy only.
      loadBalancer: (args) => {
        args.dropInvalidHeaderFields = true;
        args.accessLogs = { bucket: albLogs.bucket, prefix: 'alb', enabled: true };
      },
      listener: (args) => {
        if (args.protocol === 'HTTPS') args.sslPolicy = TLS_POLICY;
      },
      taskDefinition: (args) => {
        args.containerDefinitions = $output(args.containerDefinitions).apply((json) => JSON.stringify(inStartOrder(JSON.parse(json as string))));
      },
    },
  });

  openServiceToLoadBalancer(serviceGroup, service, PORT);
  if (config.vpcFrom === undefined) stripDefaultGroup(vpc, [db, service]);

  return { url: service.url, projectId: identity.projectId };
}
