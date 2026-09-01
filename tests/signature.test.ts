import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { parseKeyPairMap, verifySignedUrl } from "../src/util/signature";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const KEY_PAIR_ID = "TESTKEYPAIRID";

function base64UrlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/=/g, "_")
		.replace(/\//g, "~");
}

function buildPolicy(expiryEpochSeconds: number): Uint8Array {
	const policy = {
		Statement: [
			{
				Resource: "https://example.com/*",
				Condition: { DateLessThan: { "AWS:EpochTime": expiryEpochSeconds } },
			},
		],
	};
	return new TextEncoder().encode(JSON.stringify(policy));
}

function signPolicy(policyBytes: Uint8Array): Uint8Array {
	const signature = nodeSign("RSA-SHA1", policyBytes, privateKey);
	return new Uint8Array(signature);
}

function buildSignedUrl(options: {
	keyPairId?: string;
	policyBytes?: Uint8Array;
	signatureBytes?: Uint8Array;
	omit?: Array<"Key-Pair-Id" | "Policy" | "Signature">;
}): URL {
	const url = new URL("https://example.com/photo.jpg");
	const omit = options.omit ?? [];
	if (!omit.includes("Key-Pair-Id")) {
		url.searchParams.set("Key-Pair-Id", options.keyPairId ?? KEY_PAIR_ID);
	}
	if (!omit.includes("Policy") && options.policyBytes) {
		url.searchParams.set("Policy", base64UrlEncode(options.policyBytes));
	}
	if (!omit.includes("Signature") && options.signatureBytes) {
		url.searchParams.set("Signature", base64UrlEncode(options.signatureBytes));
	}
	return url;
}

describe("parseKeyPairMap", () => {
	it("returns {} for undefined", () => {
		expect(parseKeyPairMap(undefined)).toEqual({});
	});

	it("returns {} for empty string", () => {
		expect(parseKeyPairMap("")).toEqual({});
	});

	it("returns {} for invalid JSON", () => {
		expect(parseKeyPairMap("not-json")).toEqual({});
	});

	it("returns {} for non-object JSON", () => {
		expect(parseKeyPairMap("[1,2,3]")).toEqual({});
	});

	it("parses a valid key-pair-id -> pem map", () => {
		expect(parseKeyPairMap(JSON.stringify({ ABC: "pem-data" }))).toEqual({ ABC: "pem-data" });
	});

	it("filters out non-string values", () => {
		expect(parseKeyPairMap(JSON.stringify({ ABC: "pem-data", DEF: 123 }))).toEqual({ ABC: "pem-data" });
	});
});

describe("verifySignedUrl", () => {
	const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
	const pastExpiry = Math.floor(Date.now() / 1000) - 3600;

	it("rejects when signature params are missing", async () => {
		const url = buildSignedUrl({ omit: ["Policy", "Signature"] });
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Missing/);
	});

	it("accepts a valid, unexpired signature", async () => {
		const policyBytes = buildPolicy(futureExpiry);
		const signatureBytes = signPolicy(policyBytes);
		const url = buildSignedUrl({ policyBytes, signatureBytes });
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result).toEqual({ valid: true });
	});

	it("rejects an expired policy", async () => {
		const policyBytes = buildPolicy(pastExpiry);
		const signatureBytes = signPolicy(policyBytes);
		const url = buildSignedUrl({ policyBytes, signatureBytes });
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/expired/);
	});

	it("rejects an unknown Key-Pair-Id", async () => {
		const policyBytes = buildPolicy(futureExpiry);
		const signatureBytes = signPolicy(policyBytes);
		const url = buildSignedUrl({ keyPairId: "UNKNOWN", policyBytes, signatureBytes });
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Unknown Key-Pair-Id/);
	});

	it("rejects a tampered signature", async () => {
		const policyBytes = buildPolicy(futureExpiry);
		const signatureBytes = signPolicy(policyBytes);
		signatureBytes[0] ^= 0xff; // flip a byte to corrupt the signature
		const url = buildSignedUrl({ policyBytes, signatureBytes });
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Signature verification failed/);
	});

	it("rejects invalid base64 in Policy", async () => {
		const url = new URL("https://example.com/photo.jpg");
		url.searchParams.set("Key-Pair-Id", KEY_PAIR_ID);
		url.searchParams.set("Policy", "not-valid-base64!!!");
		url.searchParams.set("Signature", "also-not-valid!!!");
		const result = await verifySignedUrl(url, { [KEY_PAIR_ID]: publicKey });
		expect(result.valid).toBe(false);
	});
});
