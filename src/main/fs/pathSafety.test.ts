import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { resolveSafePath, SENSITIVE_PATH_RE, SYSTEM_SECRET_PATH_RE } from './pathSafety'

const HOME = homedir()
const USERS_ROOT = dirname(HOME)

describe('resolveSafePath — input validation', () => {
  it('rejects non-string or empty paths', () => {
    expect(() => resolveSafePath(undefined, { mutating: false })).toThrow(/required/)
    expect(() => resolveSafePath('', { mutating: false })).toThrow(/required/)
    expect(() => resolveSafePath('   ', { mutating: false })).toThrow(/required/)
    expect(() => resolveSafePath(42, { mutating: false })).toThrow(/required/)
  })

  it('rejects absurdly long paths', () => {
    expect(() => resolveSafePath('a'.repeat(2000), { mutating: false })).toThrow(/too long/)
  })
})

describe('resolveSafePath — tilde expansion', () => {
  it('expands ~ to the home directory', () => {
    expect(resolveSafePath('~', { mutating: false })).toBe(HOME)
    expect(resolveSafePath('~/Documents', { mutating: true })).toBe(join(HOME, 'Documents'))
  })

  it('treats plain relative paths as home-relative user paths', () => {
    expect(resolveSafePath('Downloads/test', { mutating: true })).toBe(join(HOME, 'Downloads', 'test'))
  })
})

describe('resolveSafePath — credential blocklist', () => {
  it('rejects sensitive directories for reads and writes alike', () => {
    expect(() => resolveSafePath('~/.ssh/id_rsa', { mutating: false })).toThrow(/off-limits/)
    expect(() => resolveSafePath('~/.aws/credentials', { mutating: false })).toThrow(/off-limits/)
    expect(() => resolveSafePath(join(HOME, 'AppData', 'x'), { mutating: false })).toThrow(
      /off-limits/
    )
  })

  it('SENSITIVE_PATH_RE matches the documented segments', () => {
    expect(SENSITIVE_PATH_RE.test(`${sep}home${sep}u${sep}.ssh${sep}key`)).toBe(true)
    expect(SENSITIVE_PATH_RE.test(`${sep}home${sep}u${sep}projects${sep}app.ts`)).toBe(false)
  })

  it('blocks macOS credential/token stores under Library, not just Keychains', () => {
    expect(
      SENSITIVE_PATH_RE.test(`${sep}Users${sep}u${sep}Library${sep}Keychains${sep}login.keychain`)
    ).toBe(true)
    expect(
      SENSITIVE_PATH_RE.test(
        `${sep}Users${sep}u${sep}Library${sep}Application Support${sep}Google${sep}Chrome${sep}Default${sep}Login Data`
      )
    ).toBe(true)
    expect(SENSITIVE_PATH_RE.test(`${sep}Users${sep}u${sep}Library${sep}Cookies${sep}Cookies.binarycookies`)).toBe(
      true
    )
    expect(
      SENSITIVE_PATH_RE.test(`${sep}Users${sep}u${sep}Library${sep}Saved Application State${sep}com.apple.Terminal`)
    ).toBe(true)
    expect(SENSITIVE_PATH_RE.test(`${sep}Users${sep}u${sep}Library${sep}Preferences${sep}com.apple.finder.plist`)).toBe(
      false
    )
  })
})

describe('resolveSafePath — home confinement for mutations', () => {
  it('allows mutating paths inside the home tree', () => {
    const p = join(HOME, 'notes', 'todo.txt')
    expect(resolveSafePath(p, { mutating: true })).toBe(p)
    expect(resolveSafePath(HOME, { mutating: true })).toBe(HOME)
  })

  it('blocks mutating paths outside the home tree', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\x.dll' : '/etc/passwd'
    expect(() => resolveSafePath(outside, { mutating: true })).toThrow(/home folder/)
  })

  it('allows reading outside the home tree (read is not home-confined)', () => {
    // A non-sensitive path outside home is fine for a read.
    const outside = process.platform === 'win32' ? 'C:\\ProgramData\\readme.txt' : '/usr/share/doc'
    expect(() => resolveSafePath(outside, { mutating: false })).not.toThrow()
  })

  it('does not let a home-prefix sibling masquerade as inside home', () => {
    // e.g. /home/user-evil should NOT be treated as inside /home/user
    const sibling = `${HOME}-evil${sep}secret.txt`
    expect(() => resolveSafePath(sibling, { mutating: true })).toThrow(/home folder/)
  })
})

describe('resolveSafePath — narrow read hardening (outside home)', () => {
  it('still allows reading a user file on another drive / outside home', () => {
    // The whole point of the narrow block: legitimate out-of-home reads keep working.
    const outside = process.platform === 'win32' ? 'D:\\work\\notes.txt' : '/mnt/data/notes.txt'
    expect(() => resolveSafePath(outside, { mutating: false })).not.toThrow()
    // ProgramData / /usr/share stay readable too.
    const shared = process.platform === 'win32' ? 'C:\\ProgramData\\readme.txt' : '/usr/share/doc'
    expect(() => resolveSafePath(shared, { mutating: false })).not.toThrow()
  })

  it('blocks reading another user\'s home directory', () => {
    const otherUser = join(USERS_ROOT, 'someone-else', 'private.txt')
    expect(() => resolveSafePath(otherUser, { mutating: false })).toThrow(/another user/)
  })

  it('blocks reading system credential stores that live outside home', () => {
    const secret =
      process.platform === 'win32'
        ? 'C:\\Windows\\System32\\config\\SAM'
        : '/etc/shadow'
    expect(() => resolveSafePath(secret, { mutating: false })).toThrow(/system credentials/)
  })

  it('SYSTEM_SECRET_PATH_RE matches the documented out-of-home stores', () => {
    expect(SYSTEM_SECRET_PATH_RE.test('C:\\Windows\\System32\\config\\SAM')).toBe(true)
    expect(SYSTEM_SECRET_PATH_RE.test('/etc/shadow')).toBe(true)
    expect(SYSTEM_SECRET_PATH_RE.test('/etc/ssl/private/server.key')).toBe(true)
    expect(SYSTEM_SECRET_PATH_RE.test('/private/etc/master.passwd')).toBe(true)
    // A user's own project file is not a system secret.
    expect(SYSTEM_SECRET_PATH_RE.test('/home/u/projects/app.ts')).toBe(false)
  })

  it('does not apply the out-of-home read blocks to files inside home', () => {
    // A file under home that merely contains an "etc" segment is fine to read.
    const p = join(HOME, 'projects', 'etc', 'config.txt')
    expect(() => resolveSafePath(p, { mutating: false })).not.toThrow()
  })
})
