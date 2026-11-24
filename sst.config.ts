/**
 * The one SST app of the project. Every stage is built by the same function (`infra/stage.ts`) from its row in `infra/stages.json` and the variables of its environment: the stages differ
 * in that data and nothing else, so what is tested on `dev` is what is promoted to `staging`. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository.
 */
export default $config({
  app(input) {
    // `protect` is read here, before any module can be imported (a config may not import), so it is read from the data file by hand; the rows are checked where they are used (`infra/stages.ts`).
    const rows = JSON.parse(process.getBuiltinModule('node:fs').readFileSync('infra/stages.json', 'utf8')) as Record<string, { protect?: boolean } | undefined>;
    return {
      name: 'grimoire',
      removal: 'retain', // a removed stage keeps its resources: nothing here is deleted by accident
      protect: rows[input?.stage ?? '']?.protect === true, // there is no stage while SST installs its providers
      home: 'aws',
      providers: {
        aws: { version: '7.55.0' },
        random: { version: '4.16.6' },
        descope: { package: '@descope/pulumi-descope', version: '1.0.1' },
      },
    };
  },
  async run() {
    const { stageConfig, stageSettings } = await import('./infra/stages.ts');
    const { default: grimoireStage } = await import('./infra/stage.ts');
    return grimoireStage(stageConfig($app.stage), stageSettings($app.stage, process.env));
  },
});
