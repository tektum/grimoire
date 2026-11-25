# Changing the security group of a running stage

Each stage has a service group and a database group (`infra/stack/network.ts`): the database takes 5432 from the service group of its own stage and from nothing else. A deploy that changes which group the database accepts, on a stage that is already running, has a window in which the running task is outside the new rule. This happened once, when the stages moved to one shared VPC: the database group changed before the service did, the running task lost the database, failed its health check, and its replacement (of the old definition, in the old group) could not reach the database either and blocked the new task from starting. The site answered 503 for about seven minutes.

## The rule: additive first

1. **Add** the new group to the database's rule and keep the old one. Deploy. Both the running task and the new one reach the database.
2. **Move** the service to the new group. Deploy. The rollout replaces the task, which now runs in the new group.
3. **Remove** the old group from the database's rule. Deploy.

Each step is one pull request whose plan shows only in-place changes. The same holds for the load balancer's group and the service's port rule: never take a rule away before what used it has moved.

A stage that does not exist yet has no window: it is made with the new groups.

## What watches for it

The deploy workflow ends with `tools/deploy/wait-healthy.sh`: the run is green only when the service has one complete deployment with every task running and `/readyz` answers 200 three times in a row, and it fails the run otherwise. A deploy that leaves a stage without a healthy task turns the run red instead of ending quietly. The ECS deployment circuit breaker (rollback on) is already on for every stage; it counts failed tasks, so it does not trip when no task starts, which is why the gate polls the outcome.

## The production network

When production exists it will own the shared VPC (the stage that owns it must be protected, and a test checks this). Moving the ownership means moving the other stages' databases and services into it, one stage at a time: follow the three steps above for each, with a snapshot before each stage and the gate watching the run.
