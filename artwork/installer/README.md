# ParadigmEve installer artwork

These two PNGs are the canonical, user-approved ParadigmEve installer portraits:

- `goddess-header-source.png` — wide goddess portrait for the assisted-installer header
- `goddess-sidebar-source.png` — tall goddess portrait for installer and uninstaller sidebars

They were generated specifically for ParadigmEve during the user's visual design session on
2026-09-12 and then explicitly locked as the final installer imagery. Do not replace, redraw,
or procedurally reinterpret the woman without a new user decision.

NSIS requires 24-bit uncompressed BMP resources. `scripts/make-installer-art.mjs` verifies the
SHA-256 of both approved PNGs, downsamples them with Sharp, and derives these ignored build
artifacts:

- `build/installer-art/goddess-header.bmp` — 150×57 (`MUI_HEADERIMAGE`)
- `build/installer-art/goddess-sidebar.bmp` — 164×314 (installer welcome/finish)
- `build/installer-art/goddess-uninstaller-sidebar.bmp` — 164×314 (uninstaller welcome/finish)

The tall portrait already closely matches NSIS's sidebar aspect ratio, so it uses a centered
cover fit with Lanczos downsampling. The approved wide source intentionally carries a large navy
negative-space field; the converter takes a fixed crop around the right-hand face/halo before
downsampling so the tiny NSIS header shows the mascot clearly instead of as a distant figure.
Installer and uninstaller intentionally use the same approved tall image.

Run `npm run installer-art` to regenerate the build derivatives. Then
`node scripts/make-installer-art.mjs --check` verifies that the generated BMP bytes still match
the locked sources and current converter.

The source portraits contain no third-party product logos or OpenAI/ChatGPT marks. Required
upstream and third-party legal notices remain separate and unchanged.
