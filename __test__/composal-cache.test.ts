import {afterEach, beforeEach, expect, jest, test} from '@jest/globals'
import {spawnSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {CheckoutCache, prepare} from '../src/composal-cache.js'
import {IGitSourceSettings} from '../src/git-source-settings.js'

let temporary: string
let origin: string
let workspace: string
let cacheRoot: string
let first: string
let second: string
let oldRunnerTemp: string | undefined

function git(args: string[], cwd = workspace): string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'})
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-test-'))
  origin = path.join(temporary, 'origin')
  workspace = path.join(temporary, 'workspace')
  cacheRoot = path.join(temporary, 'cache.git')
  await fs.mkdir(origin)
  await fs.mkdir(workspace)
  git(['init', '-b', 'main'], origin)
  git(['config', 'user.name', 'Test'], origin)
  git(['config', 'user.email', 'test@example.com'], origin)
  await fs.mkdir(path.join(origin, 'src'))
  await fs.writeFile(path.join(origin, 'src', 'one'), 'first')
  git(['add', '.'], origin)
  git(['commit', '-m', 'first'], origin)
  first = git(['rev-parse', 'HEAD'], origin)
  await fs.writeFile(path.join(origin, 'root-file'), 'second')
  git(['add', '.'], origin)
  git(['commit', '-m', 'second'], origin)
  git(['tag', '-a', 'v1', '-m', 'release'], origin)
  second = git(['rev-parse', 'HEAD'], origin)
  git(['clone', '--bare', origin, cacheRoot], origin)
  git(['init'], workspace)
  git(['remote', 'add', 'origin', 'https://github.com/example/repo.git'])
  oldRunnerTemp = process.env.RUNNER_TEMP
  process.env.RUNNER_TEMP = temporary
})

afterEach(async () => {
  jest.restoreAllMocks()
  if (oldRunnerTemp === undefined) delete process.env.RUNNER_TEMP
  else process.env.RUNNER_TEMP = oldRunnerTemp
  await fs.rm(temporary, {recursive: true, force: true})
})

test('asynchronous preparation keeps the signed ticket across multiple pending replies', async () => {
  const previous = {...process.env}
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'example/repo',
    COMPOSAL_CHECKOUT_API_URL: 'https://composal.example/api/checkout',
    COMPOSAL_CHECKOUT_TOKEN: 'private-fixture-token',
    'INPUT_CACHE-WAIT-SECONDS': '5'
  })
  const bodies: any[] = []
  const replies = [
    {status: 'pending', ticket: 'signed-ticket'},
    {status: 'pending'},
    {
      status: 'ready',
      commit: second,
      object_oid: second,
      refs: {'refs/heads/main': second}
    }
  ]
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string))
    return {ok: true, json: async () => replies.shift()} as Response
  })
  try {
    const settings = {
      repositoryOwner: 'example',
      repositoryName: 'repo',
      repositoryPath: workspace,
      ref: 'refs/heads/main',
      commit: second,
      fetchDepth: 1
    } as IGitSourceSettings
    const result = await prepare(settings, cacheRoot)
    expect(result).toBeInstanceOf(CheckoutCache)
    expect(bodies.slice(1)).toEqual([
      {operation: 'status', ticket: 'signed-ticket'},
      {operation: 'status', ticket: 'signed-ticket'}
    ])
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

test('an empty mounted cache requests preparation before objects exist', async () => {
  const previous = {...process.env}
  const emptyMount = path.join(temporary, 'empty-mount')
  await fs.mkdir(emptyMount)
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'example/repo',
    COMPOSAL_CHECKOUT_API_URL: 'https://composal.example/api/checkout',
    COMPOSAL_CHECKOUT_TOKEN: 'private-fixture-token'
  })
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      await fs.cp(
        path.join(cacheRoot, 'objects'),
        path.join(emptyMount, 'objects'),
        {recursive: true}
      )
      return {
        ok: true,
        json: async () => ({
          status: 'ready',
          commit: second,
          object_oid: second,
          refs: {'refs/heads/main': second},
          cache_hit: false
        })
      } as Response
    })
  try {
    const result = await prepare(
      {
        repositoryOwner: 'example',
        repositoryName: 'repo',
        repositoryPath: workspace,
        ref: 'refs/heads/main',
        commit: second,
        fetchDepth: 1
      } as IGitSourceSettings,
      emptyMount
    )
    expect(result).toBeInstanceOf(CheckoutCache)
    expect(request).toHaveBeenCalledTimes(1)
    expect(
      await result!.fetch([`+${second}:refs/remotes/origin/main`], {
        fetchDepth: 1
      })
    ).toBe(true)
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

test('a warm exact-commit checkout makes no cache API call', async () => {
  const previous = process.env.GITHUB_REPOSITORY
  process.env.GITHUB_REPOSITORY = 'example/repo'
  await fs.mkdir(path.join(cacheRoot, 'commits'))
  await fs.writeFile(
    path.join(cacheRoot, 'commits', second),
    JSON.stringify({commit: second, object_oid: second})
  )
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('API must not be called'))
  try {
    const result = await prepare(
      {
        repositoryOwner: 'example',
        repositoryName: 'repo',
        repositoryPath: workspace,
        ref: 'refs/heads/main',
        commit: second,
        fetchDepth: 1
      } as IGitSourceSettings,
      cacheRoot
    )
    expect(result).toBeInstanceOf(CheckoutCache)
    expect(request).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = previous
  }
})

test('warm full history confirms live refs and uses mounted objects without preparation', async () => {
  const previous = process.env.GITHUB_REPOSITORY
  process.env.GITHUB_REPOSITORY = 'example/repo'
  const tag = git(['rev-parse', 'refs/tags/v1'], origin)
  git(['remote', 'set-url', 'origin', origin])
  await fs.mkdir(path.join(cacheRoot, 'commits'))
  await fs.mkdir(path.join(cacheRoot, 'complete'))
  await fs.writeFile(
    path.join(cacheRoot, 'commits', second),
    JSON.stringify({commit: second, object_oid: second})
  )
  for (const value of [second, tag])
    await fs.writeFile(path.join(cacheRoot, 'complete', value), '{}')
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Preparation must not be called'))
  try {
    const result = await prepare(
      {
        repositoryOwner: 'example',
        repositoryName: 'repo',
        repositoryPath: workspace,
        ref: 'refs/heads/main',
        commit: second,
        fetchDepth: 0
      } as IGitSourceSettings,
      cacheRoot
    )
    expect(result).toBeInstanceOf(CheckoutCache)
    expect(request).not.toHaveBeenCalled()
    expect(
      await result!.fetch(
        ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
        {}
      )
    ).toBe(true)
    git(['checkout', '--detach', 'refs/remotes/origin/main'])
    expect(git(['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(git(['rev-parse', 'refs/tags/v1'])).toBe(tag)
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = previous
  }
})

test('full history prepares newly advertised tips even when the target commit is warm', async () => {
  const previous = {...process.env}
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'example/repo',
    COMPOSAL_CHECKOUT_API_URL: 'https://composal.example/api/checkout',
    COMPOSAL_CHECKOUT_TOKEN: 'private-fixture-token'
  })
  git(['branch', 'new-branch', first], origin)
  git(['remote', 'set-url', 'origin', origin])
  const tag = git(['rev-parse', 'refs/tags/v1'], origin)
  await fs.mkdir(path.join(cacheRoot, 'commits'))
  await fs.mkdir(path.join(cacheRoot, 'complete'))
  await fs.writeFile(
    path.join(cacheRoot, 'commits', second),
    JSON.stringify({commit: second, object_oid: second})
  )
  for (const value of [second, tag])
    await fs.writeFile(path.join(cacheRoot, 'complete', value), '{}')
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'ready',
      commit: second,
      object_oid: second,
      refs: {'refs/heads/main': second, 'refs/heads/new-branch': first}
    })
  } as Response)
  try {
    const result = await prepare(
      {
        repositoryOwner: 'example',
        repositoryName: 'repo',
        repositoryPath: workspace,
        ref: 'refs/heads/main',
        commit: second,
        fetchDepth: 0
      } as IGitSourceSettings,
      cacheRoot
    )
    expect(result).toBeInstanceOf(CheckoutCache)
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({
      operation: 'prepare',
      all_refs: true
    })
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

async function cache(
  refs: Record<string, string> = {'refs/heads/main': second}
) {
  return CheckoutCache.create(
    workspace,
    {commit: second, object_oid: second, refs, cache_hit: true},
    cacheRoot
  )
}

test('shallow checkout borrows cached objects without copying the object store', async () => {
  const checkout = await cache()
  expect(
    await checkout.fetch([`+${second}:refs/remotes/origin/main`], {
      fetchDepth: 1
    })
  ).toBe(true)
  git(['checkout', '-B', 'main', 'refs/remotes/origin/main'])
  expect(git(['rev-parse', 'HEAD'])).toBe(second)
  expect(git(['rev-list', '--count', 'HEAD'])).toBe('1')
  expect(await fs.readFile(path.join(workspace, 'root-file'), 'utf8')).toBe(
    'second'
  )
  expect(git(['count-objects', '-v']).split('\n')).toContain('in-pack: 0')
  expect(git(['remote', 'get-url', 'origin'])).toBe(
    'https://github.com/example/repo.git'
  )
})

test('full history, annotated tags and sparse checkout keep standard Git behavior', async () => {
  const tag = git(['rev-parse', 'refs/tags/v1'], origin)
  const checkout = await cache({'refs/heads/main': second, 'refs/tags/v1': tag})
  expect(
    await checkout.fetch(
      ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
      {}
    )
  ).toBe(true)
  git(['sparse-checkout', 'set', '--no-cone', '/src/'])
  git(['checkout', '--detach', 'v1'])
  expect(git(['rev-parse', 'HEAD'])).toBe(second)
  expect(git(['rev-list', '--count', 'HEAD'])).toBe('2')
  expect(git(['rev-parse', 'v1'])).toBe(tag)
  expect(await fs.readFile(path.join(workspace, 'src', 'one'), 'utf8')).toBe(
    'first'
  )
  await expect(fs.access(path.join(workspace, 'root-file'))).rejects.toThrow()
})

test('bulk ref creation rejects invalid names without publishing local refs', async () => {
  await expect(
    cache({'refs/heads/main': second, 'refs/heads/invalid..name': first})
  ).rejects.toThrow('Local checkout cache operation failed')
})

test('dissociate makes the checkout usable after the mounted cache disappears', async () => {
  const checkout = await cache()
  expect(
    await checkout.fetch([`+${second}:refs/remotes/origin/main`], {
      fetchDepth: 1
    })
  ).toBe(true)
  git(['checkout', '-B', 'main', 'refs/remotes/origin/main'])
  await checkout.dissociate()
  await fs.rename(cacheRoot, path.join(temporary, 'cache-unmounted'))
  expect(git(['show', 'HEAD:src/one'])).toBe('first')
  expect(git(['fsck', '--no-reflogs'])).not.toContain('missing')
})

test('a missing ref retains valid cached objects for incremental GitHub fetching', async () => {
  const checkout = await cache()
  expect(
    await checkout.fetch(
      ['+refs/heads/missing:refs/remotes/origin/missing'],
      {}
    )
  ).toBe(false)
  expect(
    await fs.readFile(
      path.join(workspace, '.git', 'objects', 'info', 'alternates'),
      'utf8'
    )
  ).toContain('composal-checkout-')
  expect(git(['for-each-ref', '--format=%(refname)'])).not.toContain(
    'cache-seed'
  )
  git(['fetch', new URL(`file://${origin}`).href, 'main'])
  git(['checkout', '--detach', 'FETCH_HEAD'])
  expect(git(['rev-parse', 'HEAD'])).toBe(second)
})

test('malformed cached ref metadata cannot write outside the temporary ref database', async () => {
  await expect(
    cache({[`refs/heads/main ${second}\ncreate refs/heads/injected`]: second})
  ).rejects.toThrow()
  await expect(
    fs.access(path.join(workspace, '.git', 'objects', 'info', 'alternates'))
  ).rejects.toThrow()
})

test('a pending target reuses completed cached history and transfers only new objects', async () => {
  const previous = {...process.env}
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'example/repo',
    COMPOSAL_CHECKOUT_API_URL: 'https://composal.example/api/checkout',
    COMPOSAL_CHECKOUT_TOKEN: 'fixture-token',
    'INPUT_CACHE-WAIT-SECONDS': '0'
  })
  try {
    const payload = randomBytes(1024 * 1024)
    await fs.writeFile(path.join(origin, 'unchanged-large-file'), payload)
    git(['add', '.'], origin)
    git(['commit', '-m', 'cached baseline'], origin)
    const base = git(['rev-parse', 'HEAD'], origin)
    const blob = git(['rev-parse', 'HEAD:unchanged-large-file'], origin)
    git(['fetch', 'origin', 'main:refs/heads/main'], cacheRoot)
    await fs.mkdir(path.join(cacheRoot, 'complete'))
    await fs.writeFile(path.join(cacheRoot, 'complete', base), '')
    await fs.writeFile(path.join(origin, 'new-file'), 'new data')
    git(['add', '.'], origin)
    git(['commit', '-m', 'uncached target'], origin)
    const target = git(['rev-parse', 'HEAD'], origin)
    git(['remote', 'set-url', 'origin', new URL(`file://${origin}`).href])
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({status: 'pending', ticket: 'fixture-ticket'})
    } as Response)
    const checkout = await prepare(
      {
        repositoryOwner: 'example',
        repositoryName: 'repo',
        repositoryPath: workspace,
        ref: 'refs/heads/main',
        commit: target,
        fetchDepth: 128
      } as IGitSourceSettings,
      cacheRoot
    )
    expect(checkout).toBeInstanceOf(CheckoutCache)
    expect(
      await checkout!.fetch([`+${target}:refs/remotes/origin/main`], {
        fetchDepth: 128
      })
    ).toBe(false)
    const trace = path.join(temporary, 'packets.log')
    const fetched = spawnSync(
      'git',
      [
        '-c',
        'protocol.version=2',
        'fetch',
        '--depth=128',
        'origin',
        `+${target}:refs/remotes/origin/main`
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {...process.env, GIT_TRACE_PACKET: trace}
      }
    )
    expect(fetched.status).toBe(0)
    expect(await fs.readFile(trace, 'utf8')).toContain(`have ${base}`)
    git(['checkout', '--detach', 'refs/remotes/origin/main'])
    expect(
      await fs.readFile(path.join(workspace, 'unchanged-large-file'))
    ).toEqual(payload)
    expect(await fs.readFile(path.join(workspace, 'new-file'), 'utf8')).toBe(
      'new data'
    )
    const counts = Object.fromEntries(
      git(['count-objects', '-v'])
        .split('\n')
        .filter(line => line.includes(': '))
        .map(line => line.split(': '))
    )
    expect(Number(counts.count) + Number(counts['in-pack'])).toBe(3)
    await expect(
      fs.access(
        path.join(workspace, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
      )
    ).rejects.toThrow()
    expect(() => git(['cat-file', '-e', target], cacheRoot)).toThrow()
    await checkout!.dissociate()
    await fs.rename(cacheRoot, `${cacheRoot}-unmounted`)
    expect(git(['show', 'HEAD:new-file'])).toBe('new data')
    expect(git(['fsck', '--no-dangling', '--no-reflogs'])).not.toContain(
      'missing'
    )
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}, 30000)

test('an unavailable object store detaches the cache and permits a normal fetch', async () => {
  const checkout = await cache()
  await fs.rename(cacheRoot, `${cacheRoot}-unmounted`)
  expect(
    await checkout.fetch([`+${second}:refs/remotes/origin/main`], {
      fetchDepth: 1
    })
  ).toBe(false)
  expect(
    await fs.readFile(
      path.join(workspace, '.git', 'objects', 'info', 'alternates'),
      'utf8'
    )
  ).toBe('')
  git(['fetch', origin, 'main'])
  git(['checkout', '--detach', 'FETCH_HEAD'])
  expect(git(['rev-parse', 'HEAD'])).toBe(second)
})
