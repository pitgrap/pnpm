import { LOCKFILE_VERSION } from '@pnpm/constants'
import {
  Lockfile,
  PackageSnapshots,
  ProjectSnapshot,
  ResolvedDependencies,
} from '@pnpm/lockfile-types'
import { PackageManifest } from '@pnpm/types'
import { refToRelative } from '@pnpm/dependency-path'
import difference from 'ramda/src/difference'
import isEmpty from 'ramda/src/isEmpty'
import unnest from 'ramda/src/unnest'

export * from '@pnpm/lockfile-types'

export function pruneSharedLockfile (
  lockfile: Lockfile,
  opts?: {
    warn?: (msg: string) => void
  }
) {
  const copiedPackages = (lockfile.packages == null)
    ? {}
    : copyPackageSnapshots(lockfile.packages, {
      devDepPaths: unnest(Object.values(lockfile.importers).map((deps) => resolvedDepsToDepPaths(deps.devDependencies ?? {}))),
      optionalDepPaths: unnest(Object.values(lockfile.importers).map((deps) => resolvedDepsToDepPaths(deps.optionalDependencies ?? {}))),
      prodDepPaths: unnest(Object.values(lockfile.importers).map((deps) => resolvedDepsToDepPaths(deps.dependencies ?? {}))),
      warn: opts?.warn ?? ((msg: string) => undefined),
    })

  const prunedLockfile: Lockfile = {
    ...lockfile,
    packages: copiedPackages,
  }
  if (isEmpty(prunedLockfile.packages)) {
    delete prunedLockfile.packages
  }
  return prunedLockfile
}

export function pruneLockfile (
  lockfile: Lockfile,
  pkg: PackageManifest,
  importerId: string,
  opts?: {
    warn?: (msg: string) => void
  }
): Lockfile {
  const packages: PackageSnapshots = {}
  const importer = lockfile.importers[importerId]
  const lockfileSpecs: ResolvedDependencies = importer.specifiers ?? {}
  const optionalDependencies = Object.keys(pkg.optionalDependencies ?? {})
  const dependencies = difference(Object.keys(pkg.dependencies ?? {}), optionalDependencies)
  const devDependencies = difference(difference(Object.keys(pkg.devDependencies ?? {}), optionalDependencies), dependencies)
  const allDeps = [
    ...optionalDependencies,
    ...devDependencies,
    ...dependencies,
  ]
  const specifiers: ResolvedDependencies = {}
  const lockfileDependencies: ResolvedDependencies = {}
  const lockfileOptionalDependencies: ResolvedDependencies = {}
  const lockfileDevDependencies: ResolvedDependencies = {}

  Object.entries(lockfileSpecs).forEach(([depName, spec]) => {
    if (!allDeps.includes(depName)) return
    specifiers[depName] = spec
    if (importer.dependencies?.[depName]) {
      lockfileDependencies[depName] = importer.dependencies[depName]
    } else if (importer.optionalDependencies?.[depName]) {
      lockfileOptionalDependencies[depName] = importer.optionalDependencies[depName]
    } else if (importer.devDependencies?.[depName]) {
      lockfileDevDependencies[depName] = importer.devDependencies[depName]
    }
  })
  if (importer.dependencies != null) {
    for (const [alias, dep] of Object.entries(importer.dependencies)) {
      if (
        !lockfileDependencies[alias] && dep.startsWith('link:') &&
        // If the linked dependency was removed from package.json
        // then it is removed from pnpm-lock.yaml as well
        !(lockfileSpecs[alias] && !allDeps[alias])
      ) {
        lockfileDependencies[alias] = dep
      }
    }
  }

  const updatedImporter: ProjectSnapshot = {
    specifiers,
  }
  const prunnedLockfile: Lockfile = {
    importers: {
      ...lockfile.importers,
      [importerId]: updatedImporter,
    },
    lockfileVersion: lockfile.lockfileVersion || LOCKFILE_VERSION,
    packages: lockfile.packages,
  }
  if (!isEmpty(packages)) {
    prunnedLockfile.packages = packages
  }
  if (!isEmpty(lockfileDependencies)) {
    updatedImporter.dependencies = lockfileDependencies
  }
  if (!isEmpty(lockfileOptionalDependencies)) {
    updatedImporter.optionalDependencies = lockfileOptionalDependencies
  }
  if (!isEmpty(lockfileDevDependencies)) {
    updatedImporter.devDependencies = lockfileDevDependencies
  }
  return pruneSharedLockfile(prunnedLockfile, opts)
}

function copyPackageSnapshots (
  originalPackages: PackageSnapshots,
  opts: {
    devDepPaths: string[]
    optionalDepPaths: string[]
    prodDepPaths: string[]
    warn: (msg: string) => void
  }
): PackageSnapshots {
  const copiedSnapshots: PackageSnapshots = {}
  const ctx = {
    copiedSnapshots,
    nonOptional: new Set<string>(),
    notProdOnly: new Set<string>(),
    originalPackages,
    walked: new Set<string>(),
    warn: opts.warn,
  }

  copyDependencySubGraph(ctx, opts.devDepPaths, {
    dev: true,
    optional: false,
  })
  copyDependencySubGraph(ctx, opts.optionalDepPaths, {
    dev: false,
    optional: true,
  })
  copyDependencySubGraph(ctx, opts.prodDepPaths, {
    dev: false,
    optional: false,
  })

  return copiedSnapshots
}

function resolvedDepsToDepPaths (deps: ResolvedDependencies) {
  return Object.entries(deps)
    .map(([alias, ref]) => refToRelative(ref, alias))
    .filter((depPath) => depPath !== null) as string[]
}

function copyDependencySubGraph (
  ctx: {
    copiedSnapshots: PackageSnapshots
    nonOptional: Set<string>
    notProdOnly: Set<string>
    originalPackages: PackageSnapshots
    walked: Set<string>
    warn: (msg: string) => void
  },
  depPaths: string[],
  opts: {
    dev: boolean
    optional: boolean
  }
) {
  for (const depPath of depPaths) {
    const key = `${depPath}:${opts.optional.toString()}:${opts.dev.toString()}`
    if (ctx.walked.has(key)) continue
    ctx.walked.add(key)
    if (!ctx.originalPackages[depPath]) {
      // local dependencies don't need to be resolved in pnpm-lock.yaml
      // except local tarball dependencies
      if (depPath.startsWith('link:') || depPath.startsWith('file:') && !depPath.endsWith('.tar.gz')) continue

      ctx.warn(`Cannot find resolution of ${depPath} in lockfile`)
      continue
    }
    const depLockfile = ctx.originalPackages[depPath]
    ctx.copiedSnapshots[depPath] = depLockfile
    if (opts.optional && !ctx.nonOptional.has(depPath)) {
      depLockfile.optional = true
    } else {
      ctx.nonOptional.add(depPath)
      delete depLockfile.optional
    }
    if (opts.dev) {
      ctx.notProdOnly.add(depPath)
      depLockfile.dev = true
    } else if (depLockfile.dev === true) { // keeping if dev is explicitly false
      delete depLockfile.dev
    } else if (depLockfile.dev === undefined && !ctx.notProdOnly.has(depPath)) {
      depLockfile.dev = false
    }
    const newDependencies = resolvedDepsToDepPaths(depLockfile.dependencies ?? {})
    copyDependencySubGraph(ctx, newDependencies, opts)
    const newOptionalDependencies = resolvedDepsToDepPaths(depLockfile.optionalDependencies ?? {})
    copyDependencySubGraph(ctx, newOptionalDependencies, { dev: opts.dev, optional: true })
  }
}
