/**
 * Util to proxy requests to the origin server
 */
import { optimizeImage, type OptimizeParams } from "wasm-image-optimization/workerd";
import { canEncode, canEncodeAvif, getBestFormat, getContentType, type ImageFormat } from "./convert";
import { computeDimensions } from "./resize";
import { getContentTypeForDetectedFormat, getImageDimensions } from "./dimensions";
import { getCachedImage, putCachedImage } from "./cache";
import { parseSteps, snapToStep } from "./steps";
import { downscale, PHOTON_MAX_SOURCE_PIXELS } from "./downscale";
import { parseKeyPairMap, verifySignedUrl } from "./signature";
import { createS3Client, fetchFromS3, parsePathPrefixRoutes, resolveS3Route } from "./s3origin";
import { parseFormatOverride } from "./formatOverride";

function passthrough(response: Response): Response {
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
}

// Like passthrough, but for non-image assets (.glb, .zip, etc.) streamed
// through untouched on a successful origin response. Many origin objects
// have no Cache-Control set at all — without one, downstream caches
// (browser, any CDN in front of this worker) treat the response as
// uncacheable and every request re-triggers a full origin fetch, even for
// large files requested repeatedly. Only fills in a default when the origin
// didn't already specify one, so an origin that deliberately marks something
// private/no-store is respected.
function passthroughCacheable(response: Response): Response {
	const headers = new Headers(response.headers);
	if (!headers.has("cache-control")) {
		headers.set("Cache-Control", "public, max-age=86400");
	}
	return new Response(response.body, { status: response.status, headers });
}

type CacheStatus = "HIT" | "MISS" | "BYPASS" | "N/A";
type Outcome = "success" | "failure" | "skipped";
type LogLevel = "info" | "warn" | "error";

// Human-readable one-liner for the Cloudflare Logs list view, which only
// shows Level + Message — the full JSON is still available by expanding the
// row. Built from the same fields rather than hand-written per call site, so
// it can't drift out of sync with `reason`.
//
// `level` defaults from `outcome` (failure -> error, else info) but can be
// overridden — most `failure`s here are expected, handled conditions (expired
// signatures, oversized images falling back to the original, a bad object at
// the origin) rather than genuine worker faults, so they're logged as `warn`.
// `error` is reserved for outcomes that indicate something actually broke.
function logResult(fields: {
	path: string;
	isImage: boolean | "unknown";
	cache: CacheStatus;
	outcome: Outcome;
	reason: string;
	source?: string;
	quality?: number;
	level?: LogLevel;
}): void {
	const level = fields.level ?? (fields.outcome === "failure" ? "error" : "info");
	const message = `[${fields.outcome}] ${fields.path} — ${fields.reason} (cache=${fields.cache})`;
	const entry = { message, level, ...fields, ts: Date.now() };
	if (level === "error") {
		console.error(JSON.stringify(entry));
	} else if (level === "warn") {
		console.warn(JSON.stringify(entry));
	} else {
		console.log(JSON.stringify(entry));
	}
}

export async function proxyRequest(
	request: Request,
	originBaseUrl: string,
	bucket: R2Bucket,
	ctx: ExecutionContext,
	stepsQualityRaw?: string,
	stepsSizeRaw?: string,
	cloudFrontKeyPairMapRaw?: string,
	s3RoutesEnv?: Record<string, string | undefined>,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		logResult({ path: new URL(request.url).pathname, isImage: "unknown", cache: "N/A", outcome: "skipped", reason: "method-not-allowed" });
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}

	const url = new URL(request.url);

	// Verify CloudFront-style signed URL access control, if configured.
	const keyPairMap = parseKeyPairMap(cloudFrontKeyPairMapRaw);
	if (Object.keys(keyPairMap).length > 0) {
		const result = await verifySignedUrl(url, keyPairMap);
		if (!result.valid) {
			logResult({ path: url.pathname, isImage: "unknown", cache: "N/A", outcome: "failure", reason: `signature-invalid: ${result.error}`, level: "warn" });
			return new Response(`Signature verification failed: ${result.error}`, { status: 403 });
		}
		url.searchParams.delete("Key-Pair-Id");
		url.searchParams.delete("Policy");
		url.searchParams.delete("Signature");
	}

	const originUrl = `${originBaseUrl}${url.pathname}${url.search}`;

	const accept = request.headers.get("accept") || "";

	// ?format= lets legacy callers (migrated from the cf.image-backed worker)
	// force avif/webp output regardless of Accept. "auto" and any value we
	// can't encode (jpeg/png/etc.) fall through to Accept-header negotiation.
	const rawFormatParam = url.searchParams.get("format");
	const formatOverride = parseFormatOverride(rawFormatParam);
	if (rawFormatParam && rawFormatParam !== "auto" && !formatOverride) {
		logResult({ path: url.pathname, isImage: "unknown", cache: "N/A", outcome: "skipped", reason: `unsupported-format-param: ${rawFormatParam}` });
	}
	let format = formatOverride ?? getBestFormat(accept);

	const qualitySteps = parseSteps(stepsQualityRaw);
	const sizeSteps = parseSteps(stepsSizeRaw);

	const widthParam = url.searchParams.get("w") ?? url.searchParams.get("width");
	const heightParam = url.searchParams.get("h") ?? url.searchParams.get("height");
	let width = widthParam ? Number(widthParam) : undefined;
	let height = heightParam ? Number(heightParam) : undefined;
	let quality = url.searchParams.get("quality")
		? Math.min(100, Math.max(1, Number(url.searchParams.get("quality"))))
		: 100;

	quality = snapToStep(quality, qualitySteps);
	if (width !== undefined) width = snapToStep(width, sizeSteps);
	if (height !== undefined) height = snapToStep(height, sizeSteps);

	const cacheParams = { quality, width, height };

	// Check R2 cache before fetching from origin
	if (format) {
		const cached = await getCachedImage(bucket, url.pathname, format, cacheParams);
		if (cached) {
			logResult({ path: url.pathname, isImage: true, cache: "HIT", outcome: "success", reason: "served-from-r2" });
			return new Response(cached.data, {
				status: 200,
				headers: {
					"Content-Type": cached.contentType,
					"Cache-Control": "public, max-age=86400",
					"X-Cache": "HIT",
				},
			});
		}
	}

	// Cache miss — fetch from origin, signing with SigV4 if a matching S3-compatible route is configured
	const originHost = new URL(originUrl).host;
	const routes = parsePathPrefixRoutes(s3RoutesEnv ?? {});
	const matchedRoute = resolveS3Route(url.pathname, routes);
	const sourceLabel = matchedRoute ? matchedRoute.host.split(".")[0] : "origin";

	let originResponse: Response;
	if (matchedRoute) {
		const client = createS3Client(matchedRoute);
		const resolvedUrl = `${new URL(originUrl).protocol}//${matchedRoute.host}${url.pathname}${url.search}`;
		originResponse = await fetchFromS3(client, resolvedUrl, request.method);
	} else {
		originResponse = await fetch(originUrl, {
			method: request.method,
			headers: { Host: originHost },
		});
	}

	if (!originResponse.ok) {
		logResult({ path: url.pathname, isImage: "unknown", cache: "N/A", outcome: "failure", reason: `origin-error: ${originResponse.status}`, source: sourceLabel, level: "warn" });
		return passthrough(originResponse);
	}

	const contentType = originResponse.headers.get("content-type") || "";
	const isExplicitImage = contentType.startsWith("image/") && !contentType.includes("svg");
	const isAmbiguousContentType = !contentType || contentType === "application/octet-stream" || contentType === "binary/octet-stream";

	let imageData: ArrayBuffer;
	let effectiveContentType: string;

	if (isExplicitImage) {
		if (!format) {
			logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "skipped", reason: "no-format-negotiated", source: sourceLabel });
			return passthrough(originResponse);
		}
		imageData = await originResponse.arrayBuffer();
		effectiveContentType = contentType;
	} else if (isAmbiguousContentType) {
		// Content-Type is missing or too generic to trust — sniff the real file
		// header before giving up on it. Only ambiguous values pay this extra
		// read+sniff cost; explicit non-image types (text/html, application/zip,
		// etc.) still short-circuit below without touching the body.
		const buffered = await originResponse.arrayBuffer();
		const sniffed = getImageDimensions(buffered);
		if (!sniffed) {
			logResult({ path: url.pathname, isImage: false, cache: "N/A", outcome: "skipped", reason: `not-an-image: sniffed, no recognizable header (declared ${contentType || "(no content-type)"})`, source: sourceLabel });
			return passthroughCacheable(new Response(buffered, { status: originResponse.status, headers: originResponse.headers }));
		}
		if (!format) {
			logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "skipped", reason: "no-format-negotiated", source: sourceLabel });
			return passthrough(new Response(buffered, { status: originResponse.status, headers: originResponse.headers }));
		}
		logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "success", reason: `sniffed-as-${sniffed.format} (declared ${contentType || "(no content-type)"})`, source: sourceLabel });
		imageData = buffered;
		effectiveContentType = getContentTypeForDetectedFormat(sniffed.format);
	} else {
		logResult({ path: url.pathname, isImage: false, cache: "N/A", outcome: "skipped", reason: `not-an-image: ${contentType}`, source: sourceLabel });
		return passthroughCacheable(originResponse);
	}

	// Any failure in the processing pipeline below falls back to serving the
	// raw bytes we already fetched from the origin, so a broken transform never
	// turns into a broken response for the user.
	try {
		// Probe source dimensions and resolve the target (post-resize) dimensions.
		// The encoder works on the resized raster, so AVIF feasibility is determined
		// by the target size — not the source.
		const dims = getImageDimensions(imageData);
		let targetW: number | undefined;
		let targetH: number | undefined;
		if (dims) {
			if (width || height) {
				const resized = computeDimensions(dims.width, dims.height, width, height);
				targetW = resized.width;
				targetH = resized.height;
			} else {
				targetW = dims.width;
				targetH = dims.height;
			}
			if (formatOverride === "avif" && !canEncodeAvif(targetW, targetH)) {
				// Forced avif but the target is over the encoder's memory ceiling —
				// downgrade silently, same philosophy as the existing AVIF→WebP
				// fallback chain further down.
				logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "success", reason: `format-override-downgraded: avif->webp (oversized ${targetW}x${targetH})`, source: sourceLabel, quality });
				format = "webp";
			} else if (formatOverride) {
				format = formatOverride;
			} else {
				format = getBestFormat(accept, { width: targetW, height: targetH });
			}
		}
		if (!format) {
			logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "skipped", reason: "unparseable-dimensions", source: sourceLabel });
			return passthrough(new Response(imageData, {
				headers: { "Content-Type": effectiveContentType },
			}));
		}

		// If the target is too big for WIO to encode within the worker's memory
		// budget, skip the encoder entirely and serve origin bytes. Only safe
		// outcome for full-res 4K+ requests — both AVIF and WebP blow the heap
		// at that resolution.
		if (targetW !== undefined && targetH !== undefined && !canEncode(targetW, targetH)) {
			logResult({ path: url.pathname, isImage: true, cache: "BYPASS", outcome: "failure", reason: `oversized-for-encoder: ${targetW}x${targetH}`, source: sourceLabel, quality, level: "warn" });
			return new Response(imageData, {
				status: 200,
				headers: {
					"Content-Type": effectiveContentType,
					"Cache-Control": "public, max-age=86400",
					"X-Cache": "BYPASS",
				},
			});
		}

		const options: OptimizeParams = {
			image: imageData,
			format,
			quality,
			speed: 10,
		};

		// Route downscales through photon (Lanczos3) when the source is small
		// enough to fit in photon's WASM heap — a 4K source alone is a ~33MB
		// raw raster, and linear memory doesn't shrink after .free(), so large
		// sources OOM the worker. Above the cap we fall back to WIO's skia
		// resize: aliased, but memory-safe, and visibly less bad at the extreme
		// downscale ratios that hit this path.
		if (
			dims
			&& targetW !== undefined
			&& targetH !== undefined
			&& (targetW < dims.width || targetH < dims.height)
		) {
			if (dims.width * dims.height <= PHOTON_MAX_SOURCE_PIXELS) {
				options.image = downscale(new Uint8Array(imageData), targetW, targetH);
			} else {
				options.width = targetW;
				options.height = targetH;
			}
		}

		// Try requested format, fall back to WebP if AVIF blows memory
		let converted: Uint8Array;
		let outputFormat: ImageFormat = format;
		try {
			converted = (await optimizeImage(options)).data;
		} catch {
			if (format === "avif") {
				outputFormat = "webp";
				options.format = "webp";
				options.speed = 10;
				converted = (await optimizeImage(options)).data;
			} else {
				logResult({ path: url.pathname, isImage: true, cache: "N/A", outcome: "failure", reason: `encode-failed: ${format}`, source: sourceLabel, quality, level: "warn" });
				return passthrough(new Response(imageData, {
					headers: { "Content-Type": effectiveContentType },
				}));
			}
		}

		// Store in R2 cache (non-blocking)
		ctx.waitUntil(putCachedImage(bucket, url.pathname, outputFormat, cacheParams, converted));

		logResult({ path: url.pathname, isImage: true, cache: "MISS", outcome: "success", reason: `transcoded-to-${outputFormat}`, source: sourceLabel, quality });
		return new Response(converted, {
			status: 200,
			headers: {
				"Content-Type": getContentType(outputFormat),
				"Cache-Control": "public, max-age=86400",
				"X-Cache": "MISS",
			},
		});
	} catch (err) {
		logResult({ path: url.pathname, isImage: true, cache: "BYPASS", outcome: "failure", reason: `pipeline-exception: ${err instanceof Error ? err.message : String(err)}`, source: sourceLabel, quality });
		return new Response(imageData, {
			status: 200,
			headers: {
				"Content-Type": effectiveContentType,
				"Cache-Control": "public, max-age=86400",
				"X-Cache": "BYPASS",
			},
		});
	}
}
