import { parseFormatOverride } from "../src/util/formatOverride";

describe("parseFormatOverride", () => {
	it("returns null for null (no ?format= param)", () => {
		expect(parseFormatOverride(null)).toBeNull();
	});

	it("returns null for \"auto\"", () => {
		expect(parseFormatOverride("auto")).toBeNull();
	});

	it("returns \"avif\" for \"avif\"", () => {
		expect(parseFormatOverride("avif")).toBe("avif");
	});

	it("returns \"webp\" for \"webp\"", () => {
		expect(parseFormatOverride("webp")).toBe("webp");
	});

	it("returns null for unsupported formats (jpeg/png — no encoder for these)", () => {
		expect(parseFormatOverride("jpeg")).toBeNull();
		expect(parseFormatOverride("png")).toBeNull();
	});

	it("is case-sensitive — \"AVIF\" is not recognized", () => {
		expect(parseFormatOverride("AVIF")).toBeNull();
		expect(parseFormatOverride("WebP")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseFormatOverride("")).toBeNull();
	});
});
