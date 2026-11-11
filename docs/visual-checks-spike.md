# Visual checks spike: screenshot diffing and LLM vision

This is an evaluation only. No code ships from it. The DOM-based `visual` checks (broken media, upscaled images, text integrity) catch defects with no baseline. This doc covers two ways to catch "looks broken" defects those checks miss.

## Pixelmatch screenshot diffing

**Idea:** compare each page's evidence screenshot (`evidence/<page>/screenshot.{mobile,desktop}.png`) with the same page's screenshot from the previous audit in `audit-results/<domain>/`, using `pixelmatch` (small, no native deps). Report pages whose diff ratio is above a threshold, with the diff image as evidence.

- **Baseline needed.** The first audit of a domain has nothing to compare against. Evidence is captured only for sampled pages (`--evidence-cap`), so only pages sampled in both runs can be compared.
- **Cost:** cheap. Decoding two PNGs and diffing them is milliseconds per page. Storage roughly doubles evidence size if diff images are kept.
- **Flakiness:** high on real sites. Carousels, ads, cookie banners, dates, A/B tests, lazy-loaded content and font timing all change pixels between runs. Full-page heights differ when content changes, so images often cannot be aligned. Masking dynamic regions needs per-site configuration.
- **Meaning:** a diff says "this page changed", not "this page is broken". A redesign looks the same as a regression. Someone has to review every flagged page.

## LLM vision pass

**Idea:** under `--llm`, send each evidence screenshot to a vision model with a short prompt ("does this page look visually broken: missing images, overlapping text, unstyled layout, error pages?") and get back a yes/no plus a reason. It must follow the repo LLM effort policy: low effort, no extended thinking.

- **No baseline needed.** It works on the first audit.
- **Cost:** one image call per sampled page and viewport. Bounded by `--evidence-cap`, but it is the most expensive per-page step in the tool, and it adds latency.
- **False positives:** likely on unusual but intentional designs (brutalist layouts, heavy whitespace, dark themes). Models also miss small defects in downscaled full-page shots. Results are non-deterministic, so they need the Phase 3 "unverified" label rather than counting as facts.
- **Fit:** the transport and the opt-in flag already exist (`--llm`, API or `claude` CLI), so the integration cost is small.

## Recommendation

Ship the DOM-based `visual` checks first; they are deterministic and need no baseline. Do not build pixelmatch diffing now: it reports change rather than breakage and is too noisy on live sites without per-site masks. If more is wanted, prototype the LLM vision pass as an opt-in `--llm` step on evidence screenshots, capped by `--evidence-cap` and labelled unverified, and measure its false-positive rate on a handful of real audits before enabling it by default.
