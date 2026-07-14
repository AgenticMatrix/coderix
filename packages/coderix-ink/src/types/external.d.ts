declare module 'stack-utils' {
  class StackUtils {
    constructor(options?: { cwd?: string; internals?: RegExp[] })
    static nodeInternals(): RegExp[]
    parseLine(line: string): { file: string; line: number; column: number; function?: string } | undefined
  }
  export = StackUtils
}

declare module 'bidi-js' {
  const bidi: any
  export default bidi
}

declare module 'supports-hyperlinks' {
  const supportsHyperlinks: any
  export default supportsHyperlinks
}

declare module 'semver' {
  export function coerce(version: string | undefined | null): import('semver').SemVer | null
  export function gte(v1: string | import('semver').SemVer, v2: string | import('semver').SemVer): boolean
}
