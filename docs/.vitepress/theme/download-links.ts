export type WindowsArchitecture = 'x64' | 'arm64' | 'unknown'

export interface BrowserUserAgentData {
  architecture?: string
  bitness?: string
  platform?: string
  getHighEntropyValues?: (
    hints: string[]
  ) => Promise<BrowserUserAgentData>
}

export interface BrowserNavigatorLike {
  platform?: string
  userAgent?: string
  userAgentData?: BrowserUserAgentData
}

export interface ReleaseAsset {
  name?: string
  browser_download_url?: string
}

export interface ReleaseDownloadUrls {
  mac?: string
  windowsX64?: string
  windowsArm64?: string
}

function isWindows(platform: string | undefined, userAgent: string | undefined): boolean {
  return /windows|win32|win64/i.test(`${platform ?? ''} ${userAgent ?? ''}`)
}

export function isWindowsBrowser(
  browserNavigator: BrowserNavigatorLike =
    typeof navigator === 'undefined'
      ? {}
      : (navigator as unknown as BrowserNavigatorLike)
): boolean {
  return isWindows(
    browserNavigator.userAgentData?.platform || browserNavigator.platform,
    browserNavigator.userAgent
  )
}

/**
 * Select the installer architecture from the browser signals we can trust.
 * User-Agent Client Hints are preferred because Windows ARM browsers may report
 * an x64 user agent while running under emulation.
 */
export function detectWindowsArchitecture(
  userAgentData: Pick<BrowserUserAgentData, 'architecture' | 'bitness' | 'platform'> | undefined,
  userAgent = '',
  platform = ''
): WindowsArchitecture {
  const reportedPlatform = userAgentData?.platform || platform
  if (!isWindows(reportedPlatform, userAgent)) return 'unknown'

  const architecture = userAgentData?.architecture?.toLowerCase()
  if (architecture === 'arm' || architecture === 'arm64' || architecture === 'aarch64') {
    return 'arm64'
  }
  if (architecture === 'x86' && userAgentData?.bitness === '64') {
    return 'x64'
  }

  // This covers browsers without User-Agent Client Hints. Only use explicit
  // architecture tokens, since a generic Win32 platform value is ambiguous.
  if (/arm64|aarch64|windows on arm/i.test(userAgent)) return 'arm64'
  if (/wow64|win64|x64/i.test(userAgent)) return 'x64'
  return 'unknown'
}

export async function detectBrowserWindowsArchitecture(
  browserNavigator: BrowserNavigatorLike =
    typeof navigator === 'undefined'
      ? {}
      : (navigator as unknown as BrowserNavigatorLike)
): Promise<WindowsArchitecture> {
  const userAgentData = browserNavigator.userAgentData
  if (userAgentData?.getHighEntropyValues) {
    try {
      const detailed = await userAgentData.getHighEntropyValues(['architecture', 'bitness'])
      const detected = detectWindowsArchitecture(
        { ...userAgentData, ...detailed },
        browserNavigator.userAgent,
        browserNavigator.platform
      )
      if (detected !== 'unknown') return detected
    } catch {
      // Fall back to the lower-entropy browser signals below.
    }
  }

  return detectWindowsArchitecture(
    userAgentData,
    browserNavigator.userAgent,
    browserNavigator.platform
  )
}

export function findReleaseDownloadUrls(assets: ReleaseAsset[]): ReleaseDownloadUrls {
  const find = (pattern: RegExp) =>
    assets.find((asset) => pattern.test(asset.name ?? ''))?.browser_download_url

  return {
    mac: find(/\.dmg$/i),
    windowsX64: find(/x64-setup\.exe$/i),
    windowsArm64: find(/arm64-setup\.exe$/i)
  }
}

export function windowsInstallerUrl(
  urls: ReleaseDownloadUrls,
  architecture: WindowsArchitecture
): string | undefined {
  if (architecture === 'x64') return urls.windowsX64
  if (architecture === 'arm64') return urls.windowsArm64
  return undefined
}
