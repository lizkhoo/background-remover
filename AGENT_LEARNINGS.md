# Agent Learnings

## Project: Background Remover (static site)

- **Stack**: Static HTML + in-browser Babel/React (no build step, no `package.json`).
- **Entry point**: `index.html` loads `tweaks-panel.jsx`, `icons.jsx`, and `app-v14.jsx` via CDN Babel.
- **Local preview**: `python3 -m http.server 8080 --bind 0.0.0.0` from repo root.
- **Cursor browser**: Cloud agents auto-forward listening ports. Use the plug icon (top-right of agent panel) to open `http://localhost:8080` in Cursor's built-in browser.
- **Deploy**: Configured for Netlify (`netlify.toml`); Vercel MCP requires auth in this environment.
