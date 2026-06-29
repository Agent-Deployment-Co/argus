<script setup lang="ts">
import { ref, onMounted } from 'vue'

const repo = 'Agent-Deployment-Co/argus'
// No-JS fallback: the latest release page always shows the newest build.
const releasesUrl = `https://github.com/${repo}/releases/latest`

const href = ref(releasesUrl)
const version = ref<string | null>(null)

// The dmg filename is versioned (e.g. Argus_0.1.14_universal.dmg), so there's
// no stable /latest/download/ URL. Resolve the newest release's dmg at runtime
// via the GitHub API (cached for an hour) and point the button straight at it.
// On any failure the button still works — it falls back to the release page.
onMounted(async () => {
  const cacheKey = 'argus:latest-dmg'
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      const { url, tag, ts } = JSON.parse(cached)
      if (url && Date.now() - ts < 3_600_000) {
        href.value = url
        version.value = tag
        return
      }
    }
  } catch {
    // ignore unreadable cache
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!res.ok) return
    const data = await res.json()
    const dmg = (data.assets || []).find((a: any) => /\.dmg$/i.test(a?.name))
    if (dmg?.browser_download_url) {
      href.value = dmg.browser_download_url
      version.value = (data.tag_name || '').replace(/^argus-/, '') || null
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ url: href.value, tag: version.value, ts: Date.now() })
        )
      } catch {
        // ignore unwritable storage
      }
    }
  } catch {
    // offline / rate-limited — keep the release-page fallback
  }
})
</script>

<template>
  <div class="download-mac">
    <a class="download-mac__btn" :href="href">
      <svg viewBox="0 0 384 512" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C73.3 141.2 24 184.2 24 273.5c0 26.4 4.8 53.7 14.4 81.8 12.8 36.9 59 127.4 107.2 125.9 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-83 102.6-120-65.2-30.7-61.7-90-61.7-92.5zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
        />
      </svg>
      Download for macOS
    </a>
    <span class="download-mac__note">
      Universal build — Apple Silicon &amp; Intel<span v-if="version"> · {{ version }}</span>
    </span>
  </div>
</template>

<style scoped>
.download-mac {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 24px 0;
}

.download-mac__btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 22px;
  border-radius: 10px;
  font-family: 'Poppins', var(--vp-font-family-base);
  font-weight: 600;
  font-size: 15px;
  line-height: 1;
  color: var(--vp-button-brand-text);
  background-color: var(--vp-button-brand-bg);
  transition: background-color 0.25s;
}

.download-mac__btn:hover {
  color: var(--vp-button-brand-hover-text);
  background-color: var(--vp-button-brand-hover-bg);
}

.download-mac__btn svg {
  flex-shrink: 0;
  fill: currentColor;
}

.download-mac__note {
  font-size: 13px;
  color: var(--vp-c-text-2);
}
</style>
