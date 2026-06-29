<script setup lang="ts">
import { ref, onMounted } from 'vue'

const repo = 'Agent-Deployment-Co/argus'
const href = `https://github.com/${repo}`
const stars = ref<string | null>(null)

// Hide the star count until the repo has a respectable number; flip back to
// true to show the live count again (the fetch below is skipped while false).
const SHOW_COUNT = false

// 1234 -> "1.2k", 37000 -> "37k", 980 -> "980"
function abbreviate(n: number): string {
  if (n < 1000) return n.toLocaleString('en-US')
  const k = n / 1000
  const s = k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace(/\.0$/, '')
  return `${s}k`
}

// Fetch the live star count client-side (api.github.com allows CORS), cached
// in localStorage for an hour so we don't refetch on every page view. On any
// failure (offline, rate limit) we just show the icon without a count.
onMounted(async () => {
  if (!SHOW_COUNT) return
  const cacheKey = 'argus:gh-stars'
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      const { count, ts } = JSON.parse(cached)
      if (typeof count === 'number' && Date.now() - ts < 3_600_000) {
        stars.value = abbreviate(count)
        return
      }
    }
  } catch {
    // ignore unreadable cache
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`)
    if (!res.ok) return
    const data = await res.json()
    const count = data?.stargazers_count
    if (typeof count === 'number') {
      stars.value = abbreviate(count)
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ count, ts: Date.now() }))
      } catch {
        // ignore unwritable storage
      }
    }
  } catch {
    // offline / rate-limited — leave the count blank
  }
})
</script>

<template>
  <a
    class="gh-stars"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Argus on GitHub"
  >
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
    <span v-if="SHOW_COUNT && stars" class="gh-stars__count">{{ stars }}</span>
  </a>
</template>

<style scoped>
.gh-stars {
  display: inline-flex;
  align-items: center;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  transition: color 0.25s;
}

/* Divider matching the default theme's nav group separators. */
.gh-stars::before {
  margin-left: 16px;
  margin-right: 8px;
  width: 1px;
  height: 24px;
  background-color: var(--vp-c-divider);
  content: '';
}

.gh-stars:hover {
  color: var(--vp-c-text-1);
}

.gh-stars svg {
  flex-shrink: 0;
}

.gh-stars__count {
  margin-left: 6px;
  font-family: 'Poppins', var(--vp-font-family-base);
}

/* The nav collapses to a hamburger on small screens; keep it uncluttered. */
@media (max-width: 767px) {
  .gh-stars {
    display: none;
  }
}
</style>
