import * as core from '@actions/core'
import {spawnSync} from 'node:child_process'
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

function run(args: string[], cwd: string, input?: string): string {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 60_000,
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

export async function prepare(
  settings: IGitSourceSettings,
  cacheRoot = root
): Promise<CheckoutCache | undefined> {
  core.setOutput('cache-hit', false)
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
    if (
      oid.test(settings.commit) &&
      settings.fetchDepth > 0 &&
      !settings.fetchTags &&
      !settings.ref.startsWith('refs/tags/')
    ) {
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
        }
      } catch {
        /* A cold cache is prepared outside the workflow container. */
      }
    }
    if (!manifest) {
      if (
        !process.env.COMPOSAL_CHECKOUT_API_URL ||
        !process.env.COMPOSAL_CHECKOUT_TOKEN
      )
        return
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
    core.info(
      `Composal checkout: ${manifest.cache_hit ? 'warm' : 'prepared'} Git object cache`
    )
    return cache
  } catch {
    core.info('Composal checkout cache unavailable; fetching from GitHub.')
    core.setOutput('cache-hit', false)
    return
  }
}

export class CheckoutCache {
  private enabled = true
  private constructor(
    private readonly workspace: string,
    private readonly localOrigin: string,
    private readonly manifest: Manifest,
    private readonly alternateFile: string,
    private readonly previousAlternates: string
  ) {}

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
        `${objects}\n`
    )
    return new CheckoutCache(
      workspace,
      localOrigin,
      manifest,
      alternateFile,
      previous
    )
  }

  async fetch(refSpec: string[], options: FetchOptions): Promise<boolean> {
    if (!this.enabled) return false
    const seed = 'refs/composal/cache-seed'
    try {
      run(['update-ref', seed, this.manifest.commit], this.workspace)
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
      this.enabled = false
      await fs.writeFile(this.alternateFile, this.previousAlternates)
      core.info(
        'Composal checkout cache could not supply this ref; fetching from GitHub.'
      )
      core.setOutput('checkout-source', 'github')
      return false
    } finally {
      run(['update-ref', '-d', seed], this.workspace)
    }
  }

  async dissociate(): Promise<void> {
    if (!this.enabled) return
    run(['repack', '-a', '-d'], this.workspace)
    await fs.writeFile(this.alternateFile, this.previousAlternates)
  }
}
