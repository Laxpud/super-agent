import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StudioBuildInfo } from './protocol.ts'

declare const __AGENT_STUDIO_BUILD_ID__: string | undefined
const hasEmbeddedBuild = typeof __AGENT_STUDIO_BUILD_ID__ === 'string'
export const STUDIO_BUILD_ID = hasEmbeddedBuild ? __AGENT_STUDIO_BUILD_ID__! : 'development'
export const RELEASE_ASSETS = ['lib', 'studio-web', 'cordis.patch.yml', 'package.json', 'locale', 'prompts', 'skills'] as const
export const BUILD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u

function files(root: string, path: string): string[] {
  const stat = lstatSync(join(root, path))
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) throw new Error('Release assets must be regular files or directories')
  return readdirSync(join(root, path)).flatMap(entry => files(root, `${path}/${entry}`))
}

/** 路径和单文件摘要以 JSON 行编码，避免分隔符歧义；不读取树外符号链接、时间戳或发布清单。 */
export function computeReleaseManifest(rootDir: string): { artifactFingerprint: string; files: Record<string, string> } {
  const paths = RELEASE_ASSETS.flatMap(path => files(rootDir, path)).sort()
  const manifest = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(rootDir, path))).digest('hex')]))
  const hash = createHash('sha256')
  for (const path of paths) hash.update(`${JSON.stringify([path, manifest[path]])}\n`)
  return { artifactFingerprint: hash.digest('hex'), files: manifest }
}

function readLoaded(root: string): Readonly<StudioBuildInfo> {
  let packageRoot = resolve(root), version = 'unknown', artifactFingerprint = ''
  try {
    packageRoot = realpathSync(packageRoot)
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name === 'agent-studio' && typeof manifest.version === 'string') version = manifest.version
    // 源码测试可能已有上一轮构建产物；未注入版本时不能拿磁盘中的产物冒充正在运行的代码。
    if (hasEmbeddedBuild) artifactFingerprint = computeReleaseManifest(packageRoot).artifactFingerprint
  } catch { /* 无法校验发布产物时缺省指纹为空，托管更新失败关闭。 */ }
  return Object.freeze({ version, buildId: STUDIO_BUILD_ID, artifactFingerprint, packageRoot })
}

// ESM 模块定位到实际加载的 lib 或 src/studio，首次求值即记下物理根和字节指纹。
const loaded = readLoaded(fileURLToPath(new URL(hasEmbeddedBuild ? '../' : '../../', import.meta.url)))
const overrides = new Map<string, Readonly<StudioBuildInfo>>()

export function resolveLoadedBuildInfo(packageRoot?: string): Readonly<StudioBuildInfo> {
  if (packageRoot === undefined) return loaded
  const key = resolve(packageRoot)
  let info = overrides.get(key)
  if (!info) { info = readLoaded(key); overrides.set(key, info) }
  return info
}

/** 客户端入口的固定标记由同一 tsdown 构建写入，不依赖 UI 树摇或任意字符串匹配。 */
export function verifyStudioClientBuild(root: string, buildId: string): void {
  if (!BUILD_ID_PATTERN.test(buildId) || !readFileSync(join(root, 'studio-web/lib/client.js'), 'utf8')
    .startsWith(`/* agent-studio-build:${buildId} */\n`)) throw new Error('Studio Web Client build does not match the release')
}
