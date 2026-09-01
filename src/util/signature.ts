/**
 * Util to verify CloudFront-style RSA signed URLs
 * Requests carrying Key-Pair-Id / Policy / Signature query params are checked
 * against a configured RSA public key before the proxy pipeline runs.
 */

const CRYPTO_KEY_CACHE = new Map<string, Promise<CryptoKey>>();

function importPublicKey(pem: string): Promise<CryptoKey> {
	const pemBody = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, "")
		.replace(/-----END PUBLIC KEY-----/, "")
		.replace(/\s/g, "");
	const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"spki",
		binaryDer,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
		false,
		["verify"],
	);
}

function getPublicKey(pem: string): Promise<CryptoKey> {
	let cached = CRYPTO_KEY_CACHE.get(pem);
	if (!cached) {
		cached = importPublicKey(pem);
		CRYPTO_KEY_CACHE.set(pem, cached);
	}
	return cached;
}

// CloudFront's custom URL-safe base64: + -> -, = -> _, / -> ~
function base64UrlDecode(str: string): Uint8Array {
	const standard = str.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/");
	return Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
}

export function parseKeyPairMap(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

export interface VerifyResult {
	valid: boolean;
	error?: string;
}

export async function verifySignedUrl(url: URL, keyPairMap: Record<string, string>): Promise<VerifyResult> {
	const keyPairId = url.searchParams.get("Key-Pair-Id");
	const policyB64 = url.searchParams.get("Policy");
	const signatureB64 = url.searchParams.get("Signature");

	if (!keyPairId || !policyB64 || !signatureB64) {
		return { valid: false, error: "Missing signed URL parameters" };
	}

	let policyBytes: Uint8Array;
	let signatureBytes: Uint8Array;
	try {
		policyBytes = base64UrlDecode(policyB64);
		signatureBytes = base64UrlDecode(signatureB64);
	} catch {
		return { valid: false, error: "Invalid base64 encoding" };
	}

	try {
		const policyJson = new TextDecoder().decode(policyBytes);
		const policy = JSON.parse(policyJson);
		const expiry = policy?.Statement?.[0]?.Condition?.DateLessThan?.["AWS:EpochTime"];
		if (typeof expiry === "number" && Date.now() / 1000 > expiry) {
			return { valid: false, error: "Signed URL has expired" };
		}
	} catch {
		return { valid: false, error: "Invalid policy format" };
	}

	const pem = keyPairMap[keyPairId];
	if (!pem) return { valid: false, error: `Unknown Key-Pair-Id: ${keyPairId}` };

	try {
		const key = await getPublicKey(pem);
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			signatureBytes.buffer as ArrayBuffer,
			policyBytes.buffer as ArrayBuffer,
		);
		return ok ? { valid: true } : { valid: false, error: "Signature verification failed" };
	} catch {
		return { valid: false, error: "Signature verification failed" };
	}
}
