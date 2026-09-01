import { createS3Client, parsePathPrefixRoutes, resolveS3Route, type S3Route } from "../src/util/s3origin";

describe("createS3Client", () => {
	it("signs a request with the expected SigV4 headers", async () => {
		const client = createS3Client({
			prefix: "",
			host: "bucket.s3.us-west-2.amazonaws.com",
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "secretexample",
			region: "us-west-2",
		});
		const signed = await client.sign("https://bucket.s3.us-west-2.amazonaws.com/photo.jpg", { method: "GET" });
		expect(signed.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/);
		expect(signed.headers.get("X-Amz-Date")).toBeTruthy();
	});

	it("defaults region to us-east-1 when not provided", async () => {
		const client = createS3Client({
			prefix: "",
			host: "bucket.s3.amazonaws.com",
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "secretexample",
		});
		const signed = await client.sign("https://bucket.s3.amazonaws.com/photo.jpg", { method: "GET" });
		expect(signed.headers.get("Authorization")).toContain("/us-east-1/s3/aws4_request");
	});
});

describe("parsePathPrefixRoutes", () => {
	it("returns [] for empty env", () => {
		expect(parsePathPrefixRoutes({})).toEqual([]);
	});

	it("stops scanning at the first index missing a required field", () => {
		const env = {
			S3_COMPATIBLE_0_PREFIX: "/a/",
			S3_COMPATIBLE_0_HOST: "a.example.com",
			S3_COMPATIBLE_0_ACCESS_KEY_ID: "key0",
			S3_COMPATIBLE_0_SECRET_ACCESS_KEY: "secret0",
			S3_COMPATIBLE_1_PREFIX: "/b/",
			S3_COMPATIBLE_1_HOST: "b.example.com",
			S3_COMPATIBLE_1_ACCESS_KEY_ID: "key1",
			// missing S3_COMPATIBLE_1_SECRET_ACCESS_KEY
		};
		const routes = parsePathPrefixRoutes(env);
		expect(routes).toHaveLength(1);
		expect(routes[0].prefix).toBe("/a/");
	});

	it("parses multiple complete routes with independent credentials", () => {
		const env = {
			S3_COMPATIBLE_0_PREFIX: "/a/",
			S3_COMPATIBLE_0_HOST: "a.example.com",
			S3_COMPATIBLE_0_ACCESS_KEY_ID: "key0",
			S3_COMPATIBLE_0_SECRET_ACCESS_KEY: "secret0",
			S3_COMPATIBLE_1_PREFIX: "/bb/",
			S3_COMPATIBLE_1_HOST: "b.example.com",
			S3_COMPATIBLE_1_ACCESS_KEY_ID: "key1",
			S3_COMPATIBLE_1_SECRET_ACCESS_KEY: "secret1",
			S3_COMPATIBLE_1_REGION: "eu-west-1",
		};
		const routes = parsePathPrefixRoutes(env);
		expect(routes).toHaveLength(2);
		const byPrefix = Object.fromEntries(routes.map((r) => [r.prefix, r]));
		expect(byPrefix["/a/"]).toMatchObject({ accessKeyId: "key0", secretAccessKey: "secret0" });
		expect(byPrefix["/bb/"]).toMatchObject({ accessKeyId: "key1", secretAccessKey: "secret1", region: "eu-west-1" });
	});

	it("treats an empty PREFIX as a valid catch-all route", () => {
		const env = {
			S3_COMPATIBLE_0_PREFIX: "",
			S3_COMPATIBLE_0_HOST: "default.example.com",
			S3_COMPATIBLE_0_ACCESS_KEY_ID: "key0",
			S3_COMPATIBLE_0_SECRET_ACCESS_KEY: "secret0",
		};
		expect(parsePathPrefixRoutes(env)).toHaveLength(1);
	});

	it("returns [] when numbering skips index 0", () => {
		const env = {
			S3_COMPATIBLE_1_PREFIX: "/a/",
			S3_COMPATIBLE_1_HOST: "a.example.com",
			S3_COMPATIBLE_1_ACCESS_KEY_ID: "key1",
			S3_COMPATIBLE_1_SECRET_ACCESS_KEY: "secret1",
		};
		expect(parsePathPrefixRoutes(env)).toEqual([]);
	});

	it("sorts routes by descending prefix length, empty prefix last", () => {
		const env = {
			S3_COMPATIBLE_0_PREFIX: "",
			S3_COMPATIBLE_0_HOST: "default.example.com",
			S3_COMPATIBLE_0_ACCESS_KEY_ID: "key0",
			S3_COMPATIBLE_0_SECRET_ACCESS_KEY: "secret0",
			S3_COMPATIBLE_1_PREFIX: "/a/",
			S3_COMPATIBLE_1_HOST: "a.example.com",
			S3_COMPATIBLE_1_ACCESS_KEY_ID: "key1",
			S3_COMPATIBLE_1_SECRET_ACCESS_KEY: "secret1",
			S3_COMPATIBLE_2_PREFIX: "/a/nested/",
			S3_COMPATIBLE_2_HOST: "nested.example.com",
			S3_COMPATIBLE_2_ACCESS_KEY_ID: "key2",
			S3_COMPATIBLE_2_SECRET_ACCESS_KEY: "secret2",
		};
		const routes = parsePathPrefixRoutes(env);
		expect(routes.map((r) => r.prefix)).toEqual(["/a/nested/", "/a/", ""]);
	});
});

describe("resolveS3Route", () => {
	const routes: S3Route[] = [
		{ prefix: "/a/nested/", host: "nested.example.com", accessKeyId: "k2", secretAccessKey: "s2" },
		{ prefix: "/a/", host: "a.example.com", accessKeyId: "k1", secretAccessKey: "s1" },
		{ prefix: "", host: "default.example.com", accessKeyId: "k0", secretAccessKey: "s0" },
	];

	it("matches the longest applicable prefix", () => {
		expect(resolveS3Route("/a/nested/file.jpg", routes)?.host).toBe("nested.example.com");
		expect(resolveS3Route("/a/other.jpg", routes)?.host).toBe("a.example.com");
	});

	it("falls back to the empty-prefix catch-all route", () => {
		expect(resolveS3Route("/unrelated/file.jpg", routes)?.host).toBe("default.example.com");
	});

	it("returns null when there are no routes", () => {
		expect(resolveS3Route("/anything.jpg", [])).toBeNull();
	});
});
