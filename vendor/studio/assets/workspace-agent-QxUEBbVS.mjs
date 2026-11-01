/*
MIT License

Copyright (c) 2023 Drew Powers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
	return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
	return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
	let { baseUrl = "", Request: CustomRequest = globalThis.Request, fetch: baseFetch = globalThis.fetch, querySerializer: globalQuerySerializer, bodySerializer: globalBodySerializer, pathSerializer: globalPathSerializer, headers: baseHeaders, requestInitExt = void 0, ...baseOptions } = { ...clientOptions };
	requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
	baseUrl = removeTrailingSlash(baseUrl);
	const globalMiddlewares = [];
	async function coreFetch(schemaPath, fetchOptions) {
		const { baseUrl: localBaseUrl, fetch = baseFetch, Request = CustomRequest, headers, params = {}, parseAs = "json", querySerializer: requestQuerySerializer, bodySerializer = globalBodySerializer ?? defaultBodySerializer, pathSerializer: requestPathSerializer, body, middleware: requestMiddlewares = [], ...init } = fetchOptions || {};
		let finalBaseUrl = baseUrl;
		if (localBaseUrl) finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
		let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
		if (requestQuerySerializer) querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
			...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
			...requestQuerySerializer
		});
		const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
		const serializedBody = body === void 0 ? void 0 : bodySerializer(body, mergeHeaders(baseHeaders, headers, params.header));
		const finalHeaders = mergeHeaders(serializedBody === void 0 || serializedBody instanceof FormData ? {} : { "Content-Type": "application/json" }, baseHeaders, headers, params.header);
		const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
		const requestInit = {
			redirect: "follow",
			...baseOptions,
			...init,
			body: serializedBody,
			headers: finalHeaders
		};
		let id;
		let options;
		let request = new Request(createFinalURL(schemaPath, {
			baseUrl: finalBaseUrl,
			params,
			querySerializer,
			pathSerializer
		}), requestInit);
		let response;
		for (const key in init) if (!(key in request)) request[key] = init[key];
		if (finalMiddlewares.length) {
			id = randomID();
			options = Object.freeze({
				baseUrl: finalBaseUrl,
				fetch,
				parseAs,
				querySerializer,
				bodySerializer,
				pathSerializer
			});
			for (const m of finalMiddlewares) if (m && typeof m === "object" && typeof m.onRequest === "function") {
				const result = await m.onRequest({
					request,
					schemaPath,
					params,
					options,
					id
				});
				if (result) {
					if (result instanceof Request) request = result;
					else if (result instanceof Response) {
						response = result;
						break;
					} else throw new Error("onRequest: must return new Request() or Response() when modifying the request");
				}
			}
		}
		if (!response) {
			try {
				response = await fetch(request, requestInitExt);
			} catch (error2) {
				let errorAfterMiddleware = error2;
				if (finalMiddlewares.length) for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
					const m = finalMiddlewares[i];
					if (m && typeof m === "object" && typeof m.onError === "function") {
						const result = await m.onError({
							request,
							error: errorAfterMiddleware,
							schemaPath,
							params,
							options,
							id
						});
						if (result) {
							if (result instanceof Response) {
								errorAfterMiddleware = void 0;
								response = result;
								break;
							}
							if (result instanceof Error) {
								errorAfterMiddleware = result;
								continue;
							}
							throw new Error("onError: must return new Response() or instance of Error");
						}
					}
				}
				if (errorAfterMiddleware) throw errorAfterMiddleware;
			}
			if (finalMiddlewares.length) for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
				const m = finalMiddlewares[i];
				if (m && typeof m === "object" && typeof m.onResponse === "function") {
					const result = await m.onResponse({
						request,
						response,
						schemaPath,
						params,
						options,
						id
					});
					if (result) {
						if (!(result instanceof Response)) throw new Error("onResponse: must return new Response() when modifying the response");
						response = result;
					}
				}
			}
		}
		const contentLength = response.headers.get("Content-Length");
		if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) return response.ok ? {
			data: void 0,
			response
		} : {
			error: void 0,
			response
		};
		if (response.ok) {
			const getResponseData = async () => {
				if (parseAs === "stream") return response.body;
				if (parseAs === "json" && !contentLength) {
					const raw = await response.text();
					return raw ? JSON.parse(raw) : void 0;
				}
				return await response[parseAs]();
			};
			return {
				data: await getResponseData(),
				response
			};
		}
		let error = await response.text();
		try {
			error = JSON.parse(error);
		} catch {}
		return {
			error,
			response
		};
	}
	return {
		request(method, url, init) {
			return coreFetch(url, {
				...init,
				method: method.toUpperCase()
			});
		},
		/** Call a GET endpoint */
		GET(url, init) {
			return coreFetch(url, {
				...init,
				method: "GET"
			});
		},
		/** Call a PUT endpoint */
		PUT(url, init) {
			return coreFetch(url, {
				...init,
				method: "PUT"
			});
		},
		/** Call a POST endpoint */
		POST(url, init) {
			return coreFetch(url, {
				...init,
				method: "POST"
			});
		},
		/** Call a DELETE endpoint */
		DELETE(url, init) {
			return coreFetch(url, {
				...init,
				method: "DELETE"
			});
		},
		/** Call a OPTIONS endpoint */
		OPTIONS(url, init) {
			return coreFetch(url, {
				...init,
				method: "OPTIONS"
			});
		},
		/** Call a HEAD endpoint */
		HEAD(url, init) {
			return coreFetch(url, {
				...init,
				method: "HEAD"
			});
		},
		/** Call a PATCH endpoint */
		PATCH(url, init) {
			return coreFetch(url, {
				...init,
				method: "PATCH"
			});
		},
		/** Call a TRACE endpoint */
		TRACE(url, init) {
			return coreFetch(url, {
				...init,
				method: "TRACE"
			});
		},
		/** Register middleware */
		use(...middleware) {
			for (const m of middleware) {
				if (!m) continue;
				if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
				globalMiddlewares.push(m);
			}
		},
		/** Unregister middleware */
		eject(...middleware) {
			for (const m of middleware) {
				const i = globalMiddlewares.indexOf(m);
				if (i !== -1) globalMiddlewares.splice(i, 1);
			}
		}
	};
}
function serializePrimitiveParam(name, value, options) {
	if (value === void 0 || value === null) return "";
	if (typeof value === "object") throw new Error("Deeply-nested arrays/objects aren’t supported. Provide your own `querySerializer()` to handle these.");
	return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
	if (!value || typeof value !== "object") return "";
	const values = [];
	const joiner = {
		simple: ",",
		label: ".",
		matrix: ";"
	}[options.style] || "&";
	if (options.style !== "deepObject" && options.explode === false) {
		for (const k in value) values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
		const final2 = values.join(",");
		switch (options.style) {
			case "form": return `${name}=${final2}`;
			case "label": return `.${final2}`;
			case "matrix": return `;${name}=${final2}`;
			default: return final2;
		}
	}
	for (const k in value) {
		const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
		values.push(serializePrimitiveParam(finalName, value[k], options));
	}
	const final = values.join(joiner);
	return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
	if (!Array.isArray(value)) return "";
	if (options.explode === false) {
		const joiner2 = {
			form: ",",
			spaceDelimited: "%20",
			pipeDelimited: "|"
		}[options.style] || ",";
		const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
		switch (options.style) {
			case "simple": return final;
			case "label": return `.${final}`;
			case "matrix": return `;${name}=${final}`;
			default: return `${name}=${final}`;
		}
	}
	const joiner = {
		simple: ",",
		label: ".",
		matrix: ";"
	}[options.style] || "&";
	const values = [];
	for (const v of value) if (options.style === "simple" || options.style === "label") values.push(options.allowReserved === true ? v : encodeURIComponent(v));
	else values.push(serializePrimitiveParam(name, v, options));
	return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
	return function querySerializer(queryParams) {
		const search = [];
		if (queryParams && typeof queryParams === "object") for (const name in queryParams) {
			const value = queryParams[name];
			if (value === void 0 || value === null) continue;
			if (Array.isArray(value)) {
				if (value.length === 0) continue;
				search.push(serializeArrayParam(name, value, {
					style: "form",
					explode: true,
					...options?.array,
					allowReserved: options?.allowReserved || false
				}));
				continue;
			}
			if (typeof value === "object") {
				search.push(serializeObjectParam(name, value, {
					style: "deepObject",
					explode: true,
					...options?.object,
					allowReserved: options?.allowReserved || false
				}));
				continue;
			}
			search.push(serializePrimitiveParam(name, value, options));
		}
		return search.join("&");
	};
}
function defaultPathSerializer(pathname, pathParams) {
	let nextURL = pathname;
	for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
		let name = match.substring(1, match.length - 1);
		let explode = false;
		let style = "simple";
		if (name.endsWith("*")) {
			explode = true;
			name = name.substring(0, name.length - 1);
		}
		if (name.startsWith(".")) {
			style = "label";
			name = name.substring(1);
		} else if (name.startsWith(";")) {
			style = "matrix";
			name = name.substring(1);
		}
		if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) continue;
		const value = pathParams[name];
		if (Array.isArray(value)) {
			nextURL = nextURL.replace(match, serializeArrayParam(name, value, {
				style,
				explode
			}));
			continue;
		}
		if (typeof value === "object") {
			nextURL = nextURL.replace(match, serializeObjectParam(name, value, {
				style,
				explode
			}));
			continue;
		}
		if (style === "matrix") {
			nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
			continue;
		}
		nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
	}
	return nextURL;
}
function defaultBodySerializer(body, headers) {
	if (body instanceof FormData) return body;
	if (headers) {
		if ((headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"]) === "application/x-www-form-urlencoded") return new URLSearchParams(body).toString();
	}
	return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
	let finalURL = `${options.baseUrl}${pathname}`;
	if (options.params?.path) finalURL = options.pathSerializer(finalURL, options.params.path);
	let search = options.querySerializer(options.params.query ?? {});
	if (search.startsWith("?")) search = search.substring(1);
	if (search) finalURL += `?${search}`;
	return finalURL;
}
function mergeHeaders(...allHeaders) {
	const finalHeaders = new Headers();
	for (const h of allHeaders) {
		if (!h || typeof h !== "object") continue;
		const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
		for (const [k, v] of iterator) if (v === null) finalHeaders.delete(k);
		else if (Array.isArray(v)) for (const v2 of v) finalHeaders.append(k, v2);
		else if (v !== void 0) finalHeaders.set(k, v);
	}
	return finalHeaders;
}
function removeTrailingSlash(url) {
	if (url.endsWith("/")) return url.substring(0, url.length - 1);
	return url;
}
// src/api/global-client.ts
/** The Global authority manages Keys and discovery; a data request uses a Region client. */
function createGlobalApiClient(origin, trustedOrigins, fetcher = fetch, owner = false) {
	const url = new URL(origin);
	const loopback = [
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(url.hostname);
	if (url.search || url.hash || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname) || !trustedOrigins.includes(url.origin) || url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password) throw new Error("Untrusted Global origin.");
	const boundedFetch = (input, init) => {
		const request = new Request(input, init);
		const target = new URL(request.url);
		if (target.origin !== url.origin || !target.pathname.startsWith(url.pathname.replace(/\/$/, "") + "/api/")) throw new Error("Request outside the Global API.");
		return fetcher(new Request(request, {
			redirect: "error",
			credentials: owner ? "include" : "omit"
		}));
	};
	return createClient({
		baseUrl: origin,
		fetch: boundedFetch
	});
}
// src/api/transport.ts
var WorkspaceApiError = class extends Error {
	status;
	code;
	requestId;
	constructor(message, status, code, requestId) {
		super(message);
		this.name = "WorkspaceApiError";
		this.status = status;
		this.code = code;
		this.requestId = requestId;
	}
};
function createWorkspaceClient(origin, fetcher = fetch, apiPath = "/api/v1") {
	const client = createClient({
		baseUrl: origin + apiPath,
		credentials: "include",
		fetch: fetcher
	});
	client.use({ async onResponse({ response }) {
		if (response.ok) return;
		let message = `Request failed (${response.status}).`, code;
		let requestId = response.headers.get("X-Request-Id") || void 0;
		try {
			const body = await response.clone().json();
			if (body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object") {
				if ("message" in body.error && typeof body.error.message === "string") message = body.error.message;
				if ("code" in body.error && typeof body.error.code === "string") code = body.error.code;
				if ("requestId" in body.error && typeof body.error.requestId === "string") requestId = body.error.requestId;
			}
		} catch {}
		throw new WorkspaceApiError(message, response.status, code, requestId);
	} });
	return client;
}
// src/api/region-client.ts
/** Validate a Region endpoint against deployment-owned trust, never a redirect or error body. */
function validateRegionEndpoint(endpoint, allowedOrigins) {
	if (!/^region:[A-Za-z0-9_.:-]{1,100}$/.test(endpoint.regionId)) throw new Error("Invalid Region identity.");
	const url = new URL(endpoint.apiOrigin);
	const loopback = [
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.origin !== endpoint.apiOrigin || !allowedOrigins.includes(url.origin) || !/^(?:\/[A-Za-z0-9_-]+)*$/.test(endpoint.apiPathPrefix)) throw new Error("Untrusted Region endpoint.");
	return { ...endpoint };
}
/** Create an origin-bound Workspace client using only the supplied regional credential. */
function createRegionClient(endpoint, allowedOrigins, workspaceId, credential, fetcher = fetch) {
	const target = validateRegionEndpoint(endpoint, allowedOrigins);
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId) || [".", ".."].includes(workspaceId)) throw new Error("Invalid Workspace identity.");
	if (typeof credential === "string" && (!credential || /[\r\n]/.test(credential))) throw new Error("Invalid regional credential.");
	const apiPath = target.apiPathPrefix + "/api/v1";
	const workspacePath = `${apiPath}/workspaces/${encodeURIComponent(workspaceId)}`;
	const regionalFetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== target.apiOrigin || url.pathname !== workspacePath && !url.pathname.startsWith(workspacePath + "/")) throw new Error("Request outside the Region API.");
		const headers = new Headers(request.headers);
		const token = typeof credential === "string" ? credential : await credential();
		if (!token || /\s/.test(token)) throw new Error("Invalid regional credential.");
		headers.set("Authorization", `Bearer ${token}`);
		return fetcher(new Request(request, {
			headers,
			redirect: "error",
			credentials: "omit"
		}));
	};
	return createWorkspaceClient(target.apiOrigin, regionalFetch, apiPath);
}
// src/api/agent-client.ts
function base64url(bytes) {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid regional response.");
	return value;
}
function text(value) {
	if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error("Invalid regional credential response.");
	return value;
}
function expiry(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid regional expiry.");
	return value;
}
/** Cached refresh credentials and routes use Region directly, including during Global outage. */
async function connectAgentWorkspace(options) {
	const fetcher = options.fetcher ?? fetch;
	const checkedEndpoint = (endpoint) => {
		const checked = validateRegionEndpoint(endpoint, options.trustedRegionOrigins);
		if (options.expectedEndpoint && (checked.regionId !== options.expectedEndpoint.regionId || checked.apiOrigin !== options.expectedEndpoint.apiOrigin || checked.apiPathPrefix !== options.expectedEndpoint.apiPathPrefix)) throw new Error("Region route does not match Global issuance.");
		return checked;
	};
	if (options.proofKey.privateKey.type !== "private" || options.proofKey.privateKey.algorithm.name !== "Ed25519" || options.proofKey.publicKey.algorithm.name !== "Ed25519") throw new Error("An Ed25519 client proof key is required.");
	const exported = await crypto.subtle.exportKey("jwk", options.proofKey.publicKey);
	if (exported.crv !== "Ed25519" || exported.kty !== "OKP" || !exported.x) throw new Error("Invalid client public key.");
	const jwk = {
		crv: "Ed25519",
		kty: "OKP",
		x: exported.x
	};
	const thumbprint = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(jwk)))));
	const sign = async (uri, nonce) => {
		const input = `${base64url(new TextEncoder().encode(JSON.stringify({
			typ: "dpop+jwt",
			alg: "EdDSA",
			jwk
		})))}.${base64url(new TextEncoder().encode(JSON.stringify({
			jti: crypto.randomUUID(),
			htm: "POST",
			htu: uri,
			nonce,
			iat: Math.floor(Date.now() / 1e3)
		})))}`;
		return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign("Ed25519", options.proofKey.privateKey, new TextEncoder().encode(input))))}`;
	};
	let stored = await options.secrets.load();
	let session;
	let access;
	const regionRequest = async (endpoint, route, input, nonce, credential) => {
		const url = endpoint.apiOrigin + endpoint.apiPathPrefix + `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}` + route;
		const response = await fetcher(url, {
			method: "POST",
			redirect: "error",
			credentials: "omit",
			headers: {
				"Content-Type": "application/json",
				DPoP: await sign(url, nonce),
				...credential ? { Authorization: `Refresh ${credential}` } : {}
			},
			body: JSON.stringify(input)
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Empty regional authentication response.");
		const chunks = [];
		let size = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > 32768) {
				await reader.cancel();
				throw new Error("Regional authentication response exceeded its limit.");
			}
			chunks.push(chunk.value);
		}
		const all = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			all.set(chunk, offset);
			offset += chunk.length;
		}
		const body = JSON.parse(new TextDecoder().decode(all));
		if (!response.ok) {
			const error = record(record(body).error);
			throw new Error(typeof error.code === "string" ? error.code : "REGION_AUTH_UNAVAILABLE");
		}
		return record(body);
	};
	if (stored) {
		if (stored.workspaceId !== options.workspaceId || stored.regionId !== options.regionId || stored.thumbprint !== thumbprint || stored.endpoint.regionId !== options.regionId) throw new Error("Cached regional identity mismatch.");
		stored = {
			...stored,
			endpoint: checkedEndpoint(stored.endpoint)
		};
	} else {
		if (!options.workspaceKey || /\s/.test(options.workspaceKey)) throw new Error("Workspace Key required for initial enrollment.");
		const global = createGlobalApiClient(options.globalOrigin, options.trustedGlobalOrigins, fetcher);
		const issuance = options.discoverWorkspaceFromKey ? await global.POST("/api/v1/token-issuances", {
			headers: { Authorization: `Bearer ${options.workspaceKey}` },
			body: {
				audience: "region",
				clientThumbprint: thumbprint
			}
		}) : await global.POST("/api/v1/workspaces/{workspaceId}/token-issuances", {
			params: { path: { workspaceId: options.workspaceId } },
			headers: { Authorization: `Bearer ${options.workspaceKey}` },
			body: {
				audience: options.regionId,
				clientThumbprint: thumbprint
			}
		});
		if (issuance.error) throw new Error(issuance.error.error.code);
		const value = issuance.data;
		if (!value || !("enrollmentTicket" in value) || value.region.regionId !== options.regionId || options.discoverWorkspaceFromKey && (!("workspaceId" in value) || value.workspaceId !== options.workspaceId)) throw new Error("Regional enrollment result required.");
		stored = {
			state: "enrolling",
			workspaceId: options.workspaceId,
			regionId: options.regionId,
			principalId: value.principalId,
			keyId: value.keyId,
			endpoint: checkedEndpoint(value.region),
			thumbprint,
			enrollmentTicket: value.enrollmentTicket,
			nonce: value.nonce,
			expiresAt: value.enrollmentExpiresAt
		};
		await options.secrets.save(stored);
		access = {
			token: value.accessToken,
			expiresAt: value.expiresAt
		};
	}
	if (stored.state === "enrolling") {
		const enrolled = await regionRequest(stored.endpoint, "/refresh-families", { ticket: stored.enrollmentTicket }, stored.nonce);
		if (enrolled.keyId !== stored.keyId) throw new Error("Regional Key mismatch.");
		session = {
			state: "ready",
			workspaceId: stored.workspaceId,
			regionId: stored.regionId,
			principalId: stored.principalId,
			keyId: stored.keyId,
			endpoint: stored.endpoint,
			thumbprint: stored.thumbprint,
			familyId: text(enrolled.familyId),
			refreshCredential: text(enrolled.refreshCredential),
			nonce: text(enrolled.nonce),
			expiresAt: expiry(enrolled.expiresAt)
		};
		await options.secrets.save(session);
	} else session = stored;
	let renewing;
	let unavailable;
	const renew = async () => {
		if (unavailable) throw unavailable;
		if (!renewing) renewing = (async () => {
			if (!session) throw new Error("Regional session unavailable.");
			const result = await regionRequest(session.endpoint, "/token-issuances", { keyId: session.keyId }, session.nonce, session.refreshCredential);
			if (result.keyId !== session.keyId || result.familyId !== session.familyId) throw new Error("Regional refresh identity mismatch.");
			const next = {
				...session,
				refreshCredential: text(result.refreshCredential),
				nonce: text(result.nonce),
				expiresAt: expiry(result.refreshExpiresAt)
			};
			const token = {
				token: text(result.accessToken),
				expiresAt: expiry(result.expiresAt)
			};
			await options.secrets.save(next);
			session = next;
			access = token;
		})().catch((error) => {
			unavailable = error instanceof Error ? error : /* @__PURE__ */ new Error("REGION_AUTH_OUTCOME_UNKNOWN");
			throw unavailable;
		}).finally(() => {
			renewing = void 0;
		});
		await renewing;
	};
	const credential = async () => {
		if (unavailable) throw unavailable;
		if (!access || access.expiresAt <= Math.floor(Date.now() / 1e3)) await renew();
		if (!access) throw new Error("Regional token unavailable.");
		return access.token;
	};
	return {
		client: createRegionClient(session.endpoint, options.trustedRegionOrigins, options.workspaceId, credential, fetcher),
		endpoint: session.endpoint,
		renew
	};
}
/** Only Global is configured. Region routing and Token exchange stay inside the client. */
async function connectAgent(options) {
	const fetcher = options.fetcher ?? fetch;
	if (!options.key || /\s/.test(options.key)) throw new Error("Workspace Key required.");
	const globalUrl = new URL(options.endpoint);
	if (globalUrl.username || globalUrl.password || globalUrl.search || globalUrl.hash) throw new Error("Untrusted Global endpoint.");
	const endpointPath = globalUrl.pathname.replace(/\/$/, "");
	if (!endpointPath.endsWith("/api")) throw new Error("The API endpoint must end in /api.");
	const globalEndpoint = globalUrl.origin + endpointPath.slice(0, -4);
	const global = createGlobalApiClient(globalEndpoint, [globalUrl.origin], fetcher);
	const bindingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(options.key), {
		name: "HMAC",
		hash: "SHA-256"
	}, false, ["sign"]);
	const binding = async (value) => {
		const identity = [
			globalEndpoint,
			value.workspaceId,
			value.regionId,
			value.principalId,
			value.keyId,
			value.endpoint.apiOrigin,
			value.endpoint.apiPathPrefix,
			value.thumbprint,
			value.state,
			value.nonce,
			value.expiresAt,
			...value.state === "ready" ? [value.familyId, value.refreshCredential] : [value.enrollmentTicket]
		];
		return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", bindingKey, new TextEncoder().encode(JSON.stringify(identity)))));
	};
	let memory;
	const backing = options.secrets ?? {
		async load() {
			return memory;
		},
		async save(value) {
			memory = value;
		}
	};
	const secrets = {
		async load() {
			const value = await backing.load();
			if (value && value.connectionBinding !== await binding(value)) throw new Error("Cached connection belongs to a different Global endpoint or Key.");
			return value;
		},
		async save(value) {
			await backing.save({
				...value,
				connectionBinding: await binding(value)
			});
		}
	};
	const cached = await secrets.load();
	if (cached && !options.proofKey) throw new Error("The saved regional session requires its original client proof key.");
	const proofKey = options.proofKey ?? await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
	let workspaceId;
	let endpoint;
	if (cached) {
		workspaceId = cached.workspaceId;
		endpoint = cached.endpoint;
	} else {
		const issuance = await global.POST("/api/v1/token-issuances", {
			headers: { Authorization: `Bearer ${options.key}` },
			body: { audience: "global" }
		});
		if (issuance.error) throw new Error(issuance.error.error.code);
		const token = issuance.data;
		if (!token || !("workspaceId" in token)) throw new Error("Global discovery failed.");
		workspaceId = token.workspaceId;
		const response = await fetcher(`${globalEndpoint}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/region-route`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token.accessToken}` },
			redirect: "manual",
			credentials: "omit"
		});
		if (response.status !== 307) throw new Error("Global Region routing unavailable.");
		const location = response.headers.get("Location");
		const regionId = response.headers.get("X-Region-Id");
		if (!location || !regionId) throw new Error("Invalid Global Region redirect.");
		const target = new URL(location);
		const loopback = [
			"127.0.0.1",
			"localhost",
			"[::1]"
		];
		if (target.search || target.hash || target.username || target.password || loopback.includes(target.hostname) && !loopback.includes(globalUrl.hostname) || target.protocol !== "https:" && !(target.protocol === "http:" && loopback.includes(target.hostname) && loopback.includes(globalUrl.hostname))) throw new Error("Untrusted Region redirect.");
		endpoint = validateRegionEndpoint({
			regionId,
			apiOrigin: target.origin,
			apiPathPrefix: target.pathname.replace(/\/$/, "")
		}, [target.origin]);
	}
	const connected = await connectAgentWorkspace({
		globalOrigin: globalEndpoint,
		trustedGlobalOrigins: [globalUrl.origin],
		trustedRegionOrigins: [endpoint.apiOrigin],
		expectedEndpoint: endpoint,
		discoverWorkspaceFromKey: true,
		workspaceId,
		regionId: endpoint.regionId,
		workspaceKey: options.key,
		proofKey,
		secrets,
		fetcher
	});
	return {
		client: connected.client,
		workspaceId,
		renew: connected.renew
	};
}
// src/api/agent-sdk.ts
/** A Workspace connection configured with one public endpoint and one API key. */
async function connectWorkspace(options) {
	const connection = await connectAgent({
		endpoint: options.endpoint,
		key: options.apiKey,
		proofKey: options.proofKey,
		secrets: options.secrets,
		fetcher: options.fetcher
	});
	const { client, workspaceId } = connection;
	return {
		async listResources(page = {}) {
			const result = await client.GET("/workspaces/{workspaceId}/resources", { params: {
				path: { workspaceId },
				query: page
			} });
			if (!result.data) throw new Error("Unable to list resources.");
			return result.data;
		},
		async query(databaseId, sql, options = {}) {
			const result = await client.POST("/workspaces/{workspaceId}/queries", {
				params: { path: { workspaceId } },
				body: {
					resourceId: databaseId,
					sql,
					readOnly: options.readOnly ?? true
				}
			});
			if (!result.data) throw new Error("Unable to run query.");
			return result.data;
		},
		async listFiles(fileSystemId, path = "/", page = {}) {
			const result = await client.GET("/workspaces/{workspaceId}/files", { params: {
				path: { workspaceId },
				query: {
					resourceId: fileSystemId,
					path,
					...page
				}
			} });
			if (!result.data) throw new Error("Unable to list files.");
			return result.data;
		},
		/** Generated API for other operations; Workspace identity is discovered automatically. */
		api: client,
		workspaceId,
		renew: connection.renew
	};
}
export { connectWorkspace };
