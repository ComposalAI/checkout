# Composal Checkout

Check out repositories on Composal runners using a persistent Git object cache.
Replace the checkout step:

```yaml
permissions:
  contents: read

jobs:
  test:
    runs-on: composal-x64-4x
    steps:
      - uses: composalai/checkout@1
      - run: npm ci && npm test
```

Standard `actions/checkout` inputs and credential cleanup are retained, including
`ref`, `path`, `fetch-depth`, tags and sparse checkout. Node 24 and Git are required.
On other runners, the action uses the standard GitHub checkout.

## Cache behavior

Composal prepares Git objects outside the workflow and mounts the cache read-only.
The working tree, `.git` refs, index and credentials stay on local runner disk.
Warm checkouts of an exact commit reuse the mounted objects without an API call
or network fetch. New commits add missing Git objects to the cache.

Caches are scoped to the GitHub installation and repository. All jobs in that
scope can read the cached source. Workflow code cannot update the cache. Only
objects confirmed as readable from the GitHub repository enter it; unpublished
platform refs are excluded. Credentials are never stored in the shared cache.

Full-history checkouts confirm the current branches and tags before using the
mounted objects. When every advertised tip is cached, they skip preparation.

The first checkout of a commit can wait up to 10 seconds for preparation, then
fetch from GitHub while preparation continues for later jobs. If the exact target is not ready, completed cached graphs remain available to
Git as negotiation tips. The normal GitHub transport fetches missing objects
while reusing cached history, trees and blobs. A missing ref also retains a
usable object cache. An absent or unusable cache uses the standard transport. For large cold
repositories, increase the preparation wait:

```yaml
- uses: composalai/checkout@1
  with:
    cache-wait-seconds: 120  # 0 to 300; default 10
    fetch-depth: 0         # all branches, tags and history
```

SSH, Git LFS, submodules, other repositories, enterprise GitHub instances and
container jobs without the cache mount use the standard transport. Their inputs
still work. Choosing this action does not enable source access beyond the
repository configured for the runner pool.

## Use Git inside a later container action

By default, `.git/objects/info/alternates` references the mounted cache. If a later
container action needs Git history but cannot access that mount, copy the needed
objects into the local checkout:

```yaml
- uses: composalai/checkout@1
  with:
    dissociate: true
```

This adds time and local disk usage. Ordinary workflow steps can keep the default.
There is no archive restore, copy-back or per-job garbage collection on the shared
cache. Objects remain available to concurrent jobs.

## Outputs

- `commit` and `ref`: standard checkout outputs.
- `cache-hit`: whether the requested Git objects were already cached. A false
  value can still reuse older cached objects for an incremental GitHub fetch.
- `checkout-source`: `cache` or `github`. `github` identifies the transport for
  missing objects; it does not imply that the entire repository was downloaded.

See the [runner guide](https://composal.ai/docs/github-actions-runners#checkout-cache)
for runner setup and cache behavior.

## Development

```sh
npm ci
npm test -- --runInBand
npm run build
```

This action is based on MIT-licensed `actions/checkout` v7. The pinned source and
integration points are recorded in [UPSTREAM.md](UPSTREAM.md). Rebuild and commit
`dist/` when changing TypeScript. Standard checkout behavior and post-job auth
cleanup stay with the upstream implementation.
