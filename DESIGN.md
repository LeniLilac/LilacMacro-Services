# Design

## Direction

The site and admin console extend LilacMacro's SquareClaim-inspired paper-and-ink language: tactile outlined controls, hard offset shadows, compact system typography, bright lilac accents, and restrained semantic color. They must not become a neon gamer dashboard, glass UI, generic SaaS landing page, or decorative operations console.

## Public site

- Lead with the product name and one-sentence purpose. Landing-page download actions route to a dedicated download page; that page presents the direct GitHub Release download, practical minimum/recommended Windows guidance, and concise install and quick-start walkthroughs. Keep live operational state in the signed control API and app rather than the landing-page composition.
- Use short sections for capabilities, setup, privacy, source-available status, and links. Avoid marketing superlatives, fake metrics, testimonials, and oversized gradients.
- The download page's installer actions point directly to the verified GitHub Release asset. Tutorial placeholders stay visibly labeled until real videos are published.

## Admin console

- Familiar top navigation: Overview, Codes, Schedules, Features, Diagnostics, Audit.
- Dense desktop-first tables and forms with responsive stacking on narrow screens.
- Every action exposes its current value, effective time, actor, and audit result.
- Confirmation dialogs name the exact effect. Destructive and safety-impacting operations cannot share primary-action styling.
- Diagnostics exposes one compact, default-on `Pre-verify new logs` setting. Downloads progress from Stored to Verifying to Accepted; the initiating browser waits in place and starts the direct storage download automatically when verification succeeds.
- Diagnostics accepts a copied installation UUID in one compact filter row. The UUID is submitted in a no-store, CSRF-protected request body; the table continues to expose archive metadata rather than raw or stored installation identity.
- Loading uses shaped skeletons; empty states explain the next legitimate action in one sentence.

## Visual system

- System UI typeface; compact fixed scale.
- Paper canvas, bounded cards only where grouping earns them, black ink outlines, hard 3-pixel offset shadows.
- Lilac is the primary action/selection color. Red is destructive/error only; green is verified success; amber is warning/maintenance.
- Controls implement default, hover, focus-visible, active, disabled, loading, and error states.
- Motion is 150-220 ms and communicates state only.
- Maintain WCAG AA text contrast, keyboard navigation, clear focus, reduced-motion support, and text-backed status.
