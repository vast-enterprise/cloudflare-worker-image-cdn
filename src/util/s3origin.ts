/**
 * Util to sign origin requests with AWS SigV4 and route them to different
 * S3-compatible hosts based on a path prefix.
 *
 * Routes are read from flat, numbered env vars:
 *   S3_COMPATIBLE_<N>_PREFIX / _HOST / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _REGION
 * starting at N=0, scanned until the first index missing a required field.
 * A route with an empty PREFIX ("") matches every path and sorts last, acting
 * as a catch-all default origin.
 */
import { AwsClient } from "aws4fetch";

export interface S3Route {
	prefix: string;
	host: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
}

export function createS3Client(route: S3Route): AwsClient {
	return new AwsClient({
		accessKeyId: route.accessKeyId,
		secretAccessKey: route.secretAccessKey,
		service: "s3",
		region: route.region ?? "us-east-1",
	});
}

export async function fetchFromS3(client: AwsClient, url: string, method: string): Promise<Response> {
	return client.fetch(url, { method });
}

const MAX_ROUTES = 20;

export function parsePathPrefixRoutes(env: Record<string, string | undefined>): S3Route[] {
	const routes: S3Route[] = [];
	for (let i = 0; i < MAX_ROUTES; i++) {
		const prefix = env[`S3_COMPATIBLE_${i}_PREFIX`];
		const host = env[`S3_COMPATIBLE_${i}_HOST`];
		const accessKeyId = env[`S3_COMPATIBLE_${i}_ACCESS_KEY_ID`];
		const secretAccessKey = env[`S3_COMPATIBLE_${i}_SECRET_ACCESS_KEY`];
		if (prefix === undefined || !host || !accessKeyId || !secretAccessKey) break;
		routes.push({ prefix, host, accessKeyId, secretAccessKey, region: env[`S3_COMPATIBLE_${i}_REGION`] });
	}
	// Longest prefix wins; the empty-prefix catch-all (length 0) naturally sorts last.
	return routes.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function resolveS3Route(pathname: string, routes: S3Route[]): S3Route | null {
	return routes.find((route) => pathname.startsWith(route.prefix)) ?? null;
}
