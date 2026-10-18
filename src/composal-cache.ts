import * as core from '@actions/core'
import {spawnSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'
import {IGitSourceSettings} from './git-source-settings.js'

const root = '/opt/composal/git-cache'
const oid = /^[0-9a-f]{40}$/
type Manifest = {
  commit: string
  object_oid: string
  refs: Record<string, string>
  cache_hit?: boolean
}
type FetchOptions = {
  fetchDepth?: number
  filter?: string
  showProgress?: boolean
}

function run(
  args: string[],
  cwd: string,
  input?: string,
  timeout = 60_000,
  environment: NodeJS.ProcessEnv = {}
): string {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    env: {...process.env, ...environment},
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0)
    throw new Error('Local checkout cache operation failed')
  return result.stdout.trim()
}

async function request(body: object, deadline: number): Promise<any> {
  const response = await fetch(process.env.COMPOSAL_CHECKOUT_API_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.COMPOSAL_CHECKOUT_TOKEN}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(10_000, deadline - Date.now()))
    )
  })
  if (!response.ok) throw new Error('Checkout cache unavailable')
  return response.json()
}

async function mountedTip(
  settings: IGitSourceSettings,
  cacheRoot: string
): Promise<string | undefined> {
  const objects = path.resolve(cacheRoot, 'objects')
  try {
    if (!(await fs.stat(objects)).isDirectory()) return
  } catch {
    return
  }
  const hint = createHash('sha256')
    .update(settings.ref || settings.commit)
    .digest('hex')
  const candidates: unknown[] = [settings.commit]
  for (const name of [hint, 'recent']) {
    try {
      candidates.push(
        JSON.parse(
          await fs.readFile(path.join(cacheRoot, 'hints', name), 'utf8')
        )
      )
    } catch {
      /* This repository may not have a previous completed preparation. */
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !oid.test(candidate)) continue
    try {
      await fs.access(path.join(cacheRoot, 'complete', candidate))
      return run(
        ['rev-parse', '--verify', `${candidate}^{commit}`],
        settings.repositoryPath,
        undefined,
        5000,
        {GIT_OBJECT_DIRECTORY: objects}
      )
    } catch {
      /* A hint alone does not prove its objects are readable. */
    }
  }
}

async function attachAlternate(workspace: string, cacheRoot: string) {
  const alternateFile = path.join(
    workspace,
    '.git',
    'objects',
    'info',
    'alternates'
  )
  let previous = ''
  try {
    previous = await fs.readFile(alternateFile, 'utf8')
  } catch {
    /* New checkout. */
  }
  await fs.mkdir(path.dirname(alternateFile), {recursive: true})
  await fs.writeFile(
    alternateFile,
    previous +
      (previous && !previous.endsWith('\n') ? '\n' : '') +
      `${path.resolve(cacheRoot, 'objects')}\n`
  )
  return {alternateFile, previous}
}

export async function prepare(
  settings: IGitSourceSettings,
  cacheRoot = root
): Promise<CheckoutCache | undefined> {
  core.setOutput('cache-hit', false)
  core.setOutput('cache-available', false)
  const repository = `${settings.repositoryOwner}/${settings.repositoryName}`
  // All upstream inputs remain supported. These cases use the normal transport.
  if (
    repository.toLowerCase() !== process.env.GITHUB_REPOSITORY?.toLowerCase() ||
    settings.sshKey ||
    settings.lfs ||
    settings.submodules ||
    (settings.githubServerUrl &&
      new URL(settings.githubServerUrl).hostname !== 'github.com')
  )
    return
  try {
    await fs.access(cacheRoot)
    let manifest: Manifest | undefined
    if (oid.test(settings.commit) && !settings.ref.startsWith('refs/tags/')) {
      try {
        const marker = JSON.parse(
          await fs.readFile(
            path.join(cacheRoot, 'commits', settings.commit),
            'utf8'
          )
        )
        if (
          marker.commit === settings.commit &&
          marker.object_oid === settings.commit
        ) {
          manifest = {
            commit: settings.commit,
            object_oid: settings.commit,
            refs: settings.ref.startsWith('refs/')
              ? {[settings.ref]: settings.commit}
              : {},
            cache_hit: true
          }
          if (settings.fetchDepth <= 0 || settings.fetchTags) {
            // A fresh advertisement preserves branch/tag freshness. The mounted
            // completion markers prove their entire object graphs are present.
            // No preparation task is needed for an already populated cache.
            const advertised = run(
              ['ls-remote', '--refs', 'origin', 'refs/heads/*', 'refs/tags/*'],
              settings.repositoryPath,
              undefined,
              5000
            )
            const refs: Record<string, string> = {}
            for (const line of advertised.split('\n').filter(Boolean)) {
              const [value, name] = line.split('\t')
              if (
                !oid.test(value) ||
                !name?.startsWith('refs/') ||
                /[\x00-\x20\x7f]/.test(name)
              )
                throw new Error('Invalid advertised checkout ref')
              refs[name] = value
            }
            const completed = new Set(
              await fs.readdir(path.join(cacheRoot, 'complete'))
            )
            if (!Object.values(refs).every(value => completed.has(value)))
              throw new Error('Advertised refs need cache preparation')
            manifest.refs = {...refs, ...manifest.refs}
          }
        }
      } catch {
        manifest = undefined
        /* A cold cache is prepared outside the workflow container. */
      }
    }
    if (!manifest) {
      if (
        !process.env.COMPOSAL_CHECKOUT_API_URL ||
        !process.env.COMPOSAL_CHECKOUT_TOKEN
      )
        throw new Error('Checkout cache preparation unavailable')
      const wait = Number(core.getInput('cache-wait-seconds') || '10')
      if (!Number.isFinite(wait) || wait < 0 || wait > 300)
        throw new Error('Invalid cache wait')
      const deadline = Date.now() + wait * 1000
      let receipt = await request(
        {
          operation: 'prepare',
          repository,
          ref: settings.ref || settings.commit,
          sha: settings.commit || undefined,
          all_refs: settings.fetchDepth <= 0 || settings.fetchTags
        },
        deadline
      )
      const ticket = receipt.ticket
      while (receipt.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve =>
          setTimeout(
            resolve,
            Math.min(1000, Math.max(0, deadline - Date.now()))
          )
        )
        receipt = await request({operation: 'status', ticket}, deadline)
      }
      if (receipt.status !== 'ready')
        throw new Error('Checkout cache preparation still running')
      manifest = receipt
    }
    if (
      !manifest ||
      !oid.test(manifest.commit) ||
      !oid.test(manifest.object_oid) ||
      (settings.commit && settings.commit !== manifest.commit)
    )
      throw new Error('Invalid checkout cache identity')
    const cache = await CheckoutCache.create(
      settings.repositoryPath,
      manifest,
      cacheRoot
    )
    core.setOutput('cache-hit', manifest.cache_hit === true)
    core.setOutput('cache-available', true)
    core.info(
      `Composal checkout: ${manifest.cache_hit ? 'warm' : 'prepared'} Git object cache`
    )
    return cache
  } catch {
    try {
      const tip = await mountedTip(settings, cacheRoot)
      if (tip) {
        const cache = await CheckoutCache.incremental(
          settings.repositoryPath,
          tip,
          cacheRoot
        )
        core.setOutput('cache-available', true)
        core.info(
          'Composal checkout: requested refs are not ready; reusing mounted Git objects for an incremental GitHub fetch.'
        )
        return cache
      }
    } catch {
      /* The mount is unavailable; the normal GitHub transport still works. */
    }
    core.info(
      'Composal checkout: no usable mounted Git object cache; fetching from GitHub.'
    )
    core.setOutput('cache-hit', false)
    return
  }
}

export class CheckoutCache {
  private localFetchEnabled = true
  private constructor(
    private readonly workspace: string,
    private readonly localOrigin: string | undefined,
    private readonly commit: string,
    private readonly alternateFile: string,
    private readonly previousAlternates: string
  ) {}

  static async incremental(
    workspace: string,
    commit: string,
    cacheRoot = root
  ): Promise<CheckoutCache> {
    if (!oid.test(commit)) throw new Error('Invalid checkout cache identity')
    const {alternateFile, previous} = await attachAlternate(
      workspace,
      cacheRoot
    )
    return new CheckoutCache(
      workspace,
      undefined,
      commit,
      alternateFile,
      previous
    )
  }

  static async create(
    workspace: string,
    manifest: Manifest,
    cacheRoot = root
  ): Promise<CheckoutCache> {
    const localOrigin = await fs.mkdtemp(
      path.join(process.env.RUNNER_TEMP || '/tmp', 'composal-checkout-')
    )
    run(['init', '--bare', localOrigin], localOrigin)
    const objects = path.join(cacheRoot, 'objects')
    await fs.writeFile(
      path.join(localOrigin, 'objects', 'info', 'alternates'),
      `${objects}\n`
    )
    run(['config', 'uploadpack.allowFilter', 'true'], localOrigin)
    const refs = {...manifest.refs, 'refs/composal/target': manifest.object_oid}
    const commands: string[] = []
    for (const [name, value] of Object.entries(refs)) {
      if (
        !oid.test(value) ||
        !name.startsWith('refs/') ||
        /[\x00-\x20\x7f]/.test(name)
      )
        throw new Error('Invalid checkout cache ref')
      commands.push(`create ${name} ${value}`)
    }
    // update-ref validates the complete batch, including every ref name.
    run(['update-ref', '--stdin'], localOrigin, commands.join('\n') + '\n')
    const {alternateFile, previous} = await attachAlternate(
      workspace,
      cacheRoot
    )
    return new CheckoutCache(
      workspace,
      localOrigin,
      manifest.commit,
      alternateFile,
      previous
    )
  }

  async fetch(
    refSpec: string[],
    options: FetchOptions,
    fetchFromGitHub?: () => Promise<void>
  ): Promise<boolean> {
    const seed = `refs/composal/cache-seed-${randomUUID()}`
    let seeded = false
    try {
      try {
        run(['update-ref', seed, this.commit], this.workspace)
        seeded = true
      } catch {
        this.localFetchEnabled = false
      }
      if (this.localFetchEnabled && this.localOrigin) {
        try {
          const args = [
            '-c',
            'protocol.version=2',
            'fetch',
            '--no-tags',
            '--no-recurse-submodules'
          ]
          if (options.fetchDepth && options.fetchDepth > 0)
            args.push(`--depth=${options.fetchDepth}`)
          else {
            try {
              await fs.access(path.join(this.workspace, '.git', 'shallow'))
              args.push('--unshallow')
            } catch {
              /* Full checkout. */
            }
          }
          if (options.filter) args.push(`--filter=${options.filter}`)
          args.push(pathToFileURL(this.localOrigin).href, ...refSpec)
          run(args, this.workspace)
          core.setOutput('checkout-source', 'cache')
          return true
        } catch {
          this.localFetchEnabled = false
          core.info(
            'Composal checkout: local cache could not supply this ref; retaining mounted objects for a GitHub fetch.'
          )
        }
      }
      core.setOutput('cache-hit', false)
      core.setOutput('checkout-source', 'github')
      await fetchFromGitHub?.()
      return false
    } finally {
      if (seeded) run(['update-ref', '-d', seed], this.workspace)
    }
  }

  async dissociate(): Promise<void> {
    run(['repack', '-a', '-d'], this.workspace)
    await fs.writeFile(this.alternateFile, this.previousAlternates)
  }
}
