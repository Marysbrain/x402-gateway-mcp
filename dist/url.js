/** Validate every required input before any wallet reservation or paid fetch.
 * GET inputs become query parameters; POST inputs stay in the JSON body. */
export function buildTargetUrl(gatewayUrl, endpoint, args) {
    for (const name of endpoint.inputSchema.required ?? []) {
        if (args[name] === undefined || args[name] === null) {
            throw new Error(`missing required parameter: ${name}`);
        }
    }
    let path = endpoint.route;
    const used = new Set();
    path = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
        used.add(name);
        return encodeURIComponent(String(args[name]));
    });
    if (endpoint.method === "POST")
        return `${gatewayUrl}${path}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
        if (!used.has(key) && value !== undefined && value !== null)
            query.set(key, String(value));
    }
    const qs = query.toString();
    return `${gatewayUrl}${path}${qs ? `?${qs}` : ""}`;
}
