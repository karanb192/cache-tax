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

The icon keeps the cache cube, with a prompt chevron on one face. `site/favicon.svg` is the adaptive source used in browser tabs and the site header. The README selects between fixed-color `site/assets/cache-tax-light.svg` and `site/assets/cache-tax-dark.svg` through a `<picture>` element. Keep their paths in sync when changing the shape. The social card uses the light variant. `site/favicon-32.png` is a 32 × 32 fallback rendered on the light background `#faf9f5` so it stays visible on either browser theme.

`site/social-card.html` is the source for `site/assets/social-1280x640.png`. It uses the same stylesheet and fonts as the landing page and is marked `noindex`. Capture it at 1280 × 640 after the fonts have loaded. It pins the light palette so regeneration does not depend on the computer's appearance setting. This is designed preview artwork; the session recordings remain separate, unmodified assets.

The typography and colors follow [Anthropic's brand-guidelines skill](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md): Poppins headings with Arial fallback, Lora body text with Georgia fallback, dark `#141413`, light `#faf9f5`, gray `#b0aea5`, light gray `#e8e6dc` and orange `#d97757`. Fonts are self-hosted under `site/fonts/`, with their SIL Open Font License files.

The landing page follows the system's light/dark preference, including changes while it is open. The title accent uses brand orange in dark mode and a deeper `#c15f3c` in light mode to meet the 3:1 contrast threshold for large text. Buttons use the original orange with dark labels. Mid-gray is used for secondary text only on dark backgrounds. The existing session recordings retain their original colors.
