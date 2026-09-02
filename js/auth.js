import { dom } from "./dom.js";
import { state } from "./state.js";
import { clearCart } from "./till.js";
import { supabaseConfig } from "./config.js";

const CLOUD_ACCESS_TOKEN_KEY = "merchTillCloudAccessToken";
const CLOUD_REFRESH_TOKEN_KEY = "merchTillCloudRefreshToken";
const CLOUD_EXPIRES_AT_KEY = "merchTillCloudExpiresAt";
const CLOUD_SESSION_OWNER_KEY = "merchTillCloudSessionOwner";

function normaliseCloudUsername(username) {
    return String(username || "").trim().toLowerCase();
}

function scopedCloudKey(baseKey, username) {
    return `${baseKey}:${normaliseCloudUsername(username)}`;
}

function currentCloudUsername() {
    return normaliseCloudUsername(
        sessionStorage.getItem("merchTillUsername") || ""
    );
}

function migrateLegacyCloudSession(username) {
    const normalisedUsername = normaliseCloudUsername(username);

    if (!normalisedUsername) {
        return;
    }

    const owner = normaliseCloudUsername(
        localStorage.getItem(CLOUD_SESSION_OWNER_KEY) || ""
    );

    // Only migrate an old unscoped session when we can prove which Till user
    // created it. Older builds did not always record an owner, so an unowned
    // token is deliberately not reused for another account.
    if (owner !== normalisedUsername) {
        return;
    }

    const scopedAccessKey =
        scopedCloudKey(CLOUD_ACCESS_TOKEN_KEY, normalisedUsername);
    const scopedRefreshKey =
        scopedCloudKey(CLOUD_REFRESH_TOKEN_KEY, normalisedUsername);
    const scopedExpiryKey =
        scopedCloudKey(CLOUD_EXPIRES_AT_KEY, normalisedUsername);

    if (!localStorage.getItem(scopedAccessKey)) {
        const legacyAccess = localStorage.getItem(CLOUD_ACCESS_TOKEN_KEY);
        if (legacyAccess) {
            localStorage.setItem(scopedAccessKey, legacyAccess);
        }
    }

    if (!localStorage.getItem(scopedRefreshKey)) {
        const legacyRefresh = localStorage.getItem(CLOUD_REFRESH_TOKEN_KEY);
        if (legacyRefresh) {
            localStorage.setItem(scopedRefreshKey, legacyRefresh);
        }
    }

    if (!localStorage.getItem(scopedExpiryKey)) {
        const legacyExpiry = localStorage.getItem(CLOUD_EXPIRES_AT_KEY);
        if (legacyExpiry) {
            localStorage.setItem(scopedExpiryKey, legacyExpiry);
        }
    }
}

function saveCloudSession(authData, username) {
    const normalisedUsername = normaliseCloudUsername(username);

    if (!normalisedUsername) {
        throw new Error("Cloud session username is missing.");
    }

    if (authData.access_token) {
        localStorage.setItem(
            scopedCloudKey(CLOUD_ACCESS_TOKEN_KEY, normalisedUsername),
            authData.access_token
        );
    }

    if (authData.refresh_token) {
        localStorage.setItem(
            scopedCloudKey(CLOUD_REFRESH_TOKEN_KEY, normalisedUsername),
            authData.refresh_token
        );
    }

    if (Number(authData.expires_in) > 0) {
        localStorage.setItem(
            scopedCloudKey(CLOUD_EXPIRES_AT_KEY, normalisedUsername),
            String(Date.now() + Number(authData.expires_in) * 1000)
        );
    }

    // Retained only to permit safe one-time migration from Stage 13's
    // unscoped token layout.
    localStorage.setItem(CLOUD_SESSION_OWNER_KEY, normalisedUsername);
}

async function refreshCloudSession(username) {
    const normalisedUsername = normaliseCloudUsername(username);

    if (!normalisedUsername) {
        return null;
    }

    migrateLegacyCloudSession(normalisedUsername);

    const refreshToken = localStorage.getItem(
        scopedCloudKey(CLOUD_REFRESH_TOKEN_KEY, normalisedUsername)
    );

    if (!refreshToken) {
        return null;
    }

    const response = await fetch(
        `${supabaseConfig.url}/auth/v1/token?grant_type=refresh_token`,
        {
            method: "POST",
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                refresh_token: refreshToken
            })
        }
    );

    if (!response.ok) {
        return null;
    }

    const authData = await response.json();

    if (!authData.access_token) {
        return null;
    }

    saveCloudSession(authData, normalisedUsername);
    return authData.access_token;
}

async function tokenStillValid(accessToken) {
    if (!accessToken) {
        return false;
    }

    const response = await fetch(
        `${supabaseConfig.url}/auth/v1/user`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`
            }
        }
    );

    return response.ok;
}

async function tokenBelongsToUsername(accessToken, username) {
    if (!accessToken) {
        return false;
    }

    return Boolean(await loadCloudProfile(accessToken, username));
}

export async function getValidCloudAccessToken() {
    const username = currentCloudUsername();

    if (!username || !isCloudUsername(username)) {
        return null;
    }

    migrateLegacyCloudSession(username);

    const accessToken = localStorage.getItem(
        scopedCloudKey(CLOUD_ACCESS_TOKEN_KEY, username)
    ) || "";

    const expiresAt = Number(
        localStorage.getItem(
            scopedCloudKey(CLOUD_EXPIRES_AT_KEY, username)
        ) || 0
    );

    if (accessToken && expiresAt > Date.now() + 60000) {
        try {
            if (await tokenBelongsToUsername(accessToken, username)) {
                return accessToken;
            }
        } catch (error) {
            console.warn("Cloud session ownership could not be checked:", error);
        }
    }

    if (accessToken && !expiresAt) {
        try {
            if (await tokenBelongsToUsername(accessToken, username)) {
                return accessToken;
            }
        } catch (error) {
            console.warn("Cloud session could not be checked:", error);
        }
    }

    try {
        const refreshedToken = await refreshCloudSession(username);

        if (
            refreshedToken &&
            await tokenBelongsToUsername(refreshedToken, username)
        ) {
            return refreshedToken;
        }

        return null;
    } catch (error) {
        console.warn("Cloud session could not be refreshed:", error);
        return null;
    }
}

export function showApplication(username) {
    dom.loginScreen.hidden = true;
    dom.appScreen.hidden = false;
    dom.loggedInUser.textContent = username;

    document.dispatchEvent(new CustomEvent("user-role-changed"));
}

export function showLogin() {
    dom.appScreen.hidden = true;
    dom.loginScreen.hidden = false;
    dom.loginForm.reset();
    dom.errorMessage.textContent = "";
}

export function isCloudUsername(username) {
    /*
     * All operational users are now cloud users.
     * Training remains the deliberate local-only simulation account.
     */
    return normaliseCloudUsername(username) !== "training";
}

async function signInToSupabase(username, password) {
    const normalisedUsername =
        normaliseCloudUsername(username);

    const response = await fetch(
        `${supabaseConfig.url}/functions/v1/login-user`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username: normalisedUsername,
                password
            })
        }
    );

    const responseText = await response.text();

    let data = null;

    try {
        data = JSON.parse(responseText);
    } catch (error) {
        data = null;
    }

    if (!response.ok) {
        throw new Error(
            data?.error ||
            data?.message ||
            responseText ||
            "Cloud login could not be completed."
        );
    }

    if (
        !data?.success ||
        !data?.session?.access_token ||
        !data?.session?.refresh_token ||
        !data?.user?.username ||
        !data?.user?.role
    ) {
        throw new Error(
            "Supabase did not return a valid Till login session."
        );
    }

    saveCloudSession(
        data.session,
        data.user.username
    );

    return {
        username: data.user.username,
        role: data.user.role
    };
}

async function loadCloudProfile(accessToken, username) {
    const response = await fetch(
        `${supabaseConfig.url}/auth/v1/user`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`
            }
        }
    );

    if (!response.ok) {
        return null;
    }

    const authUser = await response.json();

    if (!authUser?.id) {
        return null;
    }

    const profileResponse = await fetch(
        `${supabaseConfig.url}/rest/v1/profiles` +
        `?id=eq.${encodeURIComponent(authUser.id)}` +
        `&select=username,role,active`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json"
            }
        }
    );

    if (!profileResponse.ok) {
        return null;
    }

    const profiles = await profileResponse.json();
    const profile = profiles[0];

    if (
        !profile ||
        !profile.active ||
        profile.username.toLowerCase() !== username.toLowerCase()
    ) {
        return null;
    }

    return profile;
}

async function restoreCloudSession(username) {
    const accessToken = await getValidCloudAccessToken();

    if (!accessToken) {
        return null;
    }

    return loadCloudProfile(accessToken, username);
}

export async function validateSavedSession() {
    const savedUsername = sessionStorage.getItem("merchTillUsername");

    if (!savedUsername) {
        return;
    }

    if (isCloudUsername(savedUsername)) {
        try {
            const profile = await restoreCloudSession(savedUsername);

            if (!profile) {
                sessionStorage.clear();
                showLogin();
                return;
            }

            sessionStorage.setItem("merchTillRole", profile.role);
            showApplication(profile.username);
            return;
        } catch (error) {
            console.error("Saved cloud session could not be restored:", error);
            sessionStorage.clear();
            showLogin();
            return;
        }
    }

    const user = state.users.find(function (item) {
        return item.username === savedUsername && item.active;
    });

    if (!user) {
        sessionStorage.clear();
        showLogin();
        return;
    }

    sessionStorage.setItem("merchTillRole", user.role);
    showApplication(user.username);
}

export function initialiseAuthentication() {
    dom.loginForm.addEventListener("submit", async function (event) {
        event.preventDefault();

        const enteredUsername =
            document.getElementById("username").value.trim();
        const enteredPassword =
            document.getElementById("password").value;

        dom.errorMessage.textContent = "";

        if (normaliseCloudUsername(enteredUsername) === "training") {
            const matchingTrainingUser =
                state.users.find(function (user) {
                    return (
                        user.active &&
                        normaliseCloudUsername(user.username) === "training" &&
                        user.password === enteredPassword
                    );
                });

            if (matchingTrainingUser) {
                sessionStorage.setItem("merchTillLoggedIn", "true");
                sessionStorage.setItem(
                    "merchTillUsername",
                    matchingTrainingUser.username
                );
                sessionStorage.setItem(
                    "merchTillRole",
                    matchingTrainingUser.role
                );
                showApplication(
                    matchingTrainingUser.username
                );
                return;
            }

            dom.errorMessage.textContent =
                "Incorrect username or password.";
            document.getElementById("password").value = "";
            return;
        }

        if (!navigator.onLine) {
            dom.errorMessage.textContent =
                "Cloud login requires an internet connection. Reconnect and try again.";
            document.getElementById("password").value = "";
            return;
        }

        try {
            const cloudProfile = await signInToSupabase(
                enteredUsername,
                enteredPassword
            );

            sessionStorage.setItem("merchTillLoggedIn", "true");
            sessionStorage.setItem(
                "merchTillUsername",
                cloudProfile.username
            );
            sessionStorage.setItem(
                "merchTillRole",
                cloudProfile.role
            );

            showApplication(
                cloudProfile.username
            );

            document.dispatchEvent(
                new CustomEvent("cloud-authenticated")
            );

            return;

        } catch (error) {
            console.error("Cloud login failed:", error);

            dom.errorMessage.textContent =
                error.message ||
                "Incorrect username or password.";

            document.getElementById("password").value = "";
            return;
        }
    });

    dom.logoutButton.addEventListener("click", function () {
        // This signs out of the Till UI only. Each cloud user's Supabase
        // refresh session remains securely scoped to that username on this
        // device so offline work can resume after reconnecting.
        sessionStorage.clear();
        clearCart();
        showLogin();
        document.dispatchEvent(new CustomEvent("user-role-changed"));
    });

    const savedLogin = sessionStorage.getItem("merchTillLoggedIn");
    const savedUsername = sessionStorage.getItem("merchTillUsername");

    if (savedLogin === "true" && savedUsername) {
        dom.loginScreen.hidden = true;
        dom.appScreen.hidden = false;
        dom.loggedInUser.textContent = savedUsername;
    } else {
        showLogin();
    }
}
