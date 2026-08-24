import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: Set `base` to '/<your-repo-name>/' before deploying to GitHub Pages.
// Example: if your repo is github.com/yourname/trade-journal, use '/trade-journal/'
// If you deploy to a custom domain or user/org page (yourname.github.io), use '/'
export default defineConfig({
  plugins: [react()],
  base: '/trade-journal/',
})
