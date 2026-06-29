import DefaultTheme from 'vitepress/theme'
import { useData, useRoute } from 'vitepress'
import { h, nextTick, watch } from 'vue'
import GithubStars from './GithubStars.vue'
import DownloadMac from './DownloadMac.vue'
import './style.css'

// Lazily loaded once: mermaid is large, so only pull it in when a page that
// actually has a diagram is on screen.
let mermaidModule: typeof import('mermaid').default | undefined
async function loadMermaid() {
  if (!mermaidModule) {
    mermaidModule = (await import('mermaid')).default
  }
  return mermaidModule
}

// ADC brand palette (mirrors the --adc-* tokens in theme/style.css).
const ADC = {
  coffeeBean: '#1c1105',
  darkCoffee: '#341f09',
  tigerOrange: '#ef8920',
  softApricot: '#f3d7ba',
  antiqueWhite: '#f9ebdc',
  porcelain: '#fefaf5'
}

// Paint mermaid diagrams in the ADC palette rather than its default lavender.
// Returns the subset of mermaid themeVariables that drives flowchart colors.
function brandThemeVariables(isDark: boolean) {
  const nodeFill = isDark ? ADC.darkCoffee : ADC.softApricot
  const nodeText = isDark ? ADC.porcelain : ADC.coffeeBean
  const line = isDark ? ADC.softApricot : ADC.darkCoffee
  return {
    fontFamily: 'inherit',
    primaryColor: nodeFill,
    primaryBorderColor: ADC.tigerOrange,
    primaryTextColor: nodeText,
    // secondary/tertiary cover subgraphs and alternate shapes if ever added.
    secondaryColor: nodeFill,
    secondaryBorderColor: ADC.tigerOrange,
    secondaryTextColor: nodeText,
    tertiaryColor: isDark ? ADC.coffeeBean : ADC.antiqueWhite,
    tertiaryBorderColor: ADC.tigerOrange,
    tertiaryTextColor: nodeText,
    lineColor: line,
    textColor: nodeText
  }
}

let diagramCounter = 0

// Render every placeholder div the markdown fence override emitted. Called on
// first paint, on client-side navigation, and on light/dark toggle so the
// diagram theme tracks the site theme.
async function renderMermaid(isDark: boolean) {
  if (typeof window === 'undefined') return
  const blocks = Array.from(
    document.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid]')
  )
  if (blocks.length === 0) return

  const mermaid = await loadMermaid()
  // Default securityLevel ('strict') sanitizes mermaid's own SVG output.
  // theme 'base' + themeVariables lets us paint diagrams in the ADC palette
  // (see theme/style.css) instead of mermaid's default lavender.
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: brandThemeVariables(isDark),
    flowchart: {
      // Keep long node labels (e.g. the coordinator pipeline) on one line so
      // the box sizes to fit rather than clipping wrapped text.
      htmlLabels: true,
      wrappingWidth: 640
    }
  })

  for (const el of blocks) {
    const encoded = el.getAttribute('data-mermaid')
    if (!encoded) continue
    const source = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    )
    try {
      // svg is mermaid's sanitized render of trusted, repo-authored diagram
      // source — safe to inject. (innerHTML is required to mount SVG markup.)
      const { svg } = await mermaid.render(`mermaid-${diagramCounter++}`, source)
      el.innerHTML = svg
    } catch (err) {
      el.textContent = String(err)
      el.classList.add('mermaid-error')
    }
  }
}

export default {
  extends: DefaultTheme,
  // Add the GitHub star-count button at the right end of the nav bar.
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(GithubStars)
    })
  },
  enhanceApp({ app }) {
    // Usable directly in markdown (e.g. the installation page).
    app.component('DownloadMac', DownloadMac)
  },
  setup() {
    const route = useRoute()
    const { isDark } = useData()
    // Re-render on navigation and theme change. nextTick lets the new page DOM
    // mount before we look for diagram placeholders.
    watch(
      () => [route.path, isDark.value] as const,
      () => nextTick(() => renderMermaid(isDark.value)),
      { immediate: true }
    )
  }
}
