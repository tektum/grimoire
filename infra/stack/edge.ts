/** The TLS policy of the HTTPS listener: TLS 1.3 and 1.2 only, with forward secrecy (AWS's recommended policy for new load balancers). */
export const TLS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

/**
 * The bucket that receives the access logs of a stage's load balancer: private, encrypted (load balancer logs take SSE-S3 only), TLS only, written by the load balancer service of the region
 * below its own prefix and by nobody else, and emptied after 90 days.
 */
export function loadBalancerLogs() {
  const bucket = new aws.s3.Bucket('LoadBalancerLogs', { forceDestroy: false });
  new aws.s3.BucketPublicAccessBlock('LoadBalancerLogsPublicAccess', { bucket: bucket.id, blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true });
  new aws.s3.BucketServerSideEncryptionConfiguration('LoadBalancerLogsEncryption', { bucket: bucket.id, rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }] });
  new aws.s3.BucketLifecycleConfiguration('LoadBalancerLogsLifecycle', {
    bucket: bucket.id,
    rules: [{ id: 'expire', status: 'Enabled', filter: {}, expiration: { days: 90 }, abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }],
  });
  const account = aws.getCallerIdentityOutput().accountId;
  new aws.s3.BucketPolicy('LoadBalancerLogsPolicy', {
    bucket: bucket.id,
    policy: aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          sid: 'LoadBalancerServiceWritesItsLogs',
          effect: 'Allow',
          principals: [{ type: 'AWS', identifiers: [aws.elb.getServiceAccountOutput({}).arn] }],
          actions: ['s3:PutObject'],
          resources: [$interpolate`${bucket.arn}/alb/AWSLogs/${account}/*`],
        },
        {
          sid: 'OnlyOverTls',
          effect: 'Deny',
          principals: [{ type: '*', identifiers: ['*'] }],
          actions: ['s3:*'],
          resources: [bucket.arn, $interpolate`${bucket.arn}/*`],
          conditions: [{ test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }],
        },
      ],
    }).json,
  });
  return bucket;
}
