---
name: Responsive shell layout
description: Mobile Mulapay pages must keep shell children and data views within the viewport instead of relying on hidden document overflow.
---

The responsive shell should prevent overflow at the layout source: flex/grid children need zero minimum widths, transformed sidebar content must stay inside the rail, and mobile tables should compact or wrap rather than create page-level horizontal scrolling.

**Why:** Hiding overflow alone left the underlying layout wider than the viewport, causing clipped content and inconsistent pages.

**How to apply:** When adding a new page or table, check its minimum widths and fixed grid columns at mobile sizes; prefer `minmax(0, ...)`, wrapping, and responsive stacking.