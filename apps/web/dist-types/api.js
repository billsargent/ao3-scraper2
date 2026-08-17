async function request(path, options) {
    const response = await fetch(path, {
        ...options,
        headers: { "content-type": "application/json", ...options?.headers },
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? `Request failed with HTTP ${response.status}`);
    }
    return response.json();
}
export const api = {
    health: () => request("/api/health/ready"),
    sources: () => request("/api/sources"),
    createSource: (body) => request("/api/sources", {
        method: "POST", body: JSON.stringify(body),
    }),
    updateSource: (id, body) => request(`/api/sources/${id}`, {
        method: "PUT", body: JSON.stringify(body),
    }),
    jobs: () => request("/api/jobs?limit=100&offset=0"),
    job: (id) => request(`/api/jobs/${id}`),
    createJob: (body) => request("/api/jobs/id-range", {
        method: "POST", body: JSON.stringify(body),
    }),
    controlJob: (id, action) => request(`/api/jobs/${id}/${action}`, { method: "POST" }),
    works: () => request("/api/works?limit=100&offset=0"),
};
//# sourceMappingURL=api.js.map