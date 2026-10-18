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

When preparation is still pending after the configured wait, checkout keeps any
completed cached history attached and fetches missing objects from GitHub. A
verified cached tip helps Git negotiate that fetch. Preparation continues for
later jobs. A failed local-cache fetch also retains the mounted objects.

The preparation wait defaults to 10 seconds. Set `cache-wait-seconds: 0` to start
the GitHub fetch immediately, reusing mounted history when available. For a large
cold repository, increase the wait:

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
- `cache-available`: whether checkout attached the mounted Git object cache.
- `cache-hit`: whether the requested Git objects were already cached. A missing
  commit can report `false` while `cache-available` is `true`.
- `checkout-source`: `cache` or `github`. A GitHub fetch can still reuse mounted
  objects when `cache-available` is `true`.

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
