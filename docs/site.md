# Landing page maintenance

The Pages workflow publishes `site/` after a change to that directory reaches `main`. The mod runtime is independent of the site.

## Domain migration

The site is prepared for `cachetax.aidojo.si`. At cutover:

1. Point its DNS CNAME to `karanb192.github.io`.
2. Set this repository's **Settings → Pages → Custom domain** to `cachetax.aidojo.si`. The Actions deployment does not configure that setting from `site/CNAME`.
3. Wait for the Pages certificate, enable HTTPS enforcement and verify the page and `/assets/social-1280x640.png` over HTTPS.
4. Update the repository's About website URL.

The previous address, `cache-tax.karanbansal.in`, is not redirected by this PR. GitHub Pages accepts one custom domain per repository. To preserve old links, arrange a redirect for the previous hostname with the DNS/hosting provider or a separate redirect site.

## Local preview and social image

Serve `site/` with a static HTTP server. Check the page on desktop and mobile, the install copy button, keyboard navigation and the expandable recording.

`site/social-card.html` is the source for `site/assets/social-1280x640.png`. It uses the same stylesheet and fonts as the landing page and is marked `noindex`. Capture it at 1280 × 640 after both fonts have loaded. This is designed preview artwork; the session recordings remain separate, unmodified assets.

The fonts are self-hosted under `site/fonts/`, with their SIL Open Font License files. Source Serif 4 provides headings and Hanken Grotesk provides body text. The warm palette and serif/sans pairing follow the [Claude Code product page](https://claude.com/product/claude-code); they do not use Anthropic's proprietary font files.
