/**
 * Resolves an explicit ?format= override, falling back to Accept-header
 * negotiation when absent, set to "auto", or set to a value this worker's
 * encoder pipeline can't produce (only avif/webp are supported — no jpeg/png
 * encoder exists here, unlike the legacy cf.image-backed worker this
 * replaces).
 */
import type { ImageFormat } from "./convert";

export function parseFormatOverride(raw: string | null): ImageFormat | null {
	if (raw === "avif" || raw === "webp") return raw;
	return null; // covers null, "auto", and any unsupported value (jpeg/png/etc.)
}
