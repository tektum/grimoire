/**
 * The flow log of the VPC (the stage that owns the VPC makes it): every accepted and rejected connection, to a CloudWatch log group that a key of its own encrypts, kept a year. The role
 * the service of VPC flow logs assumes can create streams in that one group and write to it, nothing else, and only for flow logs of this account.
 */
export function vpcFlowLogs(vpc: sst.aws.Vpc) {
  const region = aws.getRegionOutput().region;
  const account = aws.getCallerIdentityOutput().accountId;
  const groupName = `/aws/vpc/${$app.name}-${$app.stage}/flow-logs`;
  const groupArn = $interpolate`arn:aws:logs:${region}:${account}:log-group:${groupName}`;
  const key = new aws.kms.Key('VpcFlowLogsKey', {
    description: 'Encrypts the VPC flow log group',
    enableKeyRotation: true,
    deletionWindowInDays: 30,
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [
        { sid: 'AccountAdministersTheKey', effect: 'Allow', principals: [{ type: 'AWS', identifiers: [$interpolate`arn:aws:iam::${account}:root`] }], actions: ['kms:*'], resources: ['*'] },
        {
          sid: 'CloudWatchLogsUsesTheKeyForThisGroupOnly',
          effect: 'Allow',
          principals: [{ type: 'Service', identifiers: [$interpolate`logs.${region}.amazonaws.com`] }],
          actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
          resources: ['*'],
          conditions: [{ test: 'ArnEquals', variable: 'kms:EncryptionContext:aws:logs:arn', values: [groupArn] }],
        },
      ],
    }).json,
  });
  const group = new aws.cloudwatch.LogGroup('VpcFlowLogs', { name: groupName, retentionInDays: 365, kmsKeyId: key.arn });
  const role = new aws.iam.Role('VpcFlowLogsRole', {
    description: 'Lets the VPC flow log service write the flow log group',
    assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
      statements: [{
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['vpc-flow-logs.amazonaws.com'] }],
        actions: ['sts:AssumeRole'],
        conditions: [
          { test: 'StringEquals', variable: 'aws:SourceAccount', values: [account] },
          { test: 'ArnLike', variable: 'aws:SourceArn', values: [$interpolate`arn:aws:ec2:${region}:${account}:vpc-flow-log/*`] },
        ],
      }],
    }).json,
  });
  const policy = new aws.iam.RolePolicy('VpcFlowLogsRolePolicy', {
    role: role.name,
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [{ effect: 'Allow', actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [group.arn, $interpolate`${group.arn}:*`] }],
    }).json,
  });
  return new aws.ec2.FlowLog('VpcFlowLog', {
    vpcId: vpc.id,
    trafficType: 'ALL',
    logDestinationType: 'cloud-watch-logs',
    logDestination: group.arn,
    iamRoleArn: role.arn,
    maxAggregationInterval: 60,
  }, { dependsOn: [policy] }); // delivery starts at once: the role must be allowed to write the group first
}

/**
 * The two security groups of a stage. Every rule is a resource of its own (a group with rules inline loses the others), and a rule names a group wherever a group can be named: the database
 * takes 5432 from this stage's service group alone; the service sends to the database by group, to the internet only on 443, and to the VPC's resolver on 53.
 */
export function stageSecurityGroups(vpc: sst.aws.Vpc, vpcCidr: string) {
  const serviceGroup = new aws.ec2.SecurityGroup('ServiceSecurityGroup', { vpcId: vpc.id, description: 'The service of one stage: its port is open to its load balancer alone' });
  const dbGroup = new aws.ec2.SecurityGroup('DbSecurityGroup', { vpcId: vpc.id, description: 'The database of one stage: PostgreSQL from the service of the same stage alone' });
  new aws.vpc.SecurityGroupIngressRule('DbFromService', { securityGroupId: dbGroup.id, referencedSecurityGroupId: serviceGroup.id, ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, description: 'PostgreSQL from the service' });
  new aws.vpc.SecurityGroupEgressRule('ServiceToDatabase', { securityGroupId: serviceGroup.id, referencedSecurityGroupId: dbGroup.id, ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, description: 'PostgreSQL to the database' });
  new aws.vpc.SecurityGroupEgressRule('ServiceToHttps', { securityGroupId: serviceGroup.id, cidrIpv4: '0.0.0.0/0', ipProtocol: 'tcp', fromPort: 443, toPort: 443, description: 'HTTPS to the identity provider, the file store and the registry' });
  new aws.vpc.SecurityGroupEgressRule('ServiceToDnsUdp', { securityGroupId: serviceGroup.id, cidrIpv4: vpcCidr, ipProtocol: 'udp', fromPort: 53, toPort: 53, description: 'Name resolution in the VPC' });
  new aws.vpc.SecurityGroupEgressRule('ServiceToDnsTcp', { securityGroupId: serviceGroup.id, cidrIpv4: vpcCidr, ipProtocol: 'tcp', fromPort: 53, toPort: 53, description: 'Name resolution in the VPC' });
  return { serviceGroup, dbGroup };
}

/** The service's port, open to the load balancer of the service and to nothing else (the load balancer's group exists once the service does). */
export function openServiceToLoadBalancer(serviceGroup: aws.ec2.SecurityGroup, service: sst.aws.Service, port: number) {
  return new aws.vpc.SecurityGroupIngressRule('ServiceFromLoadBalancer', {
    securityGroupId: serviceGroup.id,
    referencedSecurityGroupId: service.nodes.loadBalancer.securityGroups.apply((groups) => groups[0]),
    ipProtocol: 'tcp',
    fromPort: port,
    toPort: port,
    description: 'The service port from the load balancer',
  });
}

/** The VPC's default group, with no rule: nothing may rely on it. It is stripped only once the database and the service of the stage have left it (they run in groups of their own). */
export function stripDefaultGroup(vpc: sst.aws.Vpc, after: unknown[]) {
  return new aws.ec2.DefaultSecurityGroup('VpcDefaultSecurityGroup', { vpcId: vpc.id, ingress: [], egress: [] }, { dependsOn: after as $util.Resource[] });
}
