# Design System Specification: Operations Console

## 1. Overview & Creative North Star: "The Silent Sentinel"
The Creative North Star for this design system is **"The Silent Sentinel."** It is a high-density, low-fatigue environment designed for long-duration cognitive focus. Inspired by high-end precision instruments and editorial brutalism, it rejects the "bubbly" consumer web in favor of a lean, mission-critical aesthetic.

The system breaks the "template" look through **intentional density** and **tonal layering**. By removing icons and shadows, we force the designer to rely on extreme typographic hierarchy and subtle shifts in the dark color spectrum to communicate importance. The result is an interface that feels less like a website and more like a custom-engineered dashboard.

---

## 2. Color & Surface Architecture
The palette is rooted in a deep, warm charcoal (`#0d0e14`). This "ink" base prevents the harshness of pure black while providing enough contrast for vibrant status indicators.

### The "No-Line" Rule
Traditional 1px borders are strictly prohibited for layout sectioning. In this system, boundaries are defined exclusively by shifting between surface tokens. 
*   **Background (`#0d0e14`):** The canvas.
*   **Surface Container Low (`#11131b`):** For secondary navigation or sidebars.
*   **Surface Container High (`#1c1f2d`):** For primary work modules or active focus areas.

### Surface Hierarchy & Nesting
To create depth, we "stack" tiers. A `surface_container_highest` (`#222536`) module should sit within a `surface_container` (`#171924`) region. This creates a "milled" effect, as if the UI has been carved out of a single block of material.

### Status Palette (Semantic Signals)
Status must be loud and clear, contrasting against the muted background:
*   **Complete:** `green` (Success)
*   **Failed:** `error` (`#ec7c8a`)
*   **Timeout / Blocked:** `secondary` (`#d58f24`) / `orange`
*   **Paused:** `primary` (`#c2c1ff`)
*   **Pending:** `on_surface_variant` (`#a7aabf`)

---

## 3. Typography: The Editorial Engine
Typography is the primary decorative and functional element. We use a dual-font strategy to separate intent.

### Headers & Titles (Sans-Serif System Stack)
Used for structural headings. 
*   **Style:** Bold weight, tight letter-spacing (-0.02em to -0.04em).
*   **Intent:** Authoritative, compact, and modern.
*   **Token Example:** `headline-sm` (1.5rem, Inter, Bold).

### Data & Metrics (Space Grotesk / Monospace)
Every piece of variable data—task IDs, timestamps, logs, and financial figures—must be rendered in Monospace.
*   **Style:** Regular weight, consistent character width.
*   **Intent:** Precision, readability in dense lists, and a "terminal" feel.

### Labels (Small Caps)
To distinguish metadata from content, all labels use:
*   **Transform:** Small Caps (Uppercase 0.75rem).
*   **Spacing:** Wide tracking (0.1em to 0.15em).
*   **Color:** `on_surface_variant` (`#a7aabf`).

---

## 4. Elevation & Depth: Tonal Layering
Because shadows are forbidden, hierarchy is achieved through **The Layering Principle**.

*   **Lowest Tier:** `surface_container_lowest` (`#000000`) is used for the deepest "wells" (e.g., the log console).
*   **Highest Tier:** `surface_bright` (`#272b3f`) is used for temporary overlays or hover states.
*   **The Ghost Border Fallback:** If a layout becomes visually muddy, a "Ghost Border" may be used: `outline_variant` (`#444759`) at **15% opacity**. This provides a whisper of a boundary without breaking the "No-Line" rule.

---

## 5. Components

### Buttons
*   **Primary:** `primary_container` (`#3734ad`) background with `on_primary_container` (`#cdccff`) text. No rounded corners beyond `sm` (0.125rem).
*   **Secondary:** `surface_container_highest` background. Text in `primary`.
*   **Tertiary:** Ghost style. No background, `on_surface` text.

### Data Cells (The Core Unit)
The primary component for this system. A vertical stack:
1.  **Label:** `label-sm` (Small caps, wide spacing, `on_surface_variant`).
2.  **Value:** `body-md` (Monospace, `on_surface`).

### Input Fields
*   **Style:** Rectangular, `surface_container_high` background.
*   **Active State:** No glow or shadow. The background shifts to `surface_bright`. A 1px "Ghost Border" in `primary` is permitted only on focus.

### Logs & Lists
*   **Spacing:** Use `spacing.2` (0.4rem) between log lines for high density.
*   **Dividers:** Forbidden. Use a `1px` gap between containers to let the `background` color show through, creating a natural separator.

### Command Palette (Special Component)
A floating container using `surface_container_highest`. Apply a `backdrop-blur` of 20px to the background to create a "glass" feel that maintains the dark aesthetic while indicating the element is in a separate layer.

---

## 6. Do’s and Don’ts

### Do:
*   **Do** embrace density. Information is the hero.
*   **Do** use `monospace` for any value that might change (IDs, numbers, dates).
*   **Do** use `surface_container` shifts to group related items.
*   **Do** use tight leading on large headlines to give them a "blocky," structural feel.

### Don’t:
*   **Don’t** use icons. If an action is needed, use a label (e.g., "RETENTION" instead of a trash can).
*   **Don’t** use gradients or shadows. The UI should feel mathematically flat but tonally deep.
*   **Don’t** use standard "Blue" for links. Use `primary` (Muted Violet) or `secondary` (Amber).
*   **Don’t** use rounded corners larger than `md` (0.375rem). The system should feel sharp and architectural.