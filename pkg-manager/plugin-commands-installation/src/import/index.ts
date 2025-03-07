import path from 'path'
import { docsUrl } from '@pnpm/cli-utils'
import { WANTED_LOCKFILE } from '@pnpm/constants'
import { PnpmError } from '@pnpm/error'
import { readProjectManifestOnly } from '@pnpm/read-project-manifest'
import {
  createOrConnectStoreController,
  CreateStoreControllerOptions,
} from '@pnpm/store-connection-manager'
import gfs from '@pnpm/graceful-fs'
import { install, InstallOptions } from '@pnpm/core'
import { Config } from '@pnpm/config'
import { findWorkspacePackages } from '@pnpm/find-workspace-packages'
import { Project } from '@pnpm/types'
import { logger } from '@pnpm/logger'
import { sequenceGraph } from '@pnpm/sort-packages'
import rimraf from '@zkochan/rimraf'
import loadJsonFile from 'load-json-file'
import mapValues from 'ramda/src/map'
import renderHelp from 'render-help'
import { parse as parseYarnLock } from '@yarnpkg/lockfile'
import * as yarnCore from '@yarnpkg/core'
import { parseSyml } from '@yarnpkg/parsers'
import exists from 'path-exists'
import { getOptionsFromRootManifest } from '../getOptionsFromRootManifest'
import { recursive } from '../recursive'
import { yarnLockFileKeyNormalizer } from './yarnUtil'

interface NpmPackageLock {
  dependencies: LockedPackagesMap
}

interface LockedPackage {
  version: string
  dependencies?: LockedPackagesMap
}

interface LockedPackagesMap {
  [name: string]: LockedPackage
}

interface YarnLockPackage {
  version: string
  resolved: string
  integrity: string
  dependencies?: {
    [name: string]: string
  }
  optionalDependencies?: {
    [depName: string]: string
  }
}
interface YarnPackageLock {
  [name: string]: YarnLockPackage
}

enum YarnLockType {
  yarn = 'yarn',
  yarn2 = 'yarn2'
}

// copy from yarn v1
interface YarnLock2Struct {
  type: YarnLockType.yarn2
  object: YarnPackageLock
}

export const rcOptionsTypes = cliOptionsTypes

export function cliOptionsTypes () {
  return {}
}

export function help () {
  return renderHelp({
    description: `Generates ${WANTED_LOCKFILE} from an npm package-lock.json (or npm-shrinkwrap.json, yarn.lock) file.`,
    url: docsUrl('import'),
    usages: [
      'pnpm import',
    ],
  })
}

export const commandNames = ['import']

export type ImportCommandOptions = Pick<Config,
| 'allProjects'
| 'allProjectsGraph'
| 'selectedProjectsGraph'
| 'workspaceDir'
> & CreateStoreControllerOptions & Omit<InstallOptions, 'storeController' | 'lockfileOnly' | 'preferredVersions'>

export async function handler (
  opts: ImportCommandOptions,
  params: string[]
) {
  // Removing existing pnpm lockfile
  // it should not influence the new one
  await rimraf(path.join(opts.dir, WANTED_LOCKFILE))
  const versionsByPackageNames = {}
  let preferredVersions = {}
  if (await exists(path.join(opts.dir, 'yarn.lock'))) {
    const yarnPackageLockFile = await readYarnLockFile(opts.dir)
    getAllVersionsFromYarnLockFile(yarnPackageLockFile, versionsByPackageNames)
  } else if (
    await exists(path.join(opts.dir, 'package-lock.json')) ||
    await exists(path.join(opts.dir, 'npm-shrinkwrap.json'))
  ) {
    const npmPackageLock = await readNpmLockfile(opts.dir)
    getAllVersionsByPackageNames(npmPackageLock, versionsByPackageNames)
  } else {
    throw new PnpmError('LOCKFILE_NOT_FOUND', 'No lockfile found')
  }
  preferredVersions = getPreferredVersions(versionsByPackageNames)

  // For a workspace with shared lockfile
  if (opts.workspaceDir) {
    const allProjects = opts.allProjects ?? await findWorkspacePackages(opts.workspaceDir, opts)
    const selectedProjectsGraph = opts.selectedProjectsGraph ?? selectProjectByDir(allProjects, opts.dir)
    if (selectedProjectsGraph != null) {
      const sequencedGraph = sequenceGraph(selectedProjectsGraph)
      // Check and warn if there are cyclic dependencies
      if (!sequencedGraph.safe) {
        const cyclicDependenciesInfo = sequencedGraph.cycles.length > 0
          ? `: ${sequencedGraph.cycles.map(deps => deps.join(', ')).join('; ')}`
          : ''
        logger.warn({
          message: `There are cyclic workspace dependencies${cyclicDependenciesInfo}`,
          prefix: opts.workspaceDir,
        })
      }
      await recursive(allProjects,
        params,
        // @ts-expect-error
        {
          ...opts,
          lockfileOnly: true,
          selectedProjectsGraph,
          preferredVersions,
          workspaceDir: opts.workspaceDir,
        },
        'import'
      )
    }
    return
  }

  const store = await createOrConnectStoreController(opts)
  const manifest = await readProjectManifestOnly(opts.dir)
  const installOpts = {
    ...opts,
    ...getOptionsFromRootManifest(manifest),
    lockfileOnly: true,
    preferredVersions,
    storeController: store.ctrl,
    storeDir: store.dir,
  }
  await install(manifest, installOpts)
}

async function readYarnLockFile (dir: string) {
  try {
    const yarnLockFile = await gfs.readFile(path.join(dir, 'yarn.lock'), 'utf8')
    let lockJsonFile
    const yarnLockFileType = getYarnLockfileType(yarnLockFile)
    if (yarnLockFileType === YarnLockType.yarn) {
      lockJsonFile = parseYarnLock(yarnLockFile)
      if (lockJsonFile.type === 'success') {
        return lockJsonFile.object
      } else {
        throw new PnpmError('YARN_LOCKFILE_PARSE_FAILED', `Yarn.lock file was ${lockJsonFile.type}`)
      }
    } else if (yarnLockFileType === YarnLockType.yarn2) {
      lockJsonFile = parseYarn2Lock(yarnLockFile)
      if (lockJsonFile.type === YarnLockType.yarn2) {
        return lockJsonFile.object
      }
    }
  } catch (err: any) { // eslint-disable-line
    if (err['code'] !== 'ENOENT') throw err
  }
  throw new PnpmError('YARN_LOCKFILE_NOT_FOUND', 'No yarn.lock found')
}

function parseYarn2Lock (lockFileContents: string): YarnLock2Struct {
  // eslint-disable-next-line
  const parseYarnLock: any = parseSyml(lockFileContents)

  delete parseYarnLock.__metadata
  const dependencies: YarnPackageLock = {}

  const { structUtils } = yarnCore
  const { parseDescriptor, parseRange } = structUtils
  const keyNormalizer = yarnLockFileKeyNormalizer(
    parseDescriptor,
    parseRange
  )

  Object.entries(parseYarnLock).forEach(
    // eslint-disable-next-line
    ([fullDescriptor, versionData]: [string, any]) => {
      keyNormalizer(fullDescriptor).forEach((descriptor) => {
        dependencies[descriptor] = versionData
      })
    }
  )
  return {
    object: dependencies,
    type: YarnLockType.yarn2,
  }
}

async function readNpmLockfile (dir: string) {
  try {
    return await loadJsonFile<LockedPackage>(path.join(dir, 'package-lock.json'))
  } catch (err: any) { // eslint-disable-line
    if (err['code'] !== 'ENOENT') throw err
  }
  try {
    return await loadJsonFile<LockedPackage>(path.join(dir, 'npm-shrinkwrap.json'))
  } catch (err: any) { // eslint-disable-line
    if (err['code'] !== 'ENOENT') throw err
  }
  throw new PnpmError('NPM_LOCKFILE_NOT_FOUND', 'No package-lock.json or npm-shrinkwrap.json found')
}

function getPreferredVersions (versionsByPackageNames: Record<string, Set<string>>) {
  const preferredVersions = mapValues(
    (versions) => Object.fromEntries(Array.from(versions).map((version) => [version, 'version'])),
    versionsByPackageNames
  )
  return preferredVersions
}

function getAllVersionsByPackageNames (
  npmPackageLock: NpmPackageLock | LockedPackage,
  versionsByPackageNames: {
    [packageName: string]: Set<string>
  }
) {
  if (npmPackageLock.dependencies == null) return
  for (const [packageName, { version }] of Object.entries(npmPackageLock.dependencies)) {
    if (!versionsByPackageNames[packageName]) {
      versionsByPackageNames[packageName] = new Set()
    }
    versionsByPackageNames[packageName].add(version)
  }
  for (const dep of Object.values(npmPackageLock.dependencies)) {
    getAllVersionsByPackageNames(dep, versionsByPackageNames)
  }
}

function getAllVersionsFromYarnLockFile (
  yarnPackageLock: YarnPackageLock,
  versionsByPackageNames: {
    [packageName: string]: Set<string>
  }
) {
  for (const [packageName, { version }] of Object.entries(yarnPackageLock)) {
    const pkgName = packageName.substring(0, packageName.lastIndexOf('@'))
    if (!versionsByPackageNames[pkgName]) {
      versionsByPackageNames[pkgName] = new Set()
    }
    versionsByPackageNames[pkgName].add(version)
  }
}

function selectProjectByDir (projects: Project[], searchedDir: string) {
  const project = projects.find(({ dir }) => path.relative(dir, searchedDir) === '')
  if (project == null) return undefined
  return { [searchedDir]: { dependencies: [], package: project } }
}

function getYarnLockfileType (
  lockFileContents: string
): YarnLockType {
  return lockFileContents.includes('__metadata')
    ? YarnLockType.yarn2
    : YarnLockType.yarn
}
