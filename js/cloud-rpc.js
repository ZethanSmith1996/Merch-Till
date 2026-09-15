import { supabaseConfig } from "./config.js?v=stage23";

function accessToken() {
    return sessionStorage.getItem("merchTillAccessToken") ||
           sessionStorage.getItem("supabaseAccessToken") || "";
}

export async function authenticatedRpc(name, body = {}) {
    if (!navigator.onLine) throw new Error("This action requires an internet connection.");

    const token = accessToken();
    if (!token) throw new Error("No cloud session is available. Log out and log back in while online.");

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/rpc/${name}`,
        {
            method: "POST",
            headers: {
                apikey: supabaseConfig.publishableKey,
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    const text = await response.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
    }

    if (!response.ok) {
        throw new Error(
            data?.message || data?.error ||
            (typeof data === "string" ? data : "") ||
            `Cloud request failed (${response.status}).`
        );
    }
    return data;
}
