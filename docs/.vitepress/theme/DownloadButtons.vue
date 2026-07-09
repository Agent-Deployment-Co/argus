<script setup lang="ts">
import { ref, onMounted } from 'vue'

// `center` centers the row; `label` shows a caption inline to the left of the
// buttons. Quick Start uses both; the Download page uses neither. `location`
// identifies where this instance sits (e.g. `home_hero`, `download_page`) and
// rides along on the PostHog `download_clicked` event as its `location`
// property, so we can see which placement drives downloads.
withDefaults(
  defineProps<{ center?: boolean; label?: string; location?: string }>(),
  {
    center: false,
    label: '',
    location: ''
  }
)

const repo = 'Agent-Deployment-Co/argus'
// No-JS fallback: the latest release page always shows the newest build.
const macHref = ref(`https://github.com/${repo}/releases/latest`)

// Resolve the newest release's .dmg at runtime (cached for an hour) and point the
// macOS button straight at it. On any failure the button still works — it falls
// back to the release page.
onMounted(async () => {
  const cacheKey = 'argus:latest-dmg'
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      const { url, ts } = JSON.parse(cached)
      if (url && Date.now() - ts < 3_600_000) {
        macHref.value = url
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
      macHref.value = dmg.browser_download_url
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ url: macHref.value, ts: Date.now() }))
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
  <div class="download-btns" :class="{ 'download-btns--center': center }">
    <span v-if="label" class="download-btns__label">{{ label }}</span>
    <a
      class="btn-primary"
      :href="macHref"
      data-ph-event="download_clicked"
      :data-ph-location="location || undefined"
    >
      <svg viewBox="0 0 384 512" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C73.3 141.2 24 184.2 24 273.5c0 26.4 4.8 53.7 14.4 81.8 12.8 36.9 59 127.4 107.2 125.9 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-83 102.6-120-65.2-30.7-61.7-90-61.7-92.5zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
        />
      </svg>
      macOS
    </a>
    <span class="download-btns__soon" aria-disabled="true">
      <svg viewBox="0 0 448 512" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z"
        />
      </svg>
      Windows (coming soon)
    </span>
  </div>
</template>

<style scoped>
.download-btns {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
}

.download-btns--center {
  justify-content: center;
}

.download-btns__label {
  font-family: 'Poppins', var(--vp-font-family-base);
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--vp-c-text-1);
}

.download-btns__soon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  border-radius: 8px;
  font-family: 'Poppins', var(--vp-font-family-base);
  font-weight: 600;
  font-size: 0.875rem;
  line-height: 1;
  color: var(--vp-c-text-3);
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  cursor: default;
}

.download-btns__soon svg {
  flex-shrink: 0;
  fill: currentColor;
}
</style>
