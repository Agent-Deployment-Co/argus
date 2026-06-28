import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import GithubStars from './GithubStars.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  // Add the GitHub star-count button at the right end of the nav bar.
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(GithubStars)
    })
  }
}
