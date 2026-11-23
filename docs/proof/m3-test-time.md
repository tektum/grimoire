# Test time of the milestone 3 suites

How long the suites take and why. All figures are job times of one named run on the public repository's `main` (run 45152036867, commit 8150405) on the project's CI runners; a job time includes installing, building and starting the stack, and they vary by about a quarter from run to run.

| Job | Time | What takes the time |
|---|---|---|
| Static checks | 24 s | lint, type check, the checks of the tools |
| Unit tests | 3 min 20 s | about 3,700 tests, with coverage thresholds; the build comes first |
| Integration tests | 4 min 54 s | the suites that start the real server as a child process against PostgreSQL |
| Exit test M1 | 3 min 25 s | ten collaboration scenarios against the running stack |
| Exit test M2 | 3 min 34 s | five Markdown scenarios; `hostile-neighbour` alone types for 45 seconds |
| Exit test M3 | 4 min 57 s | nine sign-in and access scenarios against the local key server |
| Image and stack | 1 min 1 s | building the image and starting the stack |

## Why the M3 exit test takes about five minutes

- **Scenarios wait on real time where the product does.** `key-server-outage` stops the key server, holds a session open through four re-check rounds (20 seconds), restarts the key server and waits up to 90 seconds for a token of the new key (the SDK's 30-second unknown-key cooldown bounds it); `session-expiry` waits for a real expiry; `pre-sign-in` waits for the 5-second pre-authentication timeout.
- **Every wait is a condition with a bound,** not a fixed sleep; the lint check (`bun run lint`) refuses a fixed sleep over 250 ms unless the line is allow-listed with a reason (for example the negative checks "this socket must not close past its 250 ms timer").
- **The scenarios restart containers** (the key server and the database) so that outages are real; each restart costs the start-up time of that container. (The application is only recreated by the mutation check, which is a separate job.)
- **Parallelism is limited on purpose:** the scenarios share one stack and one key server and run one after the other, so that a scenario's outage does not disturb the next.

## What changed the integration time

The integration suite replaced most of its fixed sleeps with condition waits (the remaining ones are allow-listed with a reason) and now starts each server on a port the kernel chooses; the exit test M3 grew from one scenario (about 1 minute 10 seconds) to nine (about 5 minutes) as the scenarios were added. The comparison "before and after the condition waits" was not recorded as a pair of runs on the same machine, so no saving is claimed here.
