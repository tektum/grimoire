---
name: answer-review
description: Use when a Grimoire pull request has review comments, from people or review bots. Read every comment through the API, decide fix or reason, reply on each thread, and resolve the threads you answered.
---

# Answer review

Every thread gets an answer: a fix or a reason. Never leave a thread silent. Never dismiss a security finding without checking it against the code.

Use `timeout 60` on every `gh` call. Set `N` to the pull request number.

## 1. Read everything

Comments come in three places. Read all three.

```bash
timeout 60 gh api repos/tektum/grimoire/pulls/$N/comments --paginate   # inline comments
timeout 60 gh api repos/tektum/grimoire/pulls/$N/reviews --paginate    # review summaries
timeout 60 gh api repos/tektum/grimoire/issues/$N/comments --paginate  # conversation
```

List the threads with their ids and state (GraphQL):

```bash
timeout 60 gh api graphql -f query='
query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$n){
    reviewThreads(first:100){ nodes{ id isResolved
      comments(first:20){ nodes{ databaseId author{login} path body } } } } } } }' \
  -f owner=tektum -f repo=grimoire -F n=$N
```

## 2. Classify each thread

- **Valid and small**: fix it, in a new commit. Add a test that fails without the fix.
- **Valid and large**: split it into its own pull request, say so in the reply, and link it.
- **Not valid**: write the reason, with a file and line or a command output as evidence.
- **Security finding**: reproduce it first. Fix it, or prove it cannot happen. If it needs a decision about a trust boundary, stop and ask.

## 3. Reply

Reply on the thread. Name the commit for a fix. Be short and concrete.

```bash
timeout 60 gh api -X POST repos/tektum/grimoire/pulls/$N/comments/<databaseId>/replies \
  -f body="Fixed in <sha>: <what changed>."
```

## 4. Resolve

Resolve only threads you answered.

```bash
timeout 60 gh api graphql -f query='
mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -f id=<thread id>
```

If GraphQL times out, retry once; do not loop.

## 5. Finish

Run the local gate again (see `small-pull-request`), push, and re-list the threads: none may stay unresolved. Check that CI is green and auto-merge is still on.
