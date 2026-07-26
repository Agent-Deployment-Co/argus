import { describe, expect, test } from 'bun:test'
import {
  detectBrowserWindowsArchitecture,
  detectWindowsArchitecture,
  findReleaseDownloadUrls,
  isWindowsBrowser,
  windowsInstallerUrl
} from '../docs/.vitepress/theme/download-links'

describe('Windows download selection', () => {
  test('uses User-Agent Client Hints for Windows ARM', async () => {
    const architecture = await detectBrowserWindowsArchitecture({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      userAgentData: {
        platform: 'Windows',
        getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' })
      }
    })

    expect(architecture).toBe('arm64')
  })

  test('falls back to explicit user-agent architecture when client hints fail', async () => {
    const architecture = await detectBrowserWindowsArchitecture({
      userAgent: 'Mozilla/5.0 (Windows 11; ARM64)',
      userAgentData: {
        platform: 'Windows',
        getHighEntropyValues: async () => {
          throw new Error('permission denied')
        }
      }
    })

    expect(architecture).toBe('arm64')
  })

  test('uses x86 and 64-bit client hints for Windows x64', () => {
    expect(
      detectWindowsArchitecture({ platform: 'Windows', architecture: 'x86', bitness: '64' })
    ).toBe('x64')
  })

  test('recognizes explicit ARM user-agent tokens', () => {
    expect(
      detectWindowsArchitecture(undefined, 'Mozilla/5.0 (Windows 11; ARM64)')
    ).toBe('arm64')
  })

  test('leaves ambiguous browsers unassigned', () => {
    expect(detectWindowsArchitecture({ platform: 'Win32' }, 'Mozilla/5.0')).toBe('unknown')
    expect(detectWindowsArchitecture(undefined, 'Mozilla/5.0 (Windows NT 10.0)')).toBe('unknown')
    expect(detectWindowsArchitecture({ platform: 'macOS', architecture: 'arm' })).toBe('unknown')
  })

  test('does not show the Windows fallback for other platforms', () => {
    expect(isWindowsBrowser({ platform: 'macOS', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe(false)
    expect(isWindowsBrowser({ platform: 'Windows', userAgent: 'Mozilla/5.0' })).toBe(true)
  })

  test('selects matching release executables and excludes signatures', () => {
    const urls = findReleaseDownloadUrls([
      { name: 'Argus_1.2.3_x64-setup.exe', browser_download_url: 'https://example.test/x64.exe' },
      { name: 'Argus_1.2.3_x64-setup.exe.sig', browser_download_url: 'https://example.test/x64.sig' },
      { name: 'Argus_1.2.3_arm64-setup.exe', browser_download_url: 'https://example.test/arm64.exe' },
      { name: 'Argus_1.2.3_universal.dmg', browser_download_url: 'https://example.test/argus.dmg' }
    ])

    expect(urls).toEqual({
      mac: 'https://example.test/argus.dmg',
      windowsX64: 'https://example.test/x64.exe',
      windowsArm64: 'https://example.test/arm64.exe'
    })
    expect(windowsInstallerUrl(urls, 'x64')).toBe('https://example.test/x64.exe')
    expect(windowsInstallerUrl(urls, 'arm64')).toBe('https://example.test/arm64.exe')
    expect(windowsInstallerUrl(urls, 'unknown')).toBeUndefined()
  })
})
