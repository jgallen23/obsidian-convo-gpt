import { describe, expect, it, vi } from "vitest";
import { executeFetchToolCall } from "../core/fetch-service";

describe("fetch service", () => {
	it("executes GET requests and returns text metadata", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('{"ok":true}', {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await executeFetchToolCall(
			JSON.stringify({
				url: "https://api.example.com/users",
				method: "GET",
				headers: [{ name: "Authorization", value: "Bearer token" }],
				body: null,
			}),
			fetchImpl,
		);

		expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/users", {
			method: "GET",
			headers: { Authorization: "Bearer token" },
			body: undefined,
		});
		expect(result).toMatchObject({
			status: "success",
			method: "GET",
			statusCode: 200,
			statusText: "OK",
			bodyText: '{"ok":true}',
			truncated: false,
		});
		expect(result.headers).toMatchObject({
			"content-type": "application/json",
		});
	});

	it("truncates oversized bodies", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("a".repeat(13000), {
				status: 200,
				statusText: "OK",
			}),
		);

		const result = await executeFetchToolCall(
			JSON.stringify({
				url: "https://api.example.com/big",
				method: "GET",
				headers: [],
				body: null,
			}),
			fetchImpl,
		);

		expect(result.status).toBe("success");
		expect(result.truncated).toBe(true);
		expect(result.bodyText?.endsWith("\n…")).toBe(true);
	});

	it("returns request_error on fetch failure", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED"));

		const result = await executeFetchToolCall(
			JSON.stringify({
				url: "http://127.0.0.1:3000/health",
				method: "GET",
				headers: [],
				body: null,
			}),
			fetchImpl,
		);

		expect(result).toMatchObject({
			status: "request_error",
			method: "GET",
			url: "http://127.0.0.1:3000/health",
		});
		expect(result.message).toContain("ECONNREFUSED");
	});
});
