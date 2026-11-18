---
target: Segoe UI Emoji (C:/Windows/Fonts/seguiemj.ttf)
last-observed: font 1.70 on Windows 11 10.0.26100.9974
status: verified
---

# Segoe UI Emoji colour layers

The font carries both COLR versions for every colour glyph: a `COLR` table at version 1 with
3487 v0 base glyph records (55497 layer records) and 3487 v1 paint records over the same glyph set.
1400 of those glyphs are reached from `cmap`; the rest come in through GSUB (sequences,
modifiers). `CPAL` has one palette.

Spot checks: U+1F600 has 6 v0 layers, U+1F44D 2, U+2764 4, U+1F3F3 2, U+1F525 2, U+1F308 6.
Each also has a v1 paint.

So a renderer that draws COLRv0 (stacked, palette-tinted glyph layers) can show every Segoe UI
Emoji colour glyph on this build. The v0 layers are the font's flat fallback, so gradients drawn by
the v1 paints come out as solid fills.

Method: fontTools reading `COLR.BaseGlyphRecordArray` and `BaseGlyphList` directly. fontTools'
`ColorLayers` convenience map is empty for a version-1 table even when v0 records exist, so it
under-reports.
