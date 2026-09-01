# cloudflare-worker-image-cdn

A Cloudflare Worker that acts as an image CDN proxy. It fetches images from an origin server, automatically converts them to modern formats (AVIF/WebP) based on browser support, resizes them on the fly, and caches the results in R2 for fast subsequent delivery.

Runs entirely on Cloudflare's edge — no servers to manage, no build step per image.

[![Deploy to Cloudflare](https://docs-cloudflare-cdn.ciannavei.dev/images/deploy-to-cloudflare.svg)](https://docs-cloudflare-cdn.ciannavei.dev/releases)

**Docs:** [docs-cloudflare-cdn.ciannavei.dev](https://docs-cloudflare-cdn.ciannavei.dev/)

## Features

| Feature | Description |
| --- | --- |
| **Automatic format conversion** | Serves AVIF or WebP based on the browser's `Accept` header, with automatic WebP fallback when AVIF would exceed the worker memory budget |
| **On-the-fly resizing** | `?w=` and `?h=` preserve aspect ratio and never upscale |
| **Quality control** | `?quality=` with configurable steps (default: `100`) |
| **R2 caching** | Transformed images are stored in Cloudflare R2 and reused on subsequent requests |
| **Step snapping** | Dimensions and quality snap to configured steps, keeping the cache small and hit rates high |
| **Cache observability** | Every response carries an `X-Cache: HIT/MISS/BYPASS` header |
| **Safe by default** | Canonical cache keys, stripped client headers on origin fetch, top-level fallback to original image on any transform failure |

## How it works

```text
Request
  ↓
Check R2 cache
  ├── HIT  → Serve cached image
  └── MISS → Fetch from origin
              ↓
             Resize (if requested)
              ↓
             Convert to AVIF / WebP
              ↓
             Store in R2 (non-blocking)
              ↓
             Serve image
```

## Query parameters

| Parameter | Description | Example |
| --- | --- | --- |
| `w` | Target width in pixels | `?w=800` |
| `h` | Target height in pixels | `?h=600` |
| `quality` | Output quality, `1`–`100` | `?quality=80` |

Resizing preserves aspect ratio and never upscales. When both `w` and `h` are provided, the worker uses whichever dimension results in the larger output (contain behavior). Dimensions are read directly from PNG `IHDR`, JPEG `SOF`, and WebP `VP8`/`VP8L` headers.

```text
/photo.jpg?w=400
/photo.jpg?h=300
/photo.jpg?w=800&h=600&quality=80
```

## Format selection

The worker inspects the `Accept` header and picks the best supported format:

| Format | When |
| --- | --- |
| **AVIF** | Client sends `image/avif` and the image fits within the pixel limit |
| **WebP** | AVIF is unsupported or exceeds the pixel limit |
| **Original** | Neither modern format is accepted |

AVIF encoding is memory-intensive, so images larger than **5 million pixels** (e.g. 2500×2000) automatically fall back to WebP to stay within the Cloudflare Workers 128 MB memory limit. If encoding fails at any stage, the fallback chain is `AVIF → WebP → original`, so a valid image is always returned. SVG images are passed through untouched.

## Step snapping

Requested `w`, `h`, and `quality` values are rounded **up** to the nearest configured step before processing or cache lookup. Without this, `?w=799`, `?w=800`, and `?w=801` would each produce a separate cached image; with default steps, all three snap to `w=1080` and share one cached variant.

| Variable | Applies to | Default |
| --- | --- | --- |
| `STEPS_SIZE` | `w`, `h` | `[320, 480, 720, 1080, 1920, 2560, 3840]` |
| `STEPS_QUALITY` | `quality` | `[10, 20, 30, 40, 50, 60, 70, 80, 90, 100]` |

Values exceeding every step are clamped to the largest step. If a step array is left empty, snapping is disabled for that parameter.

## Caching

Transformed images are stored in R2. The cache key is built from the output format, URL path, and query string after step snapping:

```text
{format}{pathname}{search}

// Example:
avif/photos/hero.jpg?w=800&quality=80
```

Every response includes an `X-Cache` header:

| Status | Meaning |
| --- | --- |
| `HIT` | Served directly from R2, no origin fetch or processing |
| `MISS` | Fetched from origin, transformed, stored in R2, and served |
| `BYPASS` | Processing failed — the original image is served unmodified |

Cache writes are non-blocking: the response is sent to the client immediately and the image is persisted to R2 in the background. Responses carry `Cache-Control: public, max-age=86400`.

## Access control & private origins

Both features below are optional and off by default — without configuration the worker behaves exactly as described above.

### Signed URL verification

Set the `CLOUDFRONT_KEY_PAIR_MAP` secret to require CloudFront-style signed URLs before the worker will serve a request:

```sh
wrangler secret put CLOUDFRONT_KEY_PAIR_MAP
# {"K1676C64NMVM2J": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}
```

Requests must carry `Key-Pair-Id`, `Policy`, and `Signature` query params (CloudFront's URL-safe base64: `+` → `-`, `=` → `_`, `/` → `~`). The policy's `Statement[0].Condition.DateLessThan["AWS:EpochTime"]` is checked against the current time. Requests with a missing, expired, or invalid signature get a `403`. On success, the three signature params are stripped before the request continues through the pipeline (not forwarded to the origin, not part of the cache key).

### Private S3-compatible origins

By default the worker fetches from `PROXY_ORIGINAL_URL` anonymously. To sign origin requests with AWS SigV4 — required for private S3-compatible buckets — configure one or more numbered routes, starting at `0`:

| Variable | Sensitive | Description |
| --- | --- | --- |
| `S3_COMPATIBLE_<N>_PREFIX` | No (`vars`) | Path prefix this route matches, e.g. `/vendor-a/`. An **empty string** matches every path — use it as a catch-all default origin. |
| `S3_COMPATIBLE_<N>_HOST` | No (`vars`) | S3-compatible host to sign and fetch from. |
| `S3_COMPATIBLE_<N>_REGION` | No (`vars`) | Optional, defaults to `us-east-1`. |
| `S3_COMPATIBLE_<N>_ACCESS_KEY_ID` | Yes (`wrangler secret put`) | |
| `S3_COMPATIBLE_<N>_SECRET_ACCESS_KEY` | Yes (`wrangler secret put`) | |

Routes are numbered from `0` with no gaps — the worker scans until it hits the first index missing a required field, so route `2` is ignored if route `1` isn't fully configured. Matching uses the longest applicable prefix; a path that doesn't match any configured prefix falls back to the existing anonymous fetch.

Example — a single private bucket for everything:

```sh
# wrangler.jsonc vars
S3_COMPATIBLE_0_PREFIX = ""
S3_COMPATIBLE_0_HOST = "my-bucket.s3.us-east-1.amazonaws.com"

# secrets
wrangler secret put S3_COMPATIBLE_0_ACCESS_KEY_ID
wrangler secret put S3_COMPATIBLE_0_SECRET_ACCESS_KEY
```

Example — two vendor-specific buckets plus a catch-all default:

```sh
# wrangler.jsonc vars
S3_COMPATIBLE_0_PREFIX = "/vendor-a/"
S3_COMPATIBLE_0_HOST = "vendor-a.s3.us-west-2.amazonaws.com"
S3_COMPATIBLE_0_REGION = "us-west-2"
S3_COMPATIBLE_1_PREFIX = "/vendor-b/"
S3_COMPATIBLE_1_HOST = "vendor-b.s3.eu-west-1.amazonaws.com"
S3_COMPATIBLE_1_REGION = "eu-west-1"
S3_COMPATIBLE_2_PREFIX = ""
S3_COMPATIBLE_2_HOST = "default-bucket.s3.us-east-1.amazonaws.com"

# secrets (one AKSK pair per route)
wrangler secret put S3_COMPATIBLE_0_ACCESS_KEY_ID
wrangler secret put S3_COMPATIBLE_0_SECRET_ACCESS_KEY
wrangler secret put S3_COMPATIBLE_1_ACCESS_KEY_ID
wrangler secret put S3_COMPATIBLE_1_SECRET_ACCESS_KEY
wrangler secret put S3_COMPATIBLE_2_ACCESS_KEY_ID
wrangler secret put S3_COMPATIBLE_2_SECRET_ACCESS_KEY
```

## Deploy

One click — you only need a Cloudflare account with [R2 enabled](https://developers.cloudflare.com/r2/get-started/).

[![Deploy to Cloudflare](https://docs-cloudflare-cdn.ciannavei.dev/images/deploy-to-cloudflare.svg)](https://docs-cloudflare-cdn.ciannavei.dev/releases)

Cloudflare forks this repository, provisions the Worker, and creates the R2 bucket for you. After the initial deploy, open `wrangler.jsonc` in your forked repo and set:

| Variable | What to change |
| --- | --- |
| `PROXY_ORIGINAL_URL` | Your image origin, e.g. `https://images.example.com/` |
| `STEPS_SIZE` | Allowed output widths/heights |
| `STEPS_QUALITY` | Allowed output quality values |

Commit your changes — Cloudflare redeploys the worker automatically on every push.

## License

See [LICENSE](LICENSE).
