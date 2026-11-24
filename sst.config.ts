/**
 * The one SST app of the project. The resources live in `infra/`, one file per concern, and are loaded by stage:
 * `descope-dev` manages settings of the development identity-provider project (no cloud resources), and later stages
 * (`staging`) the hosting. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository.
 */
export default $config({
  app(input) {
    return {
      name: 'grimoire',
      removal: 'retain', // a removed stage keeps its resources: nothing here is deleted by accident
      protect: input?.stage === 'staging',
      home: 'aws',
      providers: {
        aws: { version: '7.55.0' },
        descope: { package: '@descope/pulumi-descope', version: '1.0.1' },
      },
    };
  },
  async run() {
    if ($app.stage === 'descope-dev') return await import('./infra/descope-dev').then((m) => m.default());
    throw new Error(`Unknown stage "${$app.stage}". The stages are: descope-dev.`);
  },
});
